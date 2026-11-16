import crypto from 'node:crypto';

// Razorpay talks in paise, the same unit orders already use, so amounts pass
// through without conversion.
const API = 'https://api.razorpay.com/v1';

function authHeader() {
  const id = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!id || !secret) return null;
  return 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64');
}

export function razorpayConfigured() {
  return Boolean(authHeader());
}

// Creates an order for a checkout. Razorpay returns the id the browser then
// hands to its checkout widget.
export async function createRazorpayOrder({ amountCents, receipt, notes }) {
  const header = authHeader();
  if (!header) throw new Error('Razorpay is not configured');

  const res = await fetch(`${API}/orders`, {
    method: 'POST',
    headers: { Authorization: header, 'Content-Type': 'application/json' },
    body: JSON.stringify({ amount: amountCents, currency: 'INR', receipt, notes }),
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Razorpay order failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

function safeEqualHex(expected, provided) {
  const a = Buffer.from(String(expected), 'hex');
  const b = Buffer.from(String(provided || ''), 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// The browser posts back an order id, payment id and signature. Only a genuine
// pair signed with the key secret passes, which is what stops a customer from
// marking themselves paid by editing the request.
export function verifyCheckoutSignature({ orderId, paymentId, signature }) {
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!secret || !orderId || !paymentId || !signature) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return safeEqualHex(expected, signature);
}

// Looks a payment up at Razorpay. The webhook body is not trusted: it only
// tells us which payment to ask about, and this is what actually says whether
// the money arrived. That is why no shared webhook secret is needed — a forged
// body cannot invent a captured payment.
export async function fetchPayment(paymentId) {
  const header = authHeader();
  if (!header) throw new Error('Razorpay is not configured');
  const res = await fetch(`${API}/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: header },
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

// --- Subscriptions (auto-renewal) -----------------------------------------
// A Razorpay plan describes a recurring charge; a subscription is one shop's
// enrolment in that plan. The plan id is stable across shops, so it is looked up
// by name and created once rather than on every signup.

async function rzpRequest(method, path, body) {
  const header = authHeader();
  if (!header) throw new Error('Razorpay is not configured');
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: header, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Razorpay ${path} failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}

// Finds the monthly plan for this price, creating it on first use. Razorpay
// plans are immutable, so the amount is part of what we look for.
export async function ensureMonthlyPlan({ amountCents, name }) {
  const { items = [] } = await rzpRequest('GET', '/plans?count=100');
  const match = items.find(
    (p) => p.period === 'monthly'
      && p.interval === 1
      && p.item?.amount === amountCents
      && p.item?.currency === 'INR',
  );
  if (match) return match.id;
  const created = await rzpRequest('POST', '/plans', {
    period: 'monthly',
    interval: 1,
    item: { name, amount: amountCents, currency: 'INR', description: `${name} — auto-renew` },
  });
  return created.id;
}

// total_count is required; 120 months is effectively "until cancelled".
export async function createSubscription({ planId, tenantId, plan, notifyEmail }) {
  return rzpRequest('POST', '/subscriptions', {
    plan_id: planId,
    total_count: 120,
    customer_notify: 1,
    notes: { tenant_id: tenantId, plan },
    ...(notifyEmail ? { notify_info: { email: notifyEmail } } : {}),
  });
}

export async function fetchSubscription(subscriptionId) {
  const header = authHeader();
  if (!header) throw new Error('Razorpay is not configured');
  const res = await fetch(`${API}/subscriptions/${encodeURIComponent(subscriptionId)}`, {
    headers: { Authorization: header },
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}
