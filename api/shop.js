import { query } from '../lib/db.js';
import { requireSession, assertTenantWritable } from '../lib/auth.js';
import { draftReply, availableProviders } from '../lib/ai.js';
import { handler, readJson, json, requireMethod, HttpError } from '../lib/http.js';

// The shop profile the AI speaks in: address, hours, delivery promise and the
// voice to write in. These are what make a reply sound like the shop owner
// rather than a bot.
const FIELDS = [
  'shop_address',
  'shop_hours',
  'shop_delivery',
  'shop_tone',
  'shop_instructions',
];

const SELECT = `business_name, owner_phone, ${FIELDS.join(', ')}`;

async function getSettings(res, session) {
  const { rows } = await query(`SELECT ${SELECT} FROM tenants WHERE id = $1`, [session.tenant_id]);
  json(res, 200, { settings: rows[0] });
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
  json(res, 200, { settings: rows[0] });
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

  const drafted = await draftReply({
    tenant: tenantResult.rows[0],
    products: productsResult.rows,
    messageText: text,
    items: [],
    history: [],
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
  const session = await requireSession(req);

  if (req.url?.includes('preview')) {
    if (!requireMethod(req, res, ['POST'])) return;
    await previewReply(req, res, session);
    return;
  }

  if (req.method === 'GET') {
    await getSettings(res, session);
    return;
  }
  if (!requireMethod(req, res, ['POST'])) return;
  await saveSettings(req, res, session);
});
