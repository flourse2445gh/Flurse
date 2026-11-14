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
  process.env.TRIAL_DAYS = '3';
  process.env.OPENAI_API_KEY = ''; // exercise the deterministic parser

  const db = await import('../lib/db.js');
  pool = db.getPool();
  query = db.query;

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
    headers: { Authorization: 'Bearer test-cron-secret' },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.tenants.total, 2);
  assert.equal(body.tenants.active, 1);
  assert.equal(body.tenants.trialing, 1);
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
