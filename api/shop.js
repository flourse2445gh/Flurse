import { query } from '../lib/db.js';
import { requireSession, assertTenantWritable } from '../lib/auth.js';
import { draftReply, availableProviders, parseOrder, detectLanguage, matchCatalogItems } from '../lib/ai.js';
import { freeReply, freeIntent, looksLikeOrder } from '../lib/replies.js';
import { handler, readJson, json, error, requireMethod, HttpError } from '../lib/http.js';
import { publicBaseUrl } from '../lib/whatsapp.js';
import crypto from 'node:crypto';

// A payment QR is a small picture. 600 KB of base64 is far more than a UPI QR
// needs and keeps a stray upload from bloating the tenant row.
const QR_MAX_CHARS = 600_000;
const QR_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

// The shop profile the AI speaks in: address, hours, delivery promise and the
// voice to write in. These are what make a reply sound like the shop owner
// rather than a bot.
const FIELDS = [
  'shop_address',
  'shop_hours',
  'shop_delivery',
  'shop_tone',
  'shop_instructions',
  'shop_upi_id',
  'shop_payment_name',
];

const SELECT = `business_name, owner_phone, shop_payment_qr_token, ${FIELDS.join(', ')}`;

// The QR is stored as a data URL, but the dashboard only needs the public link
// WhatsApp will fetch. Never ship the whole base64 blob to the browser.
function withQrUrl(settings) {
  if (!settings) return settings;
  const { shop_payment_qr_token: token, ...rest } = settings;
  const base = publicBaseUrl();
  return {
    ...rest,
    paymentQr: token && base ? `${base}/api/shop?qr=${token}` : null,
  };
}

async function getSettings(res, session) {
  const { rows } = await query(`SELECT ${SELECT} FROM tenants WHERE id = $1`, [session.tenant_id]);
  json(res, 200, { settings: withQrUrl(rows[0]) });
}

async function saveSettings(req, res, session) {
  assertTenantWritable({ status: session.status });

  const body = await readJson(req);
  const updates = {};
  for (const field of FIELDS) {
    if (!(field in body)) continue;
    const value = body[field] == null ? '' : String(body[field]).trim();
    updates[field] = value === '' ? null : value.slice(0, 1000);
  }
  if (!Object.keys(updates).length) throw new HttpError(400, 'Nothing to update');

  // Column names come from the FIELDS whitelist, never from the request.
  const columns = Object.keys(updates);
  const assignments = columns.map((c, i) => `${c} = $${i + 2}`).join(', ');
  const { rows } = await query(
    `UPDATE tenants SET ${assignments} WHERE id = $1 RETURNING ${SELECT}`,
    [session.tenant_id, ...columns.map((c) => updates[c])],
  );
  json(res, 200, { settings: withQrUrl(rows[0]) });
}

// GET /api/shop?qr=<token> -> the shop's payment QR as an image.
//
// Public on purpose: a payment QR is meant to be shown to customers, and
// WhatsApp fetches the picture from here to deliver it. The token keeps it
// unguessable. Served from this function rather than its own file because the
// Hobby plan allows only twelve serverless functions.
async function serveQr(res, token) {
  const { rows } = await query(
    'SELECT shop_payment_qr FROM tenants WHERE shop_payment_qr_token = $1',
    [token],
  );
  const match = rows[0]?.shop_payment_qr?.match(/^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/);
  if (!match) {
    error(res, 404, 'No payment QR for this shop');
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', match[1]);
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.end(Buffer.from(match[2], 'base64'));
}

// The shop owner uploads their own payment QR (a screenshot from their UPI
// app). Stored as a data URL, served publicly under an unguessable token so
// WhatsApp can fetch it when the AI sends it to a customer.
async function saveQr(req, res, session) {
  assertTenantWritable({ status: session.status });
  const { image } = await readJson(req);
  const dataUrl = String(image ?? '').trim();

  if (!dataUrl) {
    const { rows } = await query(
      `UPDATE tenants SET shop_payment_qr = NULL, shop_payment_qr_token = NULL
        WHERE id = $1 RETURNING ${SELECT}`,
      [session.tenant_id],
    );
    json(res, 200, { settings: withQrUrl(rows[0]) });
    return;
  }

  const match = dataUrl.match(/^data:(image\/[a-z+.-]+);base64,/i);
  if (!match || !QR_TYPES.includes(match[1].toLowerCase())) {
    throw new HttpError(400, 'Upload a PNG, JPEG or WebP image');
  }
  if (dataUrl.length > QR_MAX_CHARS) {
    throw new HttpError(400, 'That image is too large — keep the QR under 400 KB');
  }

  const token = crypto.randomBytes(16).toString('hex');
  const { rows } = await query(
    `UPDATE tenants SET shop_payment_qr = $2, shop_payment_qr_token = $3
      WHERE id = $1 RETURNING ${SELECT}`,
    [session.tenant_id, dataUrl, token],
  );
  json(res, 200, { settings: withQrUrl(rows[0]) });
}

// Runs the exact reply path the webhook uses, so a shop owner can see how the
// AI would answer and confirm the configured providers are reachable.
async function previewReply(req, res, session) {
  const { message } = await readJson(req);
  const text = String(message ?? '').trim();
  if (!text) throw new HttpError(400, 'message is required');
  if (text.length > 500) throw new HttpError(400, 'message must be 500 characters or fewer');

  const [tenantResult, productsResult] = await Promise.all([
    query(`SELECT ${SELECT} FROM tenants WHERE id = $1`, [session.tenant_id]),
    query(
      `SELECT id, name, price_cents, active
         FROM products WHERE tenant_id = $1 ORDER BY name`,
      [session.tenant_id],
    ),
  ]);

  // A clear question that is not also an order is answered from the shop's own
  // catalog and profile, with no model call at all — exactly as the webhook
  // does — so an owner asking "kitna?" in the preview sees the free reply and
  // that it cost nothing.
  const orderable = productsResult.rows.filter((p) => p.active !== false);
  const freeOnly = Boolean(freeIntent(text)) && !looksLikeOrder(text);
  const parsed = freeOnly
    ? { items: [], details: {}, source: 'free' }
    : await parseOrder(text, orderable);
  const totalCents = parsed.items.reduce((sum, i) => sum + i.unitPriceCents * i.quantity, 0);

  const free = freeReply({
    tenant: tenantResult.rows[0],
    products: orderable,
    messageText: text,
    items: parsed.items.length ? parsed.items : matchCatalogItems(text, orderable),
    openOrder: null,
  });
  if (free) {
    json(res, 200, {
      reply: free,
      language: detectLanguage(text),
      source: 'free',
      providers: availableProviders().map((p) => p.name),
      errors: [],
    });
    return;
  }

  const drafted = await draftReply({
    tenant: tenantResult.rows[0],
    products: productsResult.rows,
    messageText: text,
    items: parsed.items,
    history: [],
    order: parsed.items.length
      ? {
        payment_status: 'unpaid',
        total_cents: totalCents,
        fulfilment: parsed.details.fulfilment,
        delivery_address: parsed.details.address,
        delivery_at: parsed.details.at,
        recipient_name: parsed.details.name,
      }
      : null,
  });

  json(res, 200, {
    reply: drafted.reply,
    language: drafted.language,
    source: drafted.source,
    providers: availableProviders().map((p) => p.name),
    errors: drafted.errors ?? [],
  });
}

// GET  /api/shop          -> shop profile settings
// POST /api/shop          -> update settings
// POST /api/shop?preview  -> draft a sample reply
export default handler(async (req, res) => {
  const params = new URL(req.url, 'http://localhost').searchParams;

  // The QR image is public and token-gated, so it is served before any session
  // check — WhatsApp has no cookie.
  if (req.method === 'GET' && params.get('qr')) {
    await serveQr(res, params.get('qr'));
    return;
  }

  const session = await requireSession(req);

  if (req.url?.includes('preview')) {
    if (!requireMethod(req, res, ['POST'])) return;
    await previewReply(req, res, session);
    return;
  }

  if (req.url?.includes('qr')) {
    if (!requireMethod(req, res, ['POST'])) return;
    await saveQr(req, res, session);
    return;
  }

  if (req.method === 'GET') {
    await getSettings(res, session);
    return;
  }
  if (!requireMethod(req, res, ['POST'])) return;
  await saveSettings(req, res, session);
});
