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

// The webhook is signed with a separate secret, so a leaked checkout signature
// cannot be replayed against it.
export function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;
  const expected = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');
  return safeEqualHex(expected, signatureHeader);
}
