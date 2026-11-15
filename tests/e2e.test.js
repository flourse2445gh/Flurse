import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// End-to-end tests against a real Postgres (budsbox_test) and the real
// handlers in api/. No mocks: the same code paths production runs.

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const TEST_DB = process.env.TEST_DATABASE_URL
  || 'postgres://budsbox:budsbox@localhost:5432/budsbox_test';
const PORT = 3999;
const BASE = `http://localhost:${PORT}`;

let server;
let pool;
let query;
let expireTrials;

// -- helpers ---------------------------------------------------------------

function cookieFrom(res) {
  const raw = res.headers.getSetCookie?.() ?? [];
  const cookie = raw.find((c) => c.startsWith('ob_session='));
  return cookie ? cookie.split(';')[0] : null;
}

async function api(path, { method = 'GET', body, cookie } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, cookie: cookieFrom(res) };
}

function signedWebhook(payload) {
  const raw = JSON.stringify(payload);
  const sig = 'sha256=' + crypto
    .createHmac('sha256', process.env.WHATSAPP_APP_SECRET)
    .update(raw)
    .digest('hex');
  return { raw, sig };
}

function inboundPayload({ phoneNumberId, from, text, id }) {
  return {
    entry: [{ changes: [{ value: {
      metadata: { phone_number_id: phoneNumberId },
      contacts: [{ wa_id: from, profile: { name: 'Test Customer' } }],
      messages: [{ id, from, type: 'text', text: { body: text }, timestamp: '1731000000' }],
    } }] }],
  };
}

// -- lifecycle -------------------------------------------------------------

before(async () => {
  process.env.DATABASE_URL = TEST_DB;
  process.env.WHATSAPP_APP_SECRET = 'test-app-secret';
  process.env.WHATSAPP_VERIFY_TOKEN = 'test-verify-token';
  process.env.CRON_SECRET = 'test-cron-secret';
  process.env.ADMIN_SECRET = 'test-admin-secret';
  process.env.TRIAL_DAYS = '3';
  process.env.OPENAI_API_KEY = ''; // exercise the deterministic parser
  process.env.GEMINI_API_KEY = '';
  process.env.GROQ_API_KEY = '';
  process.env.CEREBRAS_API_KEY = '';
  process.env.OPENROUTER_API_KEY = '';

  const db = await import('../lib/db.js');
  pool = db.getPool();
  query = db.query;
  expireTrials = (await import('../lib/trial.js')).expireTrials;

  // Fresh schema for every run.
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const schema = await readFile(join(root, 'db', 'schema.sql'), 'utf8');
  await pool.query(schema);

  // Serve the real handlers over a throwaway http server.
  const routes = {
    '/api/onboard': '../api/onboard.js',
    '/api/auth': '../api/auth.js',
    '/api/webhook': '../api/webhook.js',
    '/api/dashboard': '../api/dashboard.js',
    '/api/conversations': '../api/conversations.js',
    '/api/products': '../api/products.js',
    '/api/whatsapp': '../api/whatsapp.js',
    '/api/shop': '../api/shop.js',
    
    '/api/admin': '../api/admin.js',
    '/api/payments': '../api/payments.js',
    '/api/health': '../api/health.js',
    '/api/cron/trial': '../api/cron/trial.js',
  };
  const mods = {};
  for (const [path, file] of Object.entries(routes)) {
    mods[path] = (await import(new URL(file, import.meta.url))).default;
  }
  server = createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const handlerFn = mods[pathname];
    if (!handlerFn) { res.statusCode = 404; res.end('nope'); return; }
    handlerFn(req, res);
  });
  await new Promise((r) => server.listen(PORT, r));
});

after(async () => {
  await new Promise((r) => server.close(r));
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  const { closePool } = await import('../lib/db.js');
  await closePool();
});

// -- tests -----------------------------------------------------------------

test('health reports ok and reaches the database', async () => {
  const { status, body } = await api('/api/health');
  assert.equal(status, 200);
  assert.equal(body.status, 'ok');
  assert.equal(body.db, 'ok');
});

test('onboarding creates a tenant on a 3-day trial and logs the owner in', async () => {
  const { status, body, cookie } = await api('/api/onboard', {
    method: 'POST',
    body: {
      business_name: 'Test Cafe',
      email: 'owner@test.cafe',
      password: 'supersecret123',
      wa_phone_number_id: 'PHONE1',
    },
  });
  assert.equal(status, 201);
  assert.equal(body.tenant.status, 'trialing');
  assert.equal(body.tenant.daysLeft, 3);
  assert.ok(cookie, 'expected a session cookie');

  // The trial length is computed in JS just before the insert, so the stored
  // span lands a few milliseconds under 3 days. Compare on the rounded day count.
  const { rows } = await query(
    `SELECT EXTRACT(EPOCH FROM (trial_ends_at - trial_started_at)) / 86400 AS days
       FROM tenants WHERE slug = 'test-cafe'`,
  );
  assert.equal(Math.round(Number(rows[0].days)), 3);
});

test('onboarding rejects a duplicate slug and a weak password', async () => {
  const dup = await api('/api/onboard', {
    method: 'POST',
    body: { business_name: 'Test Cafe', email: 'x@y.z', password: 'supersecret123' },
  });
  assert.equal(dup.status, 409);

  const weak = await api('/api/onboard', {
    method: 'POST',
    body: { business_name: 'Other Cafe', email: 'x@y.z', password: 'short' },
  });
  assert.equal(weak.status, 400);
});

test('login rejects bad credentials without revealing which part failed', async () => {
  const wrongPass = await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'owner@test.cafe', password: 'wrongpassword' },
  });
  const noUser = await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'ghost@nowhere.test', password: 'whatever123' },
  });
  assert.equal(wrongPass.status, 401);
  assert.equal(noUser.status, 401);
  assert.equal(wrongPass.body.error, noUser.body.error);
});

test('dashboard requires a session', async () => {
  const { status } = await api('/api/dashboard');
  assert.equal(status, 401);
});

test('webhook rejects a request with no or a bad signature', async () => {
  const unsigned = await fetch(`${BASE}/api/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entry: [] }),
  });
  assert.equal(unsigned.status, 401);

  const badSig = await fetch(`${BASE}/api/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
    body: JSON.stringify({ entry: [] }),
  });
  assert.equal(badSig.status, 401);
});

test('webhook verification handshake echoes the challenge only for the right token', async () => {
  const ok = await fetch(`${BASE}/api/webhook?hub.mode=subscribe&hub.verify_token=test-verify-token&hub.challenge=ABC`);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), 'ABC');

  const bad = await fetch(`${BASE}/api/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=ABC`);
  assert.equal(bad.status, 403);
});

test('a signed inbound message becomes an order and is idempotent on retry', async () => {
  await query(
    `INSERT INTO products (tenant_id, sku, name, price_cents)
     SELECT id, 'LAT', 'Latte', 450 FROM tenants WHERE slug = 'test-cafe'`,
  );
  await query(
    `INSERT INTO products (tenant_id, sku, name, price_cents)
     SELECT id, 'CRS', 'Croissant', 350 FROM tenants WHERE slug = 'test-cafe'`,
  );

  const payload = inboundPayload({
    phoneNumberId: 'PHONE1',
    from: '15550001111',
    text: 'Can I get 2 lattes and a croissant?',
    id: 'wamid.E2E1',
  });
  const { raw, sig } = signedWebhook(payload);

  const first = await fetch(`${BASE}/api/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig },
    body: raw,
  });
  assert.equal(first.status, 200);

  // Replay the exact same delivery.
  const second = await fetch(`${BASE}/api/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig },
    body: raw,
  });
  assert.equal(second.status, 200);

  const { rows } = await query(
    "SELECT o.total_cents, o.status FROM orders o WHERE o.wa_message_id = 'wamid.E2E1'",
  );
  assert.equal(rows.length, 1, 'duplicate delivery must not create a second order');
  assert.equal(rows[0].total_cents, 2 * 450 + 350);
  assert.equal(rows[0].status, 'pending');

  const items = await query(
    `SELECT name, quantity FROM order_items oi
       JOIN orders o ON o.id = oi.order_id WHERE o.wa_message_id = 'wamid.E2E1'
      ORDER BY name`,
  );
  assert.deepEqual(items.rows, [
    { name: 'Croissant', quantity: 1 },
    { name: 'Latte', quantity: 2 },
  ]);
});

test('the dashboard reflects orders for the owning tenant only', async () => {
  const login = await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'owner@test.cafe', password: 'supersecret123' },
  });
  const cookie = login.cookie;

  const { status, body } = await api('/api/dashboard', { cookie });
  assert.equal(status, 200);
  assert.equal(body.summary.orders, 1);
  assert.equal(body.summary.customers, 1);
  assert.equal(body.orders.length, 1);
});

test('tenants cannot read or mutate each other\'s orders', async () => {
  const other = await api('/api/onboard', {
    method: 'POST',
    body: {
      business_name: 'Rival Cafe',
      email: 'owner@rival.cafe',
      password: 'supersecret456',
      wa_phone_number_id: 'PHONE2',
    },
  });
  assert.equal(other.status, 201);

  const own = await api('/api/dashboard', { cookie: other.cookie });
  assert.equal(own.body.summary.orders, 0, 'new tenant must start with no orders');

  const { rows } = await query("SELECT id FROM orders WHERE wa_message_id = 'wamid.E2E1'");
  const victimOrderId = rows[0].id;

  const attack = await api(`/api/dashboard?order_id=${victimOrderId}`, {
    method: 'POST',
    body: { status: 'fulfilled' },
    cookie: other.cookie,
  });
  assert.equal(attack.status, 404, 'cross-tenant order update must not resolve');

  const { rows: after } = await query(
    "SELECT status FROM orders WHERE wa_message_id = 'wamid.E2E1'",
  );
  assert.equal(after[0].status, 'pending', 'victim order must be unchanged');
});

test('a shop can advance its own order status', async () => {
  const login = await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'owner@test.cafe', password: 'supersecret123' },
  });
  const { rows } = await query("SELECT id FROM orders WHERE wa_message_id = 'wamid.E2E1'");
  const orderId = rows[0].id;

  const ok = await api(`/api/dashboard?order_id=${orderId}`, {
    method: 'POST',
    body: { status: 'confirmed' },
    cookie: login.cookie,
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.order.status, 'confirmed');

  const bad = await api(`/api/dashboard?order_id=${orderId}`, {
    method: 'POST',
    body: { status: 'shipped' },
    cookie: login.cookie,
  });
  assert.equal(bad.status, 400);
});

test('the trial cron suspends expired trials and revokes the access token', async () => {
  // Give the tenant a token, then expire the trial.
  await query(
    "UPDATE tenants SET wa_access_token = 'token-abc', trial_ends_at = now() - interval '1 minute' WHERE slug = 'test-cafe'",
  );

  const noAuth = await api('/api/cron/trial');
  assert.equal(noAuth.status, 401);

  const run = await fetch(`${BASE}/api/cron/trial`, {
    headers: { Authorization: 'Bearer test-cron-secret' },
  });
  assert.equal(run.status, 200);
  const body = await run.json();
  assert.equal(body.suspended, 1);
  assert.deepEqual(body.tenants, ['test-cafe']);

  const { rows } = await query(
    "SELECT status, wa_access_token, wa_phone_number_id, disconnect_reason FROM tenants WHERE slug = 'test-cafe'",
  );
  assert.equal(rows[0].status, 'suspended');
  assert.equal(rows[0].wa_access_token, null, 'access token must be revoked');
  assert.equal(rows[0].wa_phone_number_id, 'PHONE1', 'phone number id is kept for re-upgrade');
  assert.equal(rows[0].disconnect_reason, 'trial_expired');
});

test('a suspended tenant cannot mutate orders, but can still read its dashboard', async () => {
  const login = await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'owner@test.cafe', password: 'supersecret123' },
  });
  const { rows } = await query("SELECT id FROM orders WHERE wa_message_id = 'wamid.E2E1'");

  const write = await api(`/api/dashboard?order_id=${rows[0].id}`, {
    method: 'POST',
    body: { status: 'fulfilled' },
    cookie: login.cookie,
  });
  assert.equal(write.status, 402);

  const read = await api('/api/dashboard', { cookie: login.cookie });
  assert.equal(read.status, 200);
  assert.equal(read.body.tenant.status, 'suspended');
});

test('inbound messages for a suspended tenant create no order', async () => {
  const before = await query('SELECT COUNT(*)::int AS n FROM orders');
  const payload = inboundPayload({
    phoneNumberId: 'PHONE1',
    from: '15550001111',
    text: '3 lattes',
    id: 'wamid.AFTER_SUSPEND',
  });
  const { raw, sig } = signedWebhook(payload);
  const res = await fetch(`${BASE}/api/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig },
    body: raw,
  });
  assert.equal(res.status, 200);

  const after = await query('SELECT COUNT(*)::int AS n FROM orders');
  assert.equal(after.rows[0].n, before.rows[0].n, 'suspended tenant must not accrue orders');
});

test('upgrading reactivates a suspended tenant', async () => {
  const login = await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'owner@test.cafe', password: 'supersecret123' },
  });

  const plans = await api('/api/payments', { cookie: login.cookie });
  assert.equal(plans.status, 200);
  assert.ok(plans.body.plans.some((p) => p.id === 'starter'));

  const upgrade = await api('/api/payments?action=upgrade', {
    method: 'POST',
    body: { plan: 'starter' },
    cookie: login.cookie,
  });
  assert.equal(upgrade.status, 200);
  assert.equal(upgrade.body.tenant.status, 'active');

  const read = await api('/api/dashboard', { cookie: login.cookie });
  assert.equal(read.body.tenant.status, 'active');
});

test('the admin view is secret-gated and reports cross-tenant stats', async () => {
  const denied = await api('/api/admin');
  assert.equal(denied.status, 401);

  const res = await fetch(`${BASE}/api/admin?view=stats`, {
    headers: { Authorization: 'Bearer test-admin-secret' },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tenants.total, 2);
  assert.equal(body.tenants.active, 1);
  assert.equal(body.tenants.trialing, 1);
});

test('a shop manages its catalog in rupees', async () => {
  const login = await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'owner@test.cafe', password: 'supersecret123' },
  });
  const cookie = login.cookie;

  const created = await api('/api/products', {
    method: 'POST',
    body: { name: 'Red Rose Premium', price: 1499, description: '12 red roses' },
    cookie,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.product.price_cents, 149900, 'rupees convert to paise');
  assert.equal(created.body.product.currency, 'INR');

  const listed = await api('/api/products', { cookie });
  assert.ok(listed.body.products.some((p) => p.name === 'Red Rose Premium'));

  const bad = await api('/api/products', { method: 'POST', body: { name: 'X', price: -5 }, cookie });
  assert.equal(bad.status, 400);

  const removed = await api(`/api/products?id=${created.body.product.id}`, { method: 'DELETE', cookie });
  assert.equal(removed.status, 200);
  assert.equal(removed.body.deleted, 1);
});

test('the catalog is tenant-scoped', async () => {
  const a = await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'owner@test.cafe', password: 'supersecret123' },
  });
  const b = await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'owner@rival.cafe', password: 'supersecret456' },
  });
  await api('/api/products', { method: 'POST', body: { name: 'Only Mine', price: 100 }, cookie: a.cookie });
  const other = await api('/api/products', { cookie: b.cookie });
  assert.equal(other.body.products.length, 0, 'a shop must not see another shop catalog');
});

test('a shop connects and disconnects its WhatsApp number', async () => {
  const login = await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'owner@test.cafe', password: 'supersecret123' },
  });
  const cookie = login.cookie;

  const before = await api('/api/whatsapp', { cookie });
  assert.equal(before.body.connected, false, 'no access token yet, so not connected');
  assert.equal(before.body.phoneNumberId, 'PHONE1', 'the onboarding number id is kept');

  const saved = await api('/api/whatsapp', {
    method: 'POST',
    body: { phone_number_id: 'PHONE-CONNECT', access_token: 'token-xyz' },
    cookie,
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.connected, true);
  assert.ok(saved.body.verifyToken, 'a verify token is issued');

  // A second shop cannot claim the same Meta number.
  const rival = await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'owner@rival.cafe', password: 'supersecret456' },
  });
  const clash = await api('/api/whatsapp', {
    method: 'POST',
    body: { phone_number_id: 'PHONE-CONNECT', access_token: 'token-abc' },
    cookie: rival.cookie,
  });
  assert.equal(clash.status, 409);

  const off = await api('/api/whatsapp', { method: 'DELETE', cookie });
  assert.equal(off.status, 200);
  const after = await api('/api/whatsapp', { cookie });
  assert.equal(after.body.connected, false);
});

test('conversations expose threads and record manual replies', async () => {
  const login = await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'owner@test.cafe', password: 'supersecret123' },
  });
  const cookie = login.cookie;

  const { body } = await api('/api/conversations', { cookie });
  const thread = body.conversations.find((c) => c.wa_id === '15550001111');
  assert.ok(thread, 'the inbound customer should have a thread');

  const detail = await api(`/api/conversations?id=${thread.id}`, { cookie });
  assert.equal(detail.body.customer.display_name, 'Test Customer');
  assert.ok(detail.body.messages.length >= 1);
  assert.equal(detail.body.orders.length, 1);

  const reply = await api('/api/conversations', {
    method: 'POST',
    body: { customer_id: thread.id, body: 'Aapka order ready hai!' },
    cookie,
  });
  assert.equal(reply.status, 201);
  assert.equal(reply.body.delivered, false, 'no live token in tests, so not delivered');

  const after = await api(`/api/conversations?id=${thread.id}`, { cookie });
  assert.equal(after.body.messages.at(-1).direction, 'outbound');

  const foreign = await api('/api/conversations?id=00000000-0000-0000-0000-000000000000', { cookie });
  assert.equal(foreign.status, 404);
});

test('the operator can suspend, activate and export shops', async () => {
  const auth = { Authorization: 'Bearer test-admin-secret' };

  const suspend = await fetch(`${BASE}/api/admin?action=suspend`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'rival-cafe' }),
  });
  assert.equal(suspend.status, 200);
  assert.equal((await suspend.json()).tenant.status, 'suspended');

  const activate = await fetch(`${BASE}/api/admin?action=activate`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'rival-cafe' }),
  });
  assert.equal(activate.status, 200);
  assert.equal((await activate.json()).tenant.status, 'active');

  const missing = await fetch(`${BASE}/api/admin?action=suspend`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug: 'ghost-shop' }),
  });
  assert.equal(missing.status, 404);

  const csv = await fetch(`${BASE}/api/admin?view=export`, { headers: auth });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const text = await csv.text();
  assert.match(text.split('\n')[0], /^shop,slug,owner,status/);
  assert.match(text, /test-cafe/);
});

test('logout invalidates the session', async () => {
  const login = await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'owner@test.cafe', password: 'supersecret123' },
  });
  const ok = await api('/api/dashboard', { cookie: login.cookie });
  assert.equal(ok.status, 200);

  const out = await api('/api/auth?action=logout', { method: 'POST', cookie: login.cookie });
  assert.equal(out.status, 200);

  const after = await api('/api/dashboard', { cookie: login.cookie });
  assert.equal(after.status, 401);
});

// -- AI replies ------------------------------------------------------------

// A stand-in provider so the reply path is exercised without the network. It
// answers in OpenAI's shape, or Gemini's when the URL is a Gemini one, and it
// echoes back the language the prompt asked for.
function startFakeProvider() {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const payload = JSON.parse(raw || '{}');
      const isGemini = req.url.includes(':generateContent');
      const messages = isGemini
        ? [{ content: payload.systemInstruction?.parts?.[0]?.text ?? '' },
           ...(payload.contents ?? []).map((c) => ({ content: c.parts?.[0]?.text ?? '' }))]
        : payload.messages ?? [];
      seen.push({ url: req.url, auth: req.headers.authorization, messages });

      const system = messages[0]?.content ?? '';
      const isParse = /Extract a customer order/.test(system);

      // Order extraction returns items plus delivery details; the reply writer
      // returns a message. Keep the two shapes apart.
      const user = messages[1]?.content ?? '';
      // Match items only in the customer's message, never in the catalog JSON,
      // which also contains product names like "Latte".
      const said = user.split('Message: ').pop() ?? user;
      const item = /latte/i.test(said) ? 'Latte' : /croissant/i.test(said) ? 'Croissant' : null;
      // The real catalog carries UUIDs, so echo the id the prompt offered
      // rather than inventing one, exactly like a well-behaved model.
      let catalogId = null;
      const catalog = user.match(/Catalog: (\[.*?\])\n/s);
      if (catalog) {
        try {
          const parsed = JSON.parse(catalog[1]);
          catalogId = parsed.find((p) => p.name === item)?.id ?? null;
        } catch { /* leave null */ }
      }
      const answer = isParse
        ? {
          items: catalogId ? [{ id: catalogId, quantity: /2\s*lattes/i.test(said) ? 2 : 1 }] : [],
          details: {
            fulfilment: /delivery|gandhi road/i.test(said) ? 'delivery' : null,
            address: /gandhi road/i.test(said) ? '12 Gandhi Road' : null,
            at: /6 baje/i.test(said) ? '2026-03-11T12:30:00.000Z' : null,
            note: null,
            name: /rahul/i.test(said) ? 'Rahul' : null,
            phone: /9876543210/.test(said) ? '9876543210' : null,
          },
        }
        : (() => {
          const language = /reply in Hinglish/.test(system) ? 'hinglish'
            : /reply in Hindi in Devanagari/.test(system) ? 'hi' : 'en';
          return {
            reply: language === 'hi' ? 'जी, गुलाब उपलब्ध है।'
              : language === 'hinglish' ? 'Haan bhaiya, gulab available hai'
                : 'Yes, roses are available',
          };
        })();

      res.setHeader('Content-Type', 'application/json');
      res.end(isGemini
        ? JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] })
        : JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    });
  });
  return { server, seen };
}

test('AI replies are drafted by the provider and mirror the customer language', async () => {
  const fake = startFakeProvider();
  await new Promise((r) => fake.server.listen(0, r));
  const fakeUrl = `http://127.0.0.1:${fake.server.address().port}/v1`;

  const saved = { ...process.env };
  process.env.GROQ_BASE_URL = fakeUrl;
  process.env.GROQ_API_KEY = 'test-groq-key';
  try {
    const { draftReply, detectLanguage, availableProviders } = await import('../lib/ai.js');

    assert.deepEqual(
      availableProviders().map((p) => p.name),
      ['groq'],
      'only the configured provider should be offered',
    );

    assert.equal(detectLanguage('Hi, do you have red roses?'), 'en');
    assert.equal(detectLanguage('bhai 10 gulab kitne ka hai?'), 'hinglish');
    assert.equal(detectLanguage('क्या आज डिलीवरी मिलेगी?'), 'hi');

    // The owner's three canonical examples, plus short Hinglish that carries
    // only one giveaway word, which the two-word rule alone would miss.
    assert.equal(detectLanguage('Hi i need rose'), 'en');
    assert.equal(detectLanguage('Hi mujhe rose chahiye'), 'hinglish');
    assert.equal(detectLanguage('Hi मुझे rose चाहिए'), 'hi');
    assert.equal(detectLanguage('rose chahiye'), 'hinglish');
    assert.equal(detectLanguage('aap delivery karte ho?'), 'hinglish');
    assert.equal(detectLanguage('I need a rose bouquet'), 'en');
    assert.equal(detectLanguage('Do you deliver outside Bangalore?'), 'en');

    const tenant = { business_name: 'Test Cafe', shop_tone: 'warm and short' };
    const products = [{ id: 'p1', name: 'Red Rose', price_cents: 5000, active: true }];

    const english = await draftReply({
      tenant, products, messageText: 'Hi, do you have red roses?', items: [], history: [],
    });
    assert.equal(english.source, 'llm:groq');
    assert.match(english.reply, /roses are available/);

    const hinglish = await draftReply({
      tenant, products, messageText: 'bhai gulab hai kya?', items: [], history: [],
    });
    assert.match(hinglish.reply, /Haan bhaiya/);

    const hindi = await draftReply({
      tenant, products, messageText: 'क्या गुलाब है?', items: [], history: [],
    });
    assert.match(hindi.reply, /गुलाब/);

    // The key travelled in the Authorization header, never in the URL.
    assert.equal(fake.seen[0].auth, 'Bearer test-groq-key');
    assert.ok(!fake.seen[0].url.includes('test-groq-key'));
  } finally {
    process.env = saved;
    await new Promise((r) => fake.server.close(r));
  }
});

test('a first hello gets the short greeting, in the customer language', async () => {
  const { draftReply, isGreeting } = await import('../lib/ai.js');

  assert.ok(isGreeting('Hi'), 'a bare hi is a greeting');
  assert.ok(isGreeting('Namaste ji!'), 'a Hindi hello is a greeting');
  assert.ok(!isGreeting('Hi, do you have red roses?'), 'a hi with an item is not a greeting');

  const tenant = { business_name: 'Test Cafe' };
  const products = [{ id: 'p1', name: 'Red Rose', price_cents: 5000, active: true }];

  // A Roman-script hello ("Hi", "hello") is answered in Hinglish, matching how
  // Indian shops actually reply; Devanagari gets Hindi.
  const hinglish = await draftReply({
    tenant, products, messageText: 'Hi', items: [], history: [{ direction: 'inbound', body: 'Hi' }],
  });
  assert.equal(hinglish.source, 'greeting');
  assert.match(hinglish.reply, /Kya chahiye aapko\?/);
  assert.match(hinglish.reply, /😊$/u, 'the greeting ends with the emoji');

  const hindi = await draftReply({
    tenant, products, messageText: 'नमस्ते', items: [], history: [{ direction: 'inbound', body: 'नमस्ते' }],
  });
  assert.equal(hindi.reply, 'Hi! क्या चाहिए आपको? 😊');
  assert.ok(!/नमस्ते/.test(hindi.reply), 'the greeting must never say Namaste');

  // A greeting in the middle of a conversation is answered normally, not reset.
  const later = await draftReply({
    tenant, products, messageText: 'hi', items: [],
    history: [
      { direction: 'inbound', body: 'hi' },
      { direction: 'outbound', body: 'Hi! 😊 What would you like?' },
      { direction: 'inbound', body: 'hi' },
    ],
  });
  assert.notEqual(later.source, 'greeting');
});

test('a greeting is answered without calling any provider', async () => {
  const saved = { ...process.env };
  process.env.GROQ_BASE_URL = 'http://127.0.0.1:1';
  process.env.GROQ_API_KEY = 'unreachable-key';
  try {
    const { draftReply } = await import('../lib/ai.js');
    const out = await draftReply({
      tenant: { business_name: 'Test Cafe' },
      products: [],
      messageText: 'namaste',
      items: [],
      history: [{ direction: 'inbound', body: 'namaste' }],
    });
    assert.equal(out.source, 'greeting');
    assert.deepEqual(out.errors, [], 'no provider should have been tried');
  } finally {
    process.env = saved;
  }
});

test('a mid-sentence emoji is moved to the end of the reply', async () => {
  const { ensureTrailingEmoji } = await import('../lib/ai.js');

  assert.equal(
    ensureTrailingEmoji('Hi! 😊 Kya chahiye aapko?'),
    'Hi! Kya chahiye aapko? 😊',
    'an emoji in the middle is pulled to the very end',
  );
  assert.equal(ensureTrailingEmoji('Total ₹500 🌸'), 'Total ₹500 🌸', 'an emoji already at the end stays');
  assert.equal(ensureTrailingEmoji('Kaunsa phool chahiye?'), 'Kaunsa phool chahiye?', 'no emoji, no change');
  assert.equal(ensureTrailingEmoji('🌸'), '🌸', 'an emoji-only reply is left alone');
});

test('a reply never carries more words than the customer message', async () => {
  const { fitReply, wordBudget } = await import('../lib/ai.js');

  assert.equal(wordBudget('Hi i need rose'), 4);
  assert.equal(wordBudget('rose'), 1);
  assert.equal(wordBudget('🌹'), 1, 'an emoji-only message still allows one word');
  assert.equal(wordBudget(''), 1);

  // The emoji does not count as a word, and it always lands at the end.
  assert.equal(
    fitReply('We have a lovely Red Rose Bouquet for ₹500 🌹', 4),
    'We have a lovely 🌹',
    'a long reply is cut to the customer word count',
  );
  assert.equal(
    fitReply('Haan bhaiya gulab available hai ji 🌹', 3),
    'Haan bhaiya gulab 🌹',
    'the emoji stays at the end after trimming',
  );
  assert.equal(
    fitReply('Yes roses are available 🌹', 3),
    'Yes roses 🌹',
    'a dangling word like "are" is dropped from the cut',
  );
  assert.equal(
    fitReply('Total ₹500 🌸', 5),
    'Total ₹500 🌸',
    'a reply already within budget is untouched',
  );
  assert.equal(
    fitReply('Yes roses are available', 3),
    'Yes roses',
    'a reply with no emoji stays free of one',
  );
  assert.equal(fitReply('Hi 😊', 1), 'Hi 😊', 'a one-word reply survives a one-word budget');
});

test('every reply is trimmed to the customer word count', async () => {
  const fake = startFakeProvider();
  await new Promise((r) => fake.server.listen(0, r));
  const fakeUrl = `http://127.0.0.1:${fake.server.address().port}/v1`;

  const saved = { ...process.env };
  process.env.GROQ_BASE_URL = fakeUrl;
  process.env.GROQ_API_KEY = 'test-groq-key';
  try {
    const { draftReply, wordBudget } = await import('../lib/ai.js');
    const tenant = { business_name: 'Test Cafe', shop_tone: 'warm and short' };
    const products = [{ id: 'p1', name: 'Red Rose', price_cents: 5000, active: true }];

    for (const messageText of ['bhai gulab hai kya?', 'Hi, are you open today?', 'gulab']) {
      const out = await draftReply({
        tenant, products, messageText, items: [], history: [],
      });
      const words = out.reply.replace(/\p{Extended_Pictographic}/gu, '').trim().split(/\s+/);
      assert.ok(
        words.length <= wordBudget(messageText),
        `"${out.reply}" must not exceed ${wordBudget(messageText)} words for "${messageText}"`,
      );
    }

    // The prompt itself must state the limit, or the model never hears it.
    const system = fake.seen[0].messages[0].content;
    assert.match(system, /LENGTH RULE/);
    assert.match(system, /Never use more words than the customer/);
  } finally {
    process.env = saved;
    await new Promise((r) => fake.server.close(r));
  }
});

test('a provider that fails is skipped and the next one answers', async () => {
  const dead = createServer((req, res) => { res.statusCode = 429; res.end('quota'); });
  const good = startFakeProvider();
  await new Promise((r) => dead.listen(0, r));
  await new Promise((r) => good.server.listen(0, r));

  const saved = { ...process.env };
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${dead.address().port}`;
  process.env.GEMINI_API_KEY = 'exhausted-key';
  process.env.GROQ_BASE_URL = `http://127.0.0.1:${good.server.address().port}/v1`;
  process.env.GROQ_API_KEY = 'fresh-key';
  try {
    const { draftReply } = await import('../lib/ai.js');
    const out = await draftReply({
      tenant: { business_name: 'Test Cafe' },
      products: [],
      messageText: 'Hi there, are you open today?',
      items: [],
      history: [],
    });
    assert.equal(out.source, 'llm:groq', 'the healthy provider must take over');
    assert.ok(good.seen.length, 'the healthy provider must have been called');
  } finally {
    process.env = saved;
    await new Promise((r) => dead.close(r));
    await new Promise((r) => good.server.close(r));
  }
});

test('when every provider is down the shop still answers, without inventing items', async () => {
  const saved = { ...process.env };
  process.env.GEMINI_BASE_URL = 'http://127.0.0.1:1';
  process.env.GEMINI_API_KEY = 'dead-key';
  try {
    const { draftReply } = await import('../lib/ai.js');
    const out = await draftReply({
      tenant: { business_name: 'Test Cafe' },
      products: [{ id: 'p1', name: 'Red Rose', price_cents: 5000, active: true }],
      messageText: 'bhai 5 gulab chahiye',
      items: [],
      history: [],
    });
    assert.equal(out.source, 'template');
    assert.equal(out.language, 'hinglish');
    assert.ok(out.reply.length > 0);
  } finally {
    process.env = saved;
  }
});

test('shop profile settings round-trip and are tenant scoped', async () => {
  const login = await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'owner@test.cafe', password: 'supersecret123' },
  });

  const empty = await api('/api/shop', { cookie: login.cookie });
  assert.equal(empty.status, 200);

  const save = await api('/api/shop', {
    method: 'POST',
    cookie: login.cookie,
    body: {
      shop_address: '12 Gandhi Road, Koramangala, Bangalore',
      shop_hours: '8am-9pm daily',
      shop_delivery: 'Free in Koramangala, 3 hours',
      shop_tone: 'warm, short, Hinglish',
      shop_instructions: 'Bulk orders get 10% off',
    },
  });
  assert.equal(save.status, 200);
  assert.equal(save.body.settings.shop_address, '12 Gandhi Road, Koramangala, Bangalore');

  const read = await api('/api/shop', { cookie: login.cookie });
  assert.equal(read.body.settings.shop_delivery, 'Free in Koramangala, 3 hours');

  const anon = await api('/api/shop');
  assert.equal(anon.status, 401);

  const cleared = await api('/api/shop', {
    method: 'POST',
    cookie: login.cookie,
    body: { shop_address: '' },
  });
  assert.equal(cleared.body.settings.shop_address, null, 'blank clears the field');
});

test('the reply preview mirrors the customer language using a live provider', async () => {
  const fake = startFakeProvider();
  await new Promise((r) => fake.server.listen(0, r));

  const login = await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'owner@test.cafe', password: 'supersecret123' },
  });

  const saved = { ...process.env };
  process.env.GROQ_BASE_URL = `http://127.0.0.1:${fake.server.address().port}/v1`;
  process.env.GROQ_API_KEY = 'preview-key';
  try {
    const en = await api('/api/shop?preview', {
      method: 'POST', cookie: login.cookie,
      body: { message: 'Hi, are you open today?' },
    });
    assert.equal(en.status, 200);
    assert.equal(en.body.source, 'llm:groq');
    assert.match(en.body.reply, /roses are available/);
    assert.deepEqual(en.body.providers, ['groq']);

    const hi = await api('/api/shop?preview', {
      method: 'POST', cookie: login.cookie,
      body: { message: 'क्या आज खुला है?' },
    });
    assert.equal(hi.body.language, 'hi');
    assert.match(hi.body.reply, /गुलाब/);
  } finally {
    process.env = saved;
    await new Promise((r) => fake.server.close(r));
  }

  const anon = await api('/api/shop?preview', { method: 'POST', body: { message: 'hi' } });
  assert.equal(anon.status, 401);
});

test('a chat-only message replies without creating an order', async () => {
  // Earlier tests disconnected the shop's number; wire it back so the webhook
  // routes this message to the tenant.
  await query(
    "UPDATE tenants SET wa_phone_number_id = 'PHONE1', status = 'active' WHERE slug = 'test-cafe'",
  );

  const before = await query(
    "SELECT COUNT(*)::int AS n FROM orders o JOIN tenants t ON t.id = o.tenant_id WHERE t.slug = 'test-cafe'",
  );

  const payload = inboundPayload({
    phoneNumberId: 'PHONE1',
    from: '15550002222',
    text: 'Hi, are you open today?',
    id: 'wamid.CHAT1',
  });
  const { raw, sig } = signedWebhook(payload);
  const res = await fetch(`${BASE}/api/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig },
    body: raw,
  });
  assert.equal(res.status, 200);

  const after = await query(
    "SELECT COUNT(*)::int AS n FROM orders o JOIN tenants t ON t.id = o.tenant_id WHERE t.slug = 'test-cafe'",
  );
  assert.equal(after.rows[0].n, before.rows[0].n, 'small talk must not create a ₹0 order');

  const msgs = await query(
    `SELECT direction FROM messages m JOIN tenants t ON t.id = m.tenant_id
      WHERE t.slug = 'test-cafe' AND m.wa_message_id = 'wamid.CHAT1'`,
  );
  assert.equal(msgs.rows.length, 1, 'the customer message is still stored');
});

test('a relative delivery time is resolved to India time without the model', async () => {
  const { guessDeliveryAt } = await import('../lib/ai.js');
  const now = new Date('2026-03-10T06:00:00Z'); // 11:30 IST

  assert.equal(guessDeliveryAt('no time here at all', now), null);
  assert.equal(guessDeliveryAt('kitna price hai', now), null, 'a price is not a time');

  const tonight = guessDeliveryAt('aaj shaam 6 baje bhej do', now);
  const d = new Date(tonight);
  assert.equal(d.getUTCHours(), 12, '6pm IST is 12:30 UTC');
  assert.equal(d.getUTCMinutes(), 30);
  assert.equal(d.getUTCDate(), 10);

  // The day is the Indian one, so compare in IST and not in UTC.
  const istDay = (iso) => new Date(new Date(iso).getTime() + 5.5 * 3600 * 1000).getUTCDate();
  assert.equal(istDay(guessDeliveryAt('kal subah 9 baje', now)), 11, '"kal" is the next day');
  assert.equal(istDay(guessDeliveryAt('parso 5 baje', now)), 12, '"parso" is two days out');
});

test('delivery details from the thread land on the order', async () => {
  await query(
    "UPDATE tenants SET wa_phone_number_id = 'PHONE1', status = 'active' WHERE slug = 'test-cafe'",
  );
  await query("DELETE FROM orders WHERE wa_message_id IN ('wamid.D1', 'wamid.D2', 'wamid.D3')");

  async function inbound(text, id) {
    const payload = inboundPayload({ phoneNumberId: 'PHONE1', from: '15550003333', text, id });
    const { raw, sig } = signedWebhook(payload);
    const res = await fetch(`${BASE}/api/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig },
      body: raw,
    });
    assert.equal(res.status, 200);
  }

  // A provider is configured, so parseOrder asks it for details too.
  const fake = startFakeProvider();
  await new Promise((r) => fake.server.listen(0, r));
  const saved = { ...process.env };
  process.env.GROQ_BASE_URL = `http://127.0.0.1:${fake.server.address().port}/v1`;
  process.env.GROQ_API_KEY = 'details-key';
  try {
    await inbound('2 lattes chahiye, kal shaam 6 baje, 12 Gandhi Road, naam Rahul', 'wamid.D1');

    const { rows } = await query(
      "SELECT * FROM orders WHERE wa_message_id = 'wamid.D1'",
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].fulfilment, 'delivery', 'the model fills fulfilment');
    assert.equal(rows[0].delivery_address, '12 Gandhi Road');
    assert.equal(rows[0].recipient_name, 'Rahul');
    assert.ok(rows[0].delivery_at, 'the delivery time is set');
    const when = new Date(rows[0].delivery_at);
    assert.equal(when.getUTCHours(), 12, '6pm IST');
    assert.equal(when.getUTCMinutes(), 30);

    // A later message that adds only the phone number must not need a new
    // order; it lands on the one already open.
    await inbound('phone 9876543210', 'wamid.D2');
    const after = await query(
      "SELECT recipient_phone FROM orders WHERE wa_message_id = 'wamid.D1'",
    );
    assert.equal(after.rows[0].recipient_phone, '9876543210', 'details merge onto the open order');

    const extra = await query(
      "SELECT COUNT(*)::int AS n FROM orders WHERE wa_message_id = 'wamid.D2'",
    );
    assert.equal(extra.rows[0].n, 0, 'a detail-only message creates no new order');
  } finally {
    process.env = saved;
    await new Promise((r) => fake.server.close(r));
  }

  const listed = await api('/api/dashboard', { cookie: (await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'owner@test.cafe', password: 'supersecret123' },
  })).cookie });
  assert.equal(listed.status, 200);
  const order = listed.body.orders.find((o) => o.delivery_address === '12 Gandhi Road');
  assert.ok(order, 'the dashboard exposes the delivery details');
  assert.equal(order.fulfilment, 'delivery');
  assert.equal(order.recipient_name, 'Rahul');
});

test('money comes before flowers: an order must be paid before it is fulfilled', async () => {
  const login = await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'owner@test.cafe', password: 'supersecret123' },
  });
  assert.ok(login.cookie);

  await query(
    `INSERT INTO products (tenant_id, sku, name, price_cents)
     SELECT id, 'ROS', 'Rose', 500 FROM tenants WHERE slug = 'test-cafe'
     ON CONFLICT (tenant_id, sku) DO NOTHING`,
  );

  const payload = inboundPayload({
    phoneNumberId: 'PHONE1', from: '15550004444', text: '1 rose', id: 'wamid.PAY1',
  });
  const { raw, sig } = signedWebhook(payload);
  await fetch(`${BASE}/api/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig },
    body: raw,
  });

  const { rows } = await query(
    "SELECT id, total_cents, payment_status FROM orders WHERE wa_message_id = 'wamid.PAY1'",
  );
  assert.equal(rows.length, 1);
  const orderId = rows[0].id;
  assert.equal(rows[0].payment_status, 'unpaid', 'a new order starts unpaid');

  // Fulfilling an unpaid order is refused, not silently allowed.
  const blocked = await api(`/api/dashboard?order_id=${orderId}`, {
    method: 'POST', cookie: login.cookie, body: { status: 'fulfilled' },
  });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /paid/i);

  // Confirm first (allowed), still unpaid.
  const confirm = await api(`/api/dashboard?order_id=${orderId}`, {
    method: 'POST', cookie: login.cookie, body: { status: 'confirmed' },
  });
  assert.equal(confirm.status, 200);

  // Bad payment status is rejected.
  const bad = await api(`/api/dashboard?order_id=${orderId}&payment=1`, {
    method: 'POST', cookie: login.cookie, body: { payment_status: 'maybe' },
  });
  assert.equal(bad.status, 400);

  // Mark paid, then fulfilment goes through.
  const paid = await api(`/api/dashboard?order_id=${orderId}&payment=1`, {
    method: 'POST', cookie: login.cookie, body: { payment_status: 'paid', method: 'upi' },
  });
  assert.equal(paid.status, 200);
  assert.equal(paid.body.order.payment_status, 'paid');
  assert.equal(paid.body.order.payment_method, 'upi');
  assert.ok(paid.body.order.paid_at);

  const fulfil = await api(`/api/dashboard?order_id=${orderId}`, {
    method: 'POST', cookie: login.cookie, body: { status: 'fulfilled' },
  });
  assert.equal(fulfil.status, 200);
  assert.equal(fulfil.body.order.status, 'fulfilled');

  // Another tenant cannot touch this order's payment.
  const other = await api('/api/onboard', {
    method: 'POST',
    body: {
      business_name: 'Other Shop', slug: 'other-shop-pay',
      email: 'owner@other-pay.test', password: 'supersecret123', phone: '9000000000',
    },
  });
  assert.equal(other.status, 201);
  const cross = await api(`/api/dashboard?order_id=${orderId}&payment=1`, {
    method: 'POST', cookie: other.cookie, body: { payment_status: 'refunded' },
  });
  assert.equal(cross.status, 404, 'payment updates are tenant scoped');
});

test('the AI asks for payment once the order details are known', async () => {
  await query(
    "UPDATE tenants SET shop_upi_id = 'koramangala@okhdfcbank' WHERE slug = 'test-cafe'",
  );
  const fake = startFakeProvider();
  await new Promise((r) => fake.server.listen(0, r));
  const saved = { ...process.env };
  process.env.GROQ_BASE_URL = `http://127.0.0.1:${fake.server.address().port}/v1`;
  process.env.GROQ_API_KEY = 'pay-key';
  try {
    const login = await api('/api/auth?action=login', {
      method: 'POST',
      body: { email: 'owner@test.cafe', password: 'supersecret123' },
    });
    const preview = await api('/api/shop?preview', {
      method: 'POST', cookie: login.cookie,
      body: { message: '2 lattes chahiye' },
    });
    assert.equal(preview.status, 200);

    // The prompt carries the shop's UPI id so the reply can share it, and it
    // never asks the customer for card details.
    const system = fake.seen.map((s) => s.messages[0].content).join('\n');
    assert.match(system, /koramangala@okhdfcbank/);
    assert.match(system, /never ask for card numbers, CVV, OTPs/);
  } finally {
    process.env = saved;
    await new Promise((r) => fake.server.close(r));
  }
});

// -- payment QR ------------------------------------------------------------

const QR_PNG = 'data:image/png;base64,' + 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC';

test('a shop can upload a payment QR and it is served publicly under a token', async () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const login = await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'owner@test.cafe', password: 'supersecret123' },
  });

  // Not an image is refused.
  const bad = await api('/api/shop?qr', {
    method: 'POST', cookie: login.cookie, body: { image: 'data:text/plain;base64,aGk=' },
  });
  assert.equal(bad.status, 400);

  const saved = await api('/api/shop?qr', {
    method: 'POST', cookie: login.cookie, body: { image: QR_PNG },
  });
  assert.equal(saved.status, 200);
  assert.match(saved.body.settings.paymentQr, /^http:\/\/[^/]+\/api\/shop\?qr=[0-9a-f]{32}$/);
  // The base64 blob must not be shipped to the browser.
  assert.equal(saved.body.settings.shop_payment_qr, undefined);

  const url = saved.body.settings.paymentQr;
  const img = await fetch(url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  const bytes = Buffer.from(await img.arrayBuffer());
  assert.equal(bytes.toString('base64'), QR_PNG.split(',')[1], 'the exact uploaded bytes come back');

  // A wrong token reveals nothing.
  const wrong = await fetch(`${BASE}/api/shop?qr=deadbeef`);
  assert.equal(wrong.status, 404);

  // Clearing removes it.
  const cleared = await api('/api/shop?qr', {
    method: 'POST', cookie: login.cookie, body: { image: '' },
  });
  assert.equal(cleared.body.settings.paymentQr, null);
  const gone = await fetch(url);
  assert.equal(gone.status, 404);
});

test('asking how to pay sends the shop QR and never spends an AI call', async () => {
  process.env.PUBLIC_BASE_URL = BASE;
  const login = await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'owner@test.cafe', password: 'supersecret123' },
  });
  await api('/api/shop?qr', { method: 'POST', cookie: login.cookie, body: { image: QR_PNG } });
  await api('/api/shop', {
    method: 'POST', cookie: login.cookie,
    body: { shop_payment_name: 'Koramangala Flowers' },
  });
  await query(
    "UPDATE tenants SET wa_phone_number_id = 'PHONE1', wa_access_token = 'token-abc', status = 'active' WHERE slug = 'test-cafe'",
  );

  // An AI provider that would answer if it were ever called.
  const fake = startFakeProvider();
  await new Promise((r) => fake.server.listen(0, r));
  const saved = { ...process.env };
  process.env.GROQ_BASE_URL = `http://127.0.0.1:${fake.server.address().port}/v1`;
  process.env.GROQ_API_KEY = 'qr-key';

  // Capture what the shop sends over WhatsApp without hitting the network.
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('graph.facebook.com')) {
      sent.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.SENT' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, opts);
  };

  try {
    const payload = inboundPayload({
      phoneNumberId: 'PHONE1', from: '15550009999', text: 'payment kaise karu?', id: 'wamid.QR1',
    });
    const { raw, sig } = signedWebhook(payload);
    await fetch(`${BASE}/api/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig },
      body: raw,
    });

    assert.equal(sent.length, 1, 'one WhatsApp message is sent');
    assert.equal(sent[0].type, 'image', 'and it is the QR image');
    assert.match(sent[0].image.link, /\/api\/shop\?qr=[0-9a-f]{32}$/);
    assert.match(sent[0].image.caption, /scan/i);

    assert.equal(fake.seen.length, 0, 'no AI provider was called for a payment question');
    assert.match(sent[0].image.caption, /Naam "Koramangala Flowers" dikhna chahiye/, 'the payee name travels with the QR');

    // The question and the answer are both on the thread.
    const { rows } = await query(
      "SELECT direction, body FROM messages WHERE body IN ('payment kaise karu?') OR direction = 'outbound' ORDER BY created_at DESC LIMIT 2",
    );
    assert.ok(rows.some((r) => r.direction === 'inbound'), 'the question is stored');
    assert.ok(rows.some((r) => r.direction === 'outbound'), 'the answer is stored');
  } finally {
    globalThis.fetch = realFetch;
    process.env = saved;
    await new Promise((r) => fake.server.close(r));
  }
});

// -- razorpay --------------------------------------------------------------

test('checkout is refused until Razorpay keys exist, then creates an order', async () => {
  const login = await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'owner@test.cafe', password: 'supersecret123' },
  });

  const before = await api('/api/payments?action=checkout', {
    method: 'POST', cookie: login.cookie, body: { plan: 'starter' },
  });
  assert.equal(before.status, 503, 'no keys, no checkout');
  assert.equal(before.body.error, 'Payments are not configured yet');

  const saved = { ...process.env };
  process.env.RAZORPAY_KEY_ID = 'rzp_test_e2e';
  process.env.RAZORPAY_KEY_SECRET = 'e2e-secret';
  const realFetch = globalThis.fetch;
  let sentBody = null;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.razorpay.com')) {
      sentBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ id: 'order_E2E1', amount: sentBody.amount }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(url, opts);
  };

  try {
    const checkout = await api('/api/payments?action=checkout', {
      method: 'POST', cookie: login.cookie, body: { plan: 'starter' },
    });
    assert.equal(checkout.status, 200);
    assert.equal(checkout.body.orderId, 'order_E2E1');
    assert.equal(checkout.body.amount, 59900, 'amount is sent in paise');
    assert.equal(sentBody.amount, 59900);
    assert.equal(sentBody.currency, 'INR');
    assert.equal(checkout.body.keyId, 'rzp_test_e2e');

    // A checkout attempt is recorded as unpaid, not as money received.
    const { rows } = await query(
      "SELECT status FROM payments WHERE razorpay_order_id = 'order_E2E1'",
    );
    assert.equal(rows[0].status, 'created');
  } finally {
    globalThis.fetch = realFetch;
    process.env = saved;
  }
});

test('a tampered payment cannot activate a shop, a signed one can', async () => {
  await query(
    "UPDATE tenants SET status = 'suspended', wa_access_token = NULL, paid_until = NULL WHERE slug = 'test-cafe'",
  );
  await query(
    `INSERT INTO payments (tenant_id, plan, amount_cents, razorpay_order_id)
     SELECT id, 'starter', 59900, 'order_E2E2' FROM tenants WHERE slug = 'test-cafe'`,
  );

  const saved = { ...process.env };
  process.env.RAZORPAY_KEY_ID = 'rzp_test_e2e';
  process.env.RAZORPAY_KEY_SECRET = 'e2e-secret';

  try {
    const login = await api('/api/auth?action=login', {
      method: 'POST',
      body: { email: 'owner@test.cafe', password: 'supersecret123' },
    });

    // A forged signature is refused, and the shop stays suspended.
    const forged = await api('/api/payments?action=verify', {
      method: 'POST', cookie: login.cookie,
      body: { razorpay_order_id: 'order_E2E2', razorpay_payment_id: 'pay_X', razorpay_signature: 'deadbeef' },
    });
    assert.equal(forged.status, 400);
    const still = await query("SELECT status FROM tenants WHERE slug = 'test-cafe'");
    assert.equal(still.rows[0].status, 'suspended');

    // The real signature, computed the way Razorpay does, activates the shop.
    const signature = crypto.createHmac('sha256', 'e2e-secret')
      .update('order_E2E2|pay_E2E2').digest('hex');
    const ok = await api('/api/payments?action=verify', {
      method: 'POST', cookie: login.cookie,
      body: { razorpay_order_id: 'order_E2E2', razorpay_payment_id: 'pay_E2E2', razorpay_signature: signature },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.tenant.status, 'active');

    const paid = await query(
      "SELECT status, razorpay_payment_id, paid_at FROM payments WHERE razorpay_order_id = 'order_E2E2'",
    );
    assert.equal(paid.rows[0].status, 'paid');
    assert.equal(paid.rows[0].razorpay_payment_id, 'pay_E2E2');
    assert.ok(paid.rows[0].paid_at, 'paid_at is stamped');

    // Replaying the same callback does not extend the period twice.
    const first = await query("SELECT paid_until FROM tenants WHERE slug = 'test-cafe'");
    const replay = await api('/api/payments?action=verify', {
      method: 'POST', cookie: login.cookie,
      body: { razorpay_order_id: 'order_E2E2', razorpay_payment_id: 'pay_E2E2', razorpay_signature: signature },
    });
    assert.equal(replay.status, 404, 'a settled order cannot be settled again');
    const second = await query("SELECT paid_until FROM tenants WHERE slug = 'test-cafe'");
    assert.equal(
      new Date(second.rows[0].paid_until).getTime(),
      new Date(first.rows[0].paid_until).getTime(),
    );
  } finally {
    process.env = saved;
  }
});

test('the webhook activates a shop only when Razorpay confirms the payment', async () => {
  await query(
    "UPDATE tenants SET status = 'suspended', wa_access_token = NULL, paid_until = NULL WHERE slug = 'test-cafe'",
  );
  await query(
    `INSERT INTO payments (tenant_id, plan, amount_cents, razorpay_order_id)
     SELECT id, 'starter', 59900, 'order_E2E3' FROM tenants WHERE slug = 'test-cafe'`,
  );

  const saved = { ...process.env };
  process.env.RAZORPAY_KEY_ID = 'rzp_test_e2e';
  process.env.RAZORPAY_KEY_SECRET = 'e2e-secret';
  const realFetch = globalThis.fetch;
  const body = JSON.stringify({
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_E2E3', order_id: 'order_E2E3' } } },
  });

  // Razorpay says the payment is captured, for our order and our amount.
  const capture = { status: 'captured', order_id: 'order_E2E3', amount: 59900 };
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('api.razorpay.com/v1/payments/')) {
      // Only the payment we actually recorded exists at Razorpay.
      if (u.includes('pay_FAKE')) {
        return new Response(JSON.stringify({ error: { description: 'not found' } }), {
          status: 404, headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(capture), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(url, opts);
  };

  try {
    // A body that names a payment Razorpay does not know settles nothing.
    const forged = await fetch(`${BASE}/api/payments?action=webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'payment.captured',
        payload: { payment: { entity: { id: 'pay_FAKE', order_id: 'order_E2E3' } } },
      }),
    });
    assert.equal(forged.status, 200, 'the webhook still acks');
    const untouched = await query("SELECT status FROM tenants WHERE slug = 'test-cafe'");
    assert.equal(untouched.rows[0].status, 'suspended', 'an unknown payment changes nothing');

    // A genuine capture, confirmed at Razorpay, activates the shop.
    const good = await fetch(`${BASE}/api/payments?action=webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    assert.equal(good.status, 200);

    const tenant = await query("SELECT status, plan, paid_until FROM tenants WHERE slug = 'test-cafe'");
    assert.equal(tenant.rows[0].status, 'active');
    assert.equal(tenant.rows[0].plan, 'starter');
    assert.ok(tenant.rows[0].paid_until, 'the paid period is set');

    // A payment that is not captured yet is ignored.
    await query("UPDATE tenants SET status = 'suspended' WHERE slug = 'test-cafe'");
    await query("UPDATE payments SET status = 'created', paid_at = NULL WHERE razorpay_order_id = 'order_E2E3'");
    capture.status = 'authorized';
    const pending = await fetch(`${BASE}/api/payments?action=webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    assert.equal(pending.status, 200);
    const still = await query("SELECT status FROM tenants WHERE slug = 'test-cafe'");
    assert.equal(still.rows[0].status, 'suspended', 'an uncaptured payment activates nothing');

    // A captured payment for a different amount is ignored.
    capture.status = 'captured';
    capture.amount = 100;
    const cheap = await fetch(`${BASE}/api/payments?action=webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    assert.equal(cheap.status, 200);
    const after = await query("SELECT status FROM tenants WHERE slug = 'test-cafe'");
    assert.equal(after.rows[0].status, 'suspended', 'a wrong amount activates nothing');
  } finally {
    globalThis.fetch = realFetch;
    process.env = saved;
  }
});

test('a lapsed paid period is suspended by the cron, a live one is not', async () => {
  await query(
    `UPDATE tenants SET status = 'active', plan = 'starter',
       paid_until = now() + interval '5 days' WHERE slug = 'test-cafe'`,
  );
  const kept = await expireTrials();
  assert.ok(!kept.some((t) => t.slug === 'test-cafe'), 'a live subscription is left alone');

  await query(
    "UPDATE tenants SET paid_until = now() - interval '1 minute' WHERE slug = 'test-cafe'",
  );
  const expired = await expireTrials();
  assert.ok(expired.some((t) => t.slug === 'test-cafe'), 'a lapsed subscription is suspended');
  const after = await query("SELECT status, disconnect_reason FROM tenants WHERE slug = 'test-cafe'");
  assert.equal(after.rows[0].status, 'suspended');
  assert.equal(after.rows[0].disconnect_reason, 'subscription_expired');
});
