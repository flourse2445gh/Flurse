import crypto from 'node:crypto';
import { query } from '../lib/db.js';
import { requireSession } from '../lib/auth.js';
import { handler, readJson, json, requireMethod, HttpError } from '../lib/http.js';
import {
  embeddedSignupConfigured, exchangeSignupCode, subscribeAppToWaba, fetchPhoneNumber,
  deregisterPhoneNumber,
} from '../lib/whatsapp.js';
import { connectionAlert } from '../lib/wahealth.js';

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
              wa_waba_id, wa_display_number, wa_on_biz_app, wa_token_expires_at,
              wa_last_error, wa_last_error_kind, wa_last_error_at
         FROM tenants WHERE id = $1`,
      [session.tenant_id],
    );
    const t = rows[0] ?? {};
    json(res, 200, {
      connected: Boolean(t.wa_phone_number_id && t.wa_access_token),
      phoneNumberId: t.wa_phone_number_id ?? null,
      displayNumber: t.wa_display_number ?? null,
      // true = number still lives in the owner's WhatsApp Business app, so they
      // can leave from there in one tap. null = Meta did not say.
      onBizApp: typeof t.wa_on_biz_app === 'boolean' ? t.wa_on_biz_app : null,
      verifyToken: t.wa_verify_token ?? null,
      hasAccessToken: Boolean(t.wa_access_token),
      tokenExpiresAt: t.wa_token_expires_at ?? null,
      alert: connectionAlert(t),
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
              wa_on_biz_app = NULL,
              wa_token_expires_at = NULL,
              wa_last_error = NULL,
              wa_last_error_kind = NULL,
              wa_last_error_at = NULL,
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

  if (action === 'release') {
    await releaseNumber(req, res, session);
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
              wa_on_biz_app = NULL,
              wa_verify_token = COALESCE(wa_verify_token, $4),
              wa_token_expires_at = NULL,
              wa_last_error = NULL,
              wa_last_error_kind = NULL,
              wa_last_error_at = NULL,
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

// POST /api/whatsapp?action=release
// The owner is leaving and wants their number back. Deregister stops the number
// working with Cloud API, which is the half Meta lets us do; deleting it from
// the portfolio, the half that frees it for the WhatsApp app, is WhatsApp
// Manager only, so the dashboard walks them through that. Credentials are
// cleared either way, so a released number cannot keep receiving here.
async function releaseNumber(req, res, session) {
  const { rows } = await query(
    'SELECT wa_phone_number_id, wa_access_token, wa_on_biz_app FROM tenants WHERE id = $1',
    [session.tenant_id],
  );
  const t = rows[0] ?? {};
  if (!t.wa_phone_number_id || !t.wa_access_token) {
    throw new HttpError(400, 'No WhatsApp number is connected');
  }

  // A coexistence number (still shared with the owner's WhatsApp Business app)
  // cannot be deregistered: Meta refuses the call while the number is in use
  // with both. The owner frees it from their own app instead, so we skip Meta
  // and let the dashboard hand them that one tap. Anything else is deregistered.
  const onBizApp = t.wa_on_biz_app === true;
  let metaReleased = true;
  if (!onBizApp) {
    try {
      await deregisterPhoneNumber({
        phoneNumberId: t.wa_phone_number_id,
        accessToken: t.wa_access_token,
      });
    } catch (err) {
      // A failed deregister (expired token, a Meta hiccup) must not block the
      // owner from leaving: the local side is cleared regardless, and the reply
      // says whether Meta was reached so the instructions can match.
      metaReleased = false;
      console.error('Deregister failed', err.message);
    }
  }

  await query(
    `UPDATE tenants
        SET wa_access_token = NULL,
            wa_phone_number_id = NULL,
            wa_waba_id = NULL,
            wa_display_number = NULL,
            wa_on_biz_app = NULL,
            wa_token_expires_at = NULL,
            wa_last_error = NULL,
            wa_last_error_kind = NULL,
            wa_last_error_at = NULL,
            updated_at = now()
      WHERE id = $1`,
    [session.tenant_id],
  );

  json(res, 200, { connected: false, metaReleased, onBizApp });
}

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
  const { accessToken, expiresAt } = await exchangeSignupCode(code);

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
              wa_on_biz_app = $6,
              wa_verify_token = COALESCE(wa_verify_token, $7),
              wa_token_expires_at = $8,
              wa_last_error = NULL,
              wa_last_error_kind = NULL,
              wa_last_error_at = NULL,
              updated_at = now()
        WHERE id = $1
        RETURNING wa_phone_number_id, wa_display_number, wa_on_biz_app, wa_verify_token`,
      [
        session.tenant_id,
        phoneNumberId,
        accessToken,
        wabaId || null,
        phone?.displayPhoneNumber ?? null,
        phone?.onBizApp ?? null,
        crypto.randomUUID(),
        expiresAt,
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
    onBizApp: rows[0].wa_on_biz_app,
    verifyToken: rows[0].wa_verify_token,
  });
}
