import crypto from 'node:crypto';
import { query } from '../lib/db.js';
import { requireSession } from '../lib/auth.js';
import { handler, readJson, json, requireMethod, HttpError } from '../lib/http.js';

// GET    /api/whatsapp            -> this shop's WhatsApp connection
// POST   /api/whatsapp            -> save Cloud API credentials
// DELETE /api/whatsapp            -> disconnect the number
export default handler(async (req, res) => {
  const session = await requireSession(req);

  if (req.method === 'GET') {
    const { rows } = await query(
      `SELECT wa_phone_number_id, wa_verify_token, wa_access_token
         FROM tenants WHERE id = $1`,
      [session.tenant_id],
    );
    const t = rows[0] ?? {};
    json(res, 200, {
      connected: Boolean(t.wa_phone_number_id && t.wa_access_token),
      phoneNumberId: t.wa_phone_number_id ?? null,
      verifyToken: t.wa_verify_token ?? null,
      hasAccessToken: Boolean(t.wa_access_token),
      apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
      webhookPath: '/api/webhook',
    });
    return;
  }

  if (req.method === 'DELETE') {
    await query(
      `UPDATE tenants
          SET wa_access_token = NULL,
              wa_phone_number_id = NULL,
              updated_at = now()
        WHERE id = $1`,
      [session.tenant_id],
    );
    json(res, 200, { connected: false });
    return;
  }

  if (!requireMethod(req, res, ['POST'])) return;

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
