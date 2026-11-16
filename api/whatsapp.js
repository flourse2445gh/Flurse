import crypto from 'node:crypto';
import { query } from '../lib/db.js';
import { requireSession } from '../lib/auth.js';
import { handler, readJson, json, requireMethod, HttpError } from '../lib/http.js';
import {
  embeddedSignupConfigured, exchangeSignupCode, subscribeAppToWaba, fetchPhoneNumber,
} from '../lib/whatsapp.js';

// GET    /api/whatsapp            -> this shop's WhatsApp connection
// POST   /api/whatsapp            -> save Cloud API credentials by hand
// POST   /api/whatsapp?action=embedded-signup -> finish the Facebook popup
// DELETE /api/whatsapp            -> disconnect the number
export default handler(async (req, res) => {
  const session = await requireSession(req);
  const action = new URL(req.url, 'http://localhost').searchParams.get('action');

  if (req.method === 'GET') {
    const { rows } = await query(
      `SELECT wa_phone_number_id, wa_verify_token, wa_access_token,
              wa_waba_id, wa_display_number
         FROM tenants WHERE id = $1`,
      [session.tenant_id],
    );
    const t = rows[0] ?? {};
    json(res, 200, {
      connected: Boolean(t.wa_phone_number_id && t.wa_access_token),
      phoneNumberId: t.wa_phone_number_id ?? null,
      displayNumber: t.wa_display_number ?? null,
      verifyToken: t.wa_verify_token ?? null,
      hasAccessToken: Boolean(t.wa_access_token),
      apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
      webhookPath: '/api/webhook',
      embeddedSignup: {
        available: embeddedSignupConfigured(),
        appId: process.env.WHATSAPP_APP_ID ?? null,
        configId: process.env.WHATSAPP_ES_CONFIG_ID ?? null,
        apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
      },
      manualConnect: process.env.WHATSAPP_MANUAL_CONNECT === 'true',
    });
    return;
  }

  if (req.method === 'DELETE') {
    await query(
      `UPDATE tenants
          SET wa_access_token = NULL,
              wa_phone_number_id = NULL,
              wa_waba_id = NULL,
              wa_display_number = NULL,
              updated_at = now()
        WHERE id = $1`,
      [session.tenant_id],
    );
    json(res, 200, { connected: false });
    return;
  }

  if (!requireMethod(req, res, ['POST'])) return;

  if (action === 'embedded-signup') {
    await finishEmbeddedSignup(req, res, session);
    return;
  }

  const body = await readJson(req);
  const phoneNumberId = String(body.phone_number_id ?? '').trim();
  const accessToken = String(body.access_token ?? '').trim();
  if (!phoneNumberId) throw new HttpError(400, 'phone_number_id is required');
  if (!accessToken) throw new HttpError(400, 'access_token is required');

  let rows;
  try {
    ({ rows } = await query(
      `UPDATE tenants
          SET wa_phone_number_id = $2,
              wa_access_token = $3,
              wa_verify_token = COALESCE(wa_verify_token, $4),
              updated_at = now()
        WHERE id = $1
        RETURNING wa_phone_number_id, wa_verify_token`,
      [session.tenant_id, phoneNumberId, accessToken, crypto.randomUUID()],
    ));
  } catch (err) {
    // wa_phone_number_id is unique across tenants — two shops cannot claim the
    // same Meta number.
    if (err.code === '23505') {
      throw new HttpError(409, 'That WhatsApp number is already connected to another shop');
    }
    throw err;
  }

  json(res, 200, {
    connected: true,
    phoneNumberId: rows[0].wa_phone_number_id,
    verifyToken: rows[0].wa_verify_token,
  });
});

// The browser already knows which assets the owner picked; it only sends the
// ids and the 30-second code. The access token never leaves this server.
async function finishEmbeddedSignup(req, res, session) {
  if (!embeddedSignupConfigured()) {
    throw new HttpError(503, 'Embedded Signup is not configured yet');
  }

  const body = await readJson(req);
  const code = String(body.code ?? '').trim();
  const phoneNumberId = String(body.phone_number_id ?? '').trim();
  const wabaId = String(body.waba_id ?? '').trim();

  if (!code) throw new HttpError(400, 'code is required');
  if (!phoneNumberId) throw new HttpError(400, 'phone_number_id is required');

  // Exchange first: the code is only valid for 30 seconds.
  const accessToken = await exchangeSignupCode(code);

  if (wabaId) await subscribeAppToWaba({ wabaId, accessToken });

  const phone = await fetchPhoneNumber({ phoneNumberId, accessToken });

  let rows;
  try {
    ({ rows } = await query(
      `UPDATE tenants
          SET wa_phone_number_id = $2,
              wa_access_token = $3,
              wa_waba_id = $4,
              wa_display_number = $5,
              wa_verify_token = COALESCE(wa_verify_token, $6),
              updated_at = now()
        WHERE id = $1
        RETURNING wa_phone_number_id, wa_display_number, wa_verify_token`,
      [
        session.tenant_id,
        phoneNumberId,
        accessToken,
        wabaId || null,
        phone?.displayPhoneNumber ?? null,
        crypto.randomUUID(),
      ],
    ));
  } catch (err) {
    if (err.code === '23505') {
      throw new HttpError(409, 'That WhatsApp number is already connected to another shop');
    }
    throw err;
  }

  json(res, 200, {
    connected: true,
    phoneNumberId: rows[0].wa_phone_number_id,
    displayNumber: rows[0].wa_display_number,
    verifyToken: rows[0].wa_verify_token,
  });
}
