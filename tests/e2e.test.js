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
  process.env.TRIAL_DAYS = '14';
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

test('onboarding creates a tenant on a 14-day trial and logs the owner in', async () => {
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
  assert.equal(body.tenant.daysLeft, 14);
  assert.ok(cookie, 'expected a session cookie');

  // The trial length is computed in JS just before the insert, so the stored
  // span lands a few milliseconds under 14 days. Compare on the rounded day count.
  const { rows } = await query(
    `SELECT EXTRACT(EPOCH FROM (trial_ends_at - trial_started_at)) / 86400 AS days
       FROM tenants WHERE slug = 'test-cafe'`,
  );
  assert.equal(Math.round(Number(rows[0].days)), 14);
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
  // Six plans are sold (three tiers × monthly/yearly) and the landing page
  // advertises exactly these prices. A plan here that the page does not show
  // would be a dead entry again.
  assert.deepEqual(
    plans.body.plans.map((p) => p.id),
    ['starter_monthly', 'growth_monthly', 'pro_monthly',
     'starter_yearly', 'growth_yearly', 'pro_yearly'],
  );
  assert.deepEqual(
    plans.body.plans.map((p) => p.priceCents),
    [99900, 199900, 399900, 999000, 1999000, 3999000],
  );
  const [s, g, pr] = plans.body.plans;
  assert.equal(s.aiReplies, 1500, 'fair use is advertised');
  assert.equal(g.aiReplies, 4000, 'Growth carries a bigger allowance');
  assert.equal(pr.aiReplies, 10000, 'Pro carries the biggest allowance');
  // Yearly is ten months' price, so two months are free on every tier.
  assert.equal(plans.body.plans[3].priceCents, s.priceCents * 10);
  assert.equal(plans.body.plans[4].priceCents, g.priceCents * 10);
  assert.equal(plans.body.plans[5].priceCents, pr.priceCents * 10);
  // Only the monthly plans can be charged again by Razorpay.
  assert.deepEqual(plans.body.plans.filter((p) => p.recurring).map((p) => p.id),
    ['starter_monthly', 'growth_monthly', 'pro_monthly']);

  const upgrade = await api('/api/payments?action=upgrade', {
    method: 'POST',
    body: { plan: 'starter_monthly' },
    cookie: login.cookie,
  });
  assert.equal(upgrade.status, 200);
  assert.equal(upgrade.body.tenant.status, 'active');

  const read = await api('/api/dashboard', { cookie: login.cookie });
  assert.equal(read.body.tenant.status, 'active');
});

test('the landing page savings figures match the plans it sells', async () => {
  // The cards carry a helper-vs-plan saving, computed from the cheapest helper
  // (₹8,000/mahina). The figure is arithmetic, not a claim, so it must move
  // with the prices — a stale number here would be a lie on the page.
  const HELPER = 8000;
  const inr = (n) => `₹${n.toLocaleString('en-IN')}`;
  const html = await readFile(join(root, 'public', 'index.html'), 'utf8');
  const tiers = [
    { mo: 999, yr: 9990 },   // Starter
    { mo: 1999, yr: 19990 }, // Growth
    { mo: 3999, yr: 39990 }, // Pro
  ];
  for (const t of tiers) {
    const moLine = `Sabse sasta helper (₹8,000) se bhi <b>${inr(HELPER - t.mo)}</b>/mahina bachat`;
    const yrLine = `Sabse sasta helper (₹8,000) se bhi <b>${inr(HELPER * 12 - t.yr)}</b>/saal bachat`;
    assert.ok(html.includes(moLine), `monthly saving shown: ${moLine}`);
    assert.ok(html.includes(yrLine), `yearly saving shown: ${yrLine}`);
  }
  // The per-month line on a yearly card is the yearly price spread over the
  // twelve months it covers, e.g. ₹9,990/12 = ₹833.
  for (const t of tiers) {
    assert.ok(html.includes(`Mahine ka sirf <b>${inr(Math.round(t.yr / 12))}</b>`), `per-month for ${inr(t.yr)}`);
  }
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

test('the operator panel is locked when no secret is configured', async () => {
  const saved = process.env.ADMIN_SECRET;
  delete process.env.ADMIN_SECRET;
  try {
    const res = await fetch(`${BASE}/api/admin`);
    assert.equal(res.status, 401, 'an unset secret must not mean open access');
    const stats = await fetch(`${BASE}/api/admin?view=stats`);
    assert.equal(stats.status, 401);
  } finally {
    process.env.ADMIN_SECRET = saved;
  }
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

test('embedded signup exchanges the code and subscribes the account', async () => {
  const login = await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'owner@test.cafe', password: 'supersecret123' },
  });

  // Without an app id the flow is refused, so a half-configured deployment
  // cannot hand the browser a dead button.
  const off = await api('/api/whatsapp?action=embedded-signup', {
    method: 'POST', cookie: login.cookie,
    body: { code: 'C1', phone_number_id: 'PN-ES' },
  });
  assert.equal(off.status, 503);

  const saved = { ...process.env };
  process.env.WHATSAPP_APP_ID = 'app-e2e';
  process.env.WHATSAPP_APP_SECRET = 'secret-e2e';
  process.env.WHATSAPP_ES_CONFIG_ID = 'config-e2e';

  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('graph.facebook.com')) return realFetch(url, opts);
    calls.push({ u, method: opts.method || 'GET', auth: opts.headers?.Authorization });
    const reply = (body) => new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
    if (u.includes('/oauth/access_token')) {
      assert.ok(u.includes('code=C1'), 'the code is exchanged');
      return reply({ access_token: 'EAAG-es-token' });
    }
    if (u.includes('/subscribed_apps')) return reply({ success: true });
    if (u.includes('/PN-ES')) {
      return reply({ display_phone_number: '+91 90000 11111', verified_name: 'Test Cafe' });
    }
    return reply({});
  };

  try {
    const done = await api('/api/whatsapp?action=embedded-signup', {
      method: 'POST', cookie: login.cookie,
      body: { code: 'C1', phone_number_id: 'PN-ES', waba_id: 'WABA-ES' },
    });
    assert.equal(done.status, 200);
    assert.equal(done.body.connected, true);
    assert.equal(done.body.displayNumber, '+91 90000 11111');

    assert.equal(calls.length, 3, 'exchange, subscribe, then look up the number');
    assert.ok(calls[0].u.includes('/oauth/access_token'));
    assert.ok(calls[1].u.includes('/WABA-ES/subscribed_apps'));
    assert.equal(calls[1].method, 'POST');
    assert.ok(calls[2].u.includes('/PN-ES'));

    // The token the code bought is what gets stored, and it never reaches the
    // browser in any response body.
    const status = await api('/api/whatsapp', { cookie: login.cookie });
    assert.equal(status.body.connected, true);
    assert.equal(status.body.displayNumber, '+91 90000 11111');
    assert.equal(status.body.hasAccessToken, true);
    assert.equal(status.body.embeddedSignup.available, true);
    assert.equal(status.body.embeddedSignup.configId, 'config-e2e');
    assert.ok(!JSON.stringify(status.body).includes('EAAG-es-token'));
  } finally {
    globalThis.fetch = realFetch;
    for (const k of ['WHATSAPP_APP_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_ES_CONFIG_ID']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});

test('embedded signup stores when the token expires', async () => {
  const login = await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'owner@test.cafe', password: 'supersecret123' },
  });
  const saved = { ...process.env };
  process.env.WHATSAPP_APP_ID = 'app-e2e';
  process.env.WHATSAPP_APP_SECRET = 'secret-e2e';
  process.env.WHATSAPP_ES_CONFIG_ID = 'config-e2e';

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (!u.includes('graph.facebook.com')) return realFetch(url, opts);
    const reply = (body) => new Response(JSON.stringify(body), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
    if (u.includes('/oauth/access_token')) {
      return reply({ access_token: 'EAAG-expiry', expires_in: 60 * 24 * 60 * 60 });
    }
    if (u.includes('/subscribed_apps')) return reply({ success: true });
    return reply({ display_phone_number: '+91 90000 22222', verified_name: 'Test Cafe' });
  };

  try {
    const done = await api('/api/whatsapp?action=embedded-signup', {
      method: 'POST', cookie: login.cookie,
      body: { code: 'C2', phone_number_id: 'PHONE-EXP', waba_id: 'WABA-EXP' },
    });
    assert.equal(done.status, 200);

    // ~60 days from now, stored on the tenant so the dashboard can warn first.
    const { rows } = await query(
      "SELECT wa_token_expires_at FROM tenants WHERE slug = 'test-cafe'",
    );
    const days = (new Date(rows[0].wa_token_expires_at).getTime() - Date.now()) / 86400000;
    assert.ok(days > 59 && days <= 60, `expiry should be ~60 days out, got ${days}`);

    const status = await api('/api/whatsapp', { cookie: login.cookie });
    assert.ok(status.body.tokenExpiresAt, 'the expiry is reported to the dashboard');
    assert.equal(status.body.alert, null, 'a fresh 60-day token raises no alert');
  } finally {
    globalThis.fetch = realFetch;
    for (const k of ['WHATSAPP_APP_ID', 'WHATSAPP_APP_SECRET', 'WHATSAPP_ES_CONFIG_ID']) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
});

test('a token about to expire is flagged, and a dead token is a hard alert', async () => {
  const login = await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'owner@test.cafe', password: 'supersecret123' },
  });

  // Five days left: warn, but not an error.
  await query(
    "UPDATE tenants SET wa_access_token = 'tok', wa_phone_number_id = 'PHONE1', wa_token_expires_at = now() + interval '5 days' WHERE slug = 'test-cafe'",
  );
  const warn = await api('/api/whatsapp', { cookie: login.cookie });
  assert.equal(warn.body.alert.kind, 'token_expiring');
  assert.equal(warn.body.alert.level, 'warning');

  const dashWarn = await api('/api/dashboard', { cookie: login.cookie });
  assert.equal(dashWarn.body.tenant.waAlert.kind, 'token_expiring', 'the dashboard shows the same warning');

  // Already expired: the shop cannot send, so it is an error.
  await query(
    "UPDATE tenants SET wa_token_expires_at = now() - interval '1 hour' WHERE slug = 'test-cafe'",
  );
  const dead = await api('/api/whatsapp', { cookie: login.cookie });
  assert.equal(dead.body.alert.kind, 'token_expired');
  assert.equal(dead.body.alert.level, 'error');

  // A rejected token (Meta 401) is an error even before the clock runs out.
  await query(
    "UPDATE tenants SET wa_token_expires_at = now() + interval '40 days', wa_last_error_kind = 'token' WHERE slug = 'test-cafe'",
  );
  const rejected = await api('/api/dashboard', { cookie: login.cookie });
  assert.equal(rejected.body.tenant.waAlert.kind, 'token_dead');
  assert.equal(rejected.body.tenant.waAlert.level, 'error');

  // A healthy connection clears the banner entirely.
  await query(
    "UPDATE tenants SET wa_token_expires_at = now() + interval '40 days', wa_last_error_kind = NULL WHERE slug = 'test-cafe'",
  );
  const healthy = await api('/api/whatsapp', { cookie: login.cookie });
  assert.equal(healthy.body.alert, null);
});

test('a failed WhatsApp send is recorded so the shop is told', async () => {
  const login = await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'owner@test.cafe', password: 'supersecret123' },
  });
  await query(
    "UPDATE tenants SET wa_phone_number_id = 'PHONE1', wa_access_token = 'token-abc', status = 'active', wa_last_error_kind = NULL, wa_token_expires_at = now() + interval '40 days' WHERE slug = 'test-cafe'",
  );

  // Meta answers with a rejected token.
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('graph.facebook.com')) {
      return new Response(JSON.stringify({ error: { code: 190, message: 'Invalid OAuth access token' } }),
        { status: 401, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, opts);
  };

  try {
    const payload = inboundPayload({
      phoneNumberId: 'PHONE1', from: '15550002222', text: '2 roses', id: 'wamid.FAIL1',
    });
    const { raw, sig } = signedWebhook(payload);
    await fetch(`${BASE}/api/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig },
      body: raw,
    });

    const { rows } = await query(
      "SELECT wa_last_error_kind, wa_last_error FROM tenants WHERE slug = 'test-cafe'",
    );
    assert.equal(rows[0].wa_last_error_kind, 'token', 'a 401 is classified as a dead token');
    assert.match(rows[0].wa_last_error, /401/);

    // The dashboard now shows the hard alert, without anyone reading the logs.
    const dash = await api('/api/dashboard', { cookie: login.cookie });
    assert.equal(dash.body.tenant.waAlert.kind, 'token_dead');
    assert.equal(dash.body.tenant.waAlert.level, 'error');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a successful send clears the failure flag', async () => {
  const login = await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'owner@test.cafe', password: 'supersecret123' },
  });
  await query(
    "UPDATE tenants SET wa_phone_number_id = 'PHONE1', wa_access_token = 'token-abc', status = 'active', wa_last_error = 'old', wa_last_error_kind = 'token' WHERE slug = 'test-cafe'",
  );

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('graph.facebook.com')) {
      return new Response(JSON.stringify({ messages: [{ id: 'wamid.OK' }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(url, opts);
  };

  try {
    const payload = inboundPayload({
      phoneNumberId: 'PHONE1', from: '15550003333', text: 'hello', id: 'wamid.OK1',
    });
    const { raw, sig } = signedWebhook(payload);
    await fetch(`${BASE}/api/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': sig },
      body: raw,
    });

    const { rows } = await query(
      "SELECT wa_last_error, wa_last_error_kind FROM tenants WHERE slug = 'test-cafe'",
    );
    assert.equal(rows[0].wa_last_error, null, 'a working send clears the recorded failure');
    assert.equal(rows[0].wa_last_error_kind, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the cron reports tokens that are about to expire', async () => {
  await query(
    "UPDATE tenants SET wa_access_token = 'tok', wa_phone_number_id = 'PHONE1', status = 'active', trial_ends_at = now() + interval '10 days', wa_token_expires_at = now() + interval '3 days' WHERE slug = 'test-cafe'",
  );
  const run = await fetch(`${BASE}/api/cron/trial`, {
    headers: { Authorization: 'Bearer test-cron-secret' },
  });
  assert.equal(run.status, 200);
  const body = await run.json();
  assert.ok(body.expiringTokens.includes('test-cafe'), 'the expiring shop is listed');
  assert.equal(body.suspended, 0, 'a healthy shop is not suspended by the token watch');

  await query(
    "UPDATE tenants SET wa_token_expires_at = now() + interval '40 days' WHERE slug = 'test-cafe'",
  );
  const clear = await fetch(`${BASE}/api/cron/trial`, {
    headers: { Authorization: 'Bearer test-cron-secret' },
  });
  const cleared = await clear.json();
  assert.equal(cleared.expiringTokens.includes('test-cafe'), false, 'a distant expiry is not reported');
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
    method: 'POST', cookie: login.cookie, body: { plan: 'starter_monthly' },
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
      method: 'POST', cookie: login.cookie, body: { plan: 'starter_monthly' },
    });
    assert.equal(checkout.status, 200);
    assert.equal(checkout.body.orderId, 'order_E2E1');
    assert.equal(checkout.body.amount, 99900, 'amount is sent in paise');
    assert.equal(sentBody.amount, 99900);
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
     SELECT id, 'starter_monthly', 99900, 'order_E2E2' FROM tenants WHERE slug = 'test-cafe'`,
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
     SELECT id, 'starter_monthly', 99900, 'order_E2E3' FROM tenants WHERE slug = 'test-cafe'`,
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
  const capture = { status: 'captured', order_id: 'order_E2E3', amount: 99900 };
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
    assert.equal(tenant.rows[0].plan, 'starter_monthly');
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
    `UPDATE tenants SET status = 'active', plan = 'starter_monthly',
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

// -- auto-renewal ----------------------------------------------------------

test('subscribe opens a monthly mandate and records it against the shop', async () => {
  const login = await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'owner@test.cafe', password: 'supersecret123' },
  });

  const saved = { ...process.env };
  process.env.RAZORPAY_KEY_ID = 'rzp_test_e2e';
  process.env.RAZORPAY_KEY_SECRET = 'e2e-secret';
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('api.razorpay.com')) {
      calls.push({ method: opts.method ?? 'GET', url: u, body: opts.body ? JSON.parse(opts.body) : null });
      if (u.includes('/plans?') && (opts.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.endsWith('/plans')) {
        return new Response(JSON.stringify({ id: 'plan_E2E' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.endsWith('/subscriptions')) {
        return new Response(JSON.stringify({ id: 'sub_E2E1', status: 'created' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
    }
    return realFetch(url, opts);
  };

  try {
    const res = await api('/api/payments?action=subscribe', {
      method: 'POST', cookie: login.cookie, body: { plan: 'starter_monthly' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.subscriptionId, 'sub_E2E1');
    assert.equal(res.body.amount, 99900, 'the mandate is for the plan price in paise');

    // The plan is created once, monthly, for the right amount.
    const plan = calls.find((c) => c.url.endsWith('/plans'));
    assert.ok(plan, 'a plan was created');
    assert.equal(plan.body.period, 'monthly');
    assert.equal(plan.body.item.amount, 99900);
    assert.equal(plan.body.item.currency, 'INR');

    const sub = calls.find((c) => c.url.endsWith('/subscriptions'));
    assert.equal(sub.body.plan_id, 'plan_E2E');
    assert.equal(sub.body.total_count, 120);

    // The shop and the row both remember the mandate.
    const row = await query(
      "SELECT s.status, t.razorpay_subscription_id FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id WHERE s.razorpay_subscription_id = 'sub_E2E1'",
    );
    assert.equal(row.rows.length, 1);
    assert.equal(row.rows[0].status, 'created');
    assert.equal(row.rows[0].razorpay_subscription_id, 'sub_E2E1');
  } finally {
    globalThis.fetch = realFetch;
    process.env = saved;
  }
});

test('a renewal charge extends the paid period without the operator doing anything', async () => {
  await query(
    "UPDATE tenants SET status = 'active', paid_until = now() + interval '2 days' WHERE slug = 'test-cafe'",
  );
  await query(
    "UPDATE subscriptions SET status = 'active' WHERE razorpay_subscription_id = 'sub_E2E1'",
  );

  const saved = { ...process.env };
  process.env.RAZORPAY_KEY_ID = 'rzp_test_e2e';
  process.env.RAZORPAY_KEY_SECRET = 'e2e-secret';
  const realFetch = globalThis.fetch;
  const end = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('api.razorpay.com/v1/subscriptions/')) {
      return new Response(JSON.stringify({ id: 'sub_E2E1', status: 'active', current_end: end }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(url, opts);
  };

  try {
    const before = await query("SELECT paid_until FROM tenants WHERE slug = 'test-cafe'");
    const res = await fetch(`${BASE}/api/payments?action=webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'subscription.charged',
        payload: { subscription: { entity: { id: 'sub_E2E1' } } },
      }),
    });
    assert.equal(res.status, 200);

    const after = await query("SELECT status, paid_until FROM tenants WHERE slug = 'test-cafe'");
    assert.equal(after.rows[0].status, 'active');
    assert.ok(
      new Date(after.rows[0].paid_until).getTime() > new Date(before.rows[0].paid_until).getTime(),
      'the paid period moved forward',
    );
    assert.equal(
      new Date(after.rows[0].paid_until).getTime(),
      end * 1000,
      'paid_until matches the period Razorpay charged for',
    );

    // An unknown subscription settles nothing.
    const unknown = await fetch(`${BASE}/api/payments?action=webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'subscription.charged',
        payload: { subscription: { entity: { id: 'sub_NOPE' } } },
      }),
    });
    assert.equal(unknown.status, 200);
  } finally {
    globalThis.fetch = realFetch;
    process.env = saved;
  }
});

test('a halted mandate suspends the shop instead of serving it free', async () => {
  await query(
    "UPDATE tenants SET status = 'active', wa_access_token = 'tok' WHERE slug = 'test-cafe'",
  );
  await query(
    "UPDATE subscriptions SET status = 'active' WHERE razorpay_subscription_id = 'sub_E2E1'",
  );

  const saved = { ...process.env };
  process.env.RAZORPAY_KEY_ID = 'rzp_test_e2e';
  process.env.RAZORPAY_KEY_SECRET = 'e2e-secret';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('api.razorpay.com/v1/subscriptions/')) {
      // Razorpay is the one that says the mandate is dead.
      return new Response(JSON.stringify({ id: 'sub_E2E1', status: 'halted' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(url, opts);
  };

  try {
    const res = await fetch(`${BASE}/api/payments?action=webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'subscription.halted',
        payload: { subscription: { entity: { id: 'sub_E2E1' } } },
      }),
    });
    assert.equal(res.status, 200);

    const tenant = await query(
      "SELECT status, wa_access_token, disconnect_reason FROM tenants WHERE slug = 'test-cafe'",
    );
    assert.equal(tenant.rows[0].status, 'suspended');
    assert.equal(tenant.rows[0].wa_access_token, null, 'the number is disconnected');
    assert.equal(tenant.rows[0].disconnect_reason, 'subscription_halted');

    const sub = await query(
      "SELECT status FROM subscriptions WHERE razorpay_subscription_id = 'sub_E2E1'",
    );
    assert.equal(sub.rows[0].status, 'halted');
  } finally {
    globalThis.fetch = realFetch;
    process.env = saved;
  }
});

test('a forged halt body cannot suspend a healthy shop', async () => {
  await query(
    "UPDATE tenants SET status = 'active', wa_access_token = 'tok' WHERE slug = 'test-cafe'",
  );
  await query(
    "UPDATE subscriptions SET status = 'active' WHERE razorpay_subscription_id = 'sub_E2E1'",
  );

  const saved = { ...process.env };
  process.env.RAZORPAY_KEY_ID = 'rzp_test_e2e';
  process.env.RAZORPAY_KEY_SECRET = 'e2e-secret';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('api.razorpay.com/v1/subscriptions/')) {
      // Razorpay still reports the mandate as active, so the body was a lie.
      return new Response(JSON.stringify({ id: 'sub_E2E1', status: 'active' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(url, opts);
  };

  try {
    const res = await fetch(`${BASE}/api/payments?action=webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'subscription.halted',
        payload: { subscription: { entity: { id: 'sub_E2E1' } } },
      }),
    });
    assert.equal(res.status, 200);
    const tenant = await query(
      "SELECT status, wa_access_token FROM tenants WHERE slug = 'test-cafe'",
    );
    assert.equal(tenant.rows[0].status, 'active', 'a healthy shop is left alone');
    assert.equal(tenant.rows[0].wa_access_token, 'tok', 'the number stays connected');
  } finally {
    globalThis.fetch = realFetch;
    process.env = saved;
  }
});

test('the dashboard reports an active mandate so the owner can see auto-pay', async () => {
  await query(
    "UPDATE tenants SET status = 'active', paid_until = now() + interval '20 days' WHERE slug = 'test-cafe'",
  );
  await query(
    "UPDATE subscriptions SET status = 'active', current_end = now() + interval '20 days' WHERE razorpay_subscription_id = 'sub_E2E1'",
  );

  const login = await api('/api/auth?action=login', {
    method: 'POST',
    body: { email: 'owner@test.cafe', password: 'supersecret123' },
  });
  const res = await api('/api/payments', { cookie: login.cookie });
  assert.equal(res.status, 200);
  assert.ok(res.body.current.autoRenew, 'auto-renew is reported');
  assert.equal(res.body.current.autoRenew.subscriptionId, 'sub_E2E1');
});

// -- yearly + fair use -----------------------------------------------------

test('the yearly plan is a one-time payment that buys a year', async () => {
  await query(
    "UPDATE tenants SET status = 'suspended', paid_until = NULL WHERE slug = 'test-cafe'",
  );

  const saved = { ...process.env };
  process.env.RAZORPAY_KEY_ID = 'rzp_test_e2e';
  process.env.RAZORPAY_KEY_SECRET = 'e2e-secret';
  const realFetch = globalThis.fetch;
  let sentBody = null;
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('api.razorpay.com')) {
      sentBody = JSON.parse(opts.body);
      return new Response(JSON.stringify({ id: 'order_YR1', amount: sentBody.amount }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      });
    }
    return realFetch(url, opts);
  };

  try {
    const login = await api('/api/auth?action=login', {
      method: 'POST',
      body: { email: 'owner@test.cafe', password: 'supersecret123' },
    });
    const checkout = await api('/api/payments?action=checkout', {
      method: 'POST', cookie: login.cookie, body: { plan: 'starter_yearly' },
    });
    assert.equal(checkout.status, 200);
    assert.equal(sentBody.amount, 999000, 'the year is charged in paise');

    // Settling it sets the paid period a year out, not a month.
    const signature = crypto.createHmac('sha256', 'e2e-secret')
      .update('order_YR1|pay_YR1').digest('hex');
    const ok = await api('/api/payments?action=verify', {
      method: 'POST', cookie: login.cookie,
      body: { razorpay_order_id: 'order_YR1', razorpay_payment_id: 'pay_YR1', razorpay_signature: signature },
    });
    assert.equal(ok.status, 200);
    const tenant = await query("SELECT status, plan, paid_until FROM tenants WHERE slug = 'test-cafe'");
    assert.equal(tenant.rows[0].status, 'active');
    assert.equal(tenant.rows[0].plan, 'starter_yearly');
    const days = (new Date(tenant.rows[0].paid_until).getTime() - Date.now()) / 86400000;
    assert.ok(days > 360, `a year is paid for (got ${Math.round(days)} days)`);
  } finally {
    globalThis.fetch = realFetch;
    process.env = saved;
  }
});

test('the yearly plan cannot be opened as a monthly subscription', async () => {
  const saved = { ...process.env };
  process.env.RAZORPAY_KEY_ID = 'rzp_test_e2e';
  process.env.RAZORPAY_KEY_SECRET = 'e2e-secret';
  try {
    const login = await api('/api/auth?action=login', {
      method: 'POST',
      body: { email: 'owner@test.cafe', password: 'supersecret123' },
    });
    const res = await api('/api/payments?action=subscribe', {
      method: 'POST', cookie: login.cookie, body: { plan: 'starter_yearly' },
    });
    assert.equal(res.status, 400, 'a yearly plan is not recurring');
  } finally {
    process.env = saved;
  }
});

test('Pro buys a bigger AI allowance than Starter', async () => {
  await query(
    "UPDATE tenants SET status = 'active', plan = 'pro_monthly', paid_until = now() + interval '20 days' WHERE slug = 'test-cafe'",
  );
  const { createOrderFromMessage } = await import('../lib/orders.js');
  const { rows: t } = await query("SELECT * FROM tenants WHERE slug = 'test-cafe'");
  const tenant = t[0];
  const { rows: cust } = await query(
    'SELECT id FROM customers WHERE tenant_id = $1 LIMIT 1', [tenant.id],
  );

  // 2,000 turns is above Starter's 1,500 allowance but well inside Pro's
  // 10,000, so a Pro shop is still allowed a model where a Starter would not be.
  await query('DELETE FROM messages WHERE tenant_id = $1', [tenant.id]);
  await query(
    `INSERT INTO messages (tenant_id, customer_id, direction, body, ai_reply)
     SELECT $1, $2, 'inbound', 'x', true FROM generate_series(1, 2000)`,
    [tenant.id, cust[0].id],
  );

  const fake = startFakeProvider();
  await new Promise((r) => fake.server.listen(0, r));
  const saved = { ...process.env };
  process.env.GEMINI_BASE_URL = `http://127.0.0.1:${fake.server.address().port}`;
  process.env.GEMINI_API_KEY = 'pro-key';
  try {
    const result = await createOrderFromMessage({
      tenant,
      message: { from: '919999900002', displayName: 'Pro Shop', text: '2 red roses chahiye', waMessageId: 'wam_pro_1' },
    });
    assert.ok(result, 'the shop answers');
    assert.ok(fake.seen.length, 'a Pro shop still gets the model after 2,000 replies');

    // The turn is stamped, so it counts against Pro's larger allowance.
    const { rows: usage } = await query(
      "SELECT ai_reply FROM messages WHERE wa_message_id = 'wam_pro_1'",
    );
    assert.equal(usage[0].ai_reply, true, 'a Pro turn inside the allowance is billed as AI');
  } finally {
    process.env = saved;
    await new Promise((r) => fake.server.close(r));
  }
});

test('past the monthly AI allowance the shop still replies, without a model', async () => {
  await query(
    "UPDATE tenants SET status = 'active', plan = 'starter_monthly', paid_until = now() + interval '20 days' WHERE slug = 'test-cafe'",
  );
  const { createOrderFromMessage } = await import('../lib/orders.js');
  const { rows: t } = await query("SELECT * FROM tenants WHERE slug = 'test-cafe'");
  const tenant = t[0];
  const { rows: cust } = await query(
    'SELECT id FROM customers WHERE tenant_id = $1 LIMIT 1', [tenant.id],
  );

  // Spend the whole allowance, then one more message arrives.
  await query('DELETE FROM messages WHERE tenant_id = $1', [tenant.id]);
  await query(
    `INSERT INTO messages (tenant_id, customer_id, direction, body, ai_reply)
     SELECT $1, $2, 'inbound', 'x', true FROM generate_series(1, 2000)`,
    [tenant.id, cust[0].id],
  );

  const result = await createOrderFromMessage({
    tenant,
    message: { from: '919999900000', displayName: 'Over Limit', text: 'Do you have roses?', waMessageId: 'wam_over_1' },
  });
  assert.ok(result, 'the shop still answers');
  assert.ok(!String(result.replySource).startsWith('llm:'), `no model was called (got ${result.replySource})`);
  assert.ok(result.reply.length > 0, 'a reply is still produced');

  // And nothing was stamped as an AI reply for this turn.
  const { rows: stamped } = await query(
    "SELECT ai_reply FROM messages WHERE wa_message_id = 'wam_over_1'",
  );
  assert.equal(stamped[0].ai_reply, false, 'an over-limit turn is not billed as AI');
});

test('a greeting never spends the AI allowance', async () => {
  await query('DELETE FROM messages WHERE tenant_id = (SELECT id FROM tenants WHERE slug = $1)', ['test-cafe']);
  const { createOrderFromMessage } = await import('../lib/orders.js');
  const { rows: t } = await query("SELECT * FROM tenants WHERE slug = 'test-cafe'");
  const result = await createOrderFromMessage({
    tenant: t[0],
    message: { from: '919999900001', displayName: 'Greeter', text: 'Hi', waMessageId: 'wam_hi_1' },
  });
  assert.ok(result);
  assert.equal(result.replySource, 'greeting', 'a hello is answered with no model');
  const { rows } = await query("SELECT ai_reply FROM messages WHERE wa_message_id = 'wam_hi_1'");
  assert.equal(rows[0].ai_reply, false, 'a greeting is free');
});
