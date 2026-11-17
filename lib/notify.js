// Owner alerts. A new order used to be silent: it landed in a dashboard nobody
// had open, so a trial shop saw no reason to keep paying. Email is the only
// channel that reaches a shopkeeper who is away from a screen, so an order that
// matters sends one.
//
// Everything here is best-effort. A mail outage, a missing key or a bad address
// must never fail an order, a webhook or a cron run, so each send reports its
// outcome instead of throwing.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// The From address. Resend's shared onboarding@resend.dev only delivers to the
// account owner until a domain is verified, so production sets EMAIL_FROM once
// a domain is live.
function fromAddress() {
  return process.env.EMAIL_FROM || 'BudsBox <onboarding@resend.dev>';
}

export function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY);
}

// One HTTPS call, no SDK. Returns true only when the provider accepted it.
export async function sendEmail({ to, subject, text, html, replyTo }) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return false;
  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddress(),
        to: [to],
        subject,
        text,
        ...(html ? { html } : {}),
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      console.error('Email send failed', res.status, body?.message || '');
      return false;
    }
    return true;
  } catch (err) {
    console.error('Email send error', err.message);
    return false;
  }
}

function rupees(cents) {
  return `₹${((cents ?? 0) / 100).toFixed(2)}`;
}

function lineForItem(i) {
  return `  • ${i.quantity} × ${i.name} — ${rupees(i.unitPriceCents * i.quantity)}`;
}

// What the florist needs to act, in the order they need it: who, what, where,
// when, and how much to collect.
export function orderSummaryLines({ order, items, customer }) {
  const lines = [];
  if (customer) lines.push(`Customer: ${customer.displayName || customer.waId || 'Unknown'}`);
  lines.push('Items:');
  for (const i of items || []) lines.push(lineForItem(i));
  lines.push(`Total: ${rupees(order.total_cents)}`);
  if (order.fulfilment) lines.push(`Fulfilment: ${order.fulfilment}`);
  if (order.delivery_at) {
    lines.push(`Delivery at: ${new Date(order.delivery_at).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
    })} IST`);
  }
  if (order.delivery_address) lines.push(`Address: ${order.delivery_address}`);
  if (order.recipient_name) lines.push(`Recipient: ${order.recipient_name}`);
  if (order.recipient_phone) lines.push(`Recipient phone: ${order.recipient_phone}`);
  if (order.delivery_note) lines.push(`Card message: ${order.delivery_note}`);
  lines.push(`Payment: ${order.payment_status === 'paid' ? 'paid' : 'not paid yet'}`);
  return lines;
}

// Tells the shop owner a new order arrived. Returns true when an email actually
// went out, so the caller can log a miss without pretending it was sent.
export async function emailNewOrder({ tenant, order, items, customer }) {
  if (!emailConfigured()) return false;
  const lines = orderSummaryLines({ order, items, customer });
  const subject = `Naya order — ${rupees(order.total_cents)} · ${tenant.business_name}`;
  const text = [
    `Aapki shop ${tenant.business_name} par ek naya order aaya hai.`,
    '',
    ...lines,
    '',
    `Poora order dekhne ke liye: ${appUrl()}/app`,
    '',
    'BudsBox',
  ].join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.55">
    <p><b>Aapki shop ${escapeHtml(tenant.business_name)} par ek naya order aaya hai.</b></p>
    <pre style="font-family:ui-monospace,Menlo,monospace;font-size:13px;white-space:pre-wrap">${escapeHtml(lines.join('\n'))}</pre>
    <p><a href="${appUrl()}/app">Dashboard me poora order dekhein</a></p>
    <p style="color:#888;font-size:12px">BudsBox</p>
  </div>`;
  return sendEmail({ to: tenant.owner_email, subject, text, html });
}

// The day-before nudge so the customer is not surprised. Sent only when the
// WhatsApp 24-hour window is open, which the caller checks first.
export async function emailDeliveryReminder({ tenant, order, items, customer }) {
  if (!emailConfigured()) return false;
  const lines = orderSummaryLines({ order, items, customer });
  const subject = `Kal delivery — ${tenant.business_name}`;
  const text = [
    'Kal ye order deliver karna hai:',
    '',
    ...lines,
    '',
    'BudsBox',
  ].join('\n');
  return sendEmail({ to: tenant.owner_email, subject, text });
}

export function appUrl() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return 'https://budsbox.vercel.app';
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
