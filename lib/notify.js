// Owner alerts. A new order used to be silent: it landed in a dashboard nobody
// had open, so a trial shop saw no reason to keep paying. Email is the only
// channel that reaches a shopkeeper who is away from a screen, so an order that
// matters sends one.
//
// Everything here is best-effort. A mail outage, a missing key or a bad address
// must never fail an order, a webhook or a cron run, so each send reports its
// outcome instead of throwing.
//
// Two transports, tried in order:
//   1. Resend, once a domain of ours is verified (EMAIL_FROM on that domain).
//   2. Gmail SMTP, which needs no domain: Google signs the mail with its own
//      SPF/DKIM, so it reaches any recipient and lands in the inbox. This is
//      what carries mail until a domain is set up.

import nodemailer from 'nodemailer';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

// The From address. Resend's shared onboarding@resend.dev only delivers to the
// account owner until a domain is verified, so production sets EMAIL_FROM once
// a domain is live.
function fromAddress() {
  return process.env.EMAIL_FROM || 'BudsBox <onboarding@resend.dev>';
}

export function emailConfigured() {
  return Boolean(process.env.RESEND_API_KEY || gmailUser());
}

// The Gmail account that sends mail, if one is configured.
function gmailUser() {
  return (process.env.GMAIL_USER || '').trim().replace(/^["']|["']$/g, '');
}

// Google shows an App Password grouped in fours ("abcd efgh ijkl mnop"), and a
// pasted value often keeps those spaces or picks up quotes. SMTP wants the bare
// 16 letters, so keep only letters before authenticating.
function gmailPass() {
  return (process.env.GMAIL_APP_PASSWORD || '').replace(/[^a-z]/gi, '');
}

// True only when mail can reach any recipient, not just a provider's own
// account owner. Gmail qualifies because Google signs it; a Resend key alone
// does not, because the shared onboarding@resend.dev sender is refused with a
// 403 for every address but the account owner's.
export function emailReady() {
  if (gmailReady()) return true;
  return resendCanReachAnyone();
}

// A Gmail App Password is exactly 16 letters. Anything else is a mistyped or
// wrong value (often the account password), so treat it as not configured
// rather than letting every send fail with a 535.
function gmailReady() {
  return gmailPass().length === 16;
}

// Gmail over SMTP. Google applies SPF and DKIM for the account's own domain, so
// the message is not marked as coming from a stranger. A fresh transport per
// send keeps the serverless function from holding a socket open between calls.
async function sendViaGmail({ to, subject, text, html, replyTo }) {
  const from = process.env.EMAIL_FROM && !/resend\.dev/i.test(process.env.EMAIL_FROM)
    ? process.env.EMAIL_FROM
    : `BudsBox <${gmailUser()}>`;
  const transport = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: gmailUser(), pass: gmailPass() },
  });
  try {
    const info = await transport.sendMail({
      from,
      to,
      subject,
      text,
      ...(html ? { html } : {}),
      ...(replyTo ? { replyTo } : {}),
    });
    // Gmail returns the ids it assigned; logging them proves the message was
    // accepted (not just handed to a socket) when a recipient reports nothing.
    console.log(`Gmail accepted mail to ${to}: ${info.messageId || ''} ${JSON.stringify(info.accepted || [])}`);
  } catch (err) {
    // Log enough to diagnose a bad credential without printing it: the account
    // and the length of the sanitized app password. A correct one is 16 letters.
    console.error(
      `Gmail send failed (user="${gmailUser()}", appPasswordLetters=${gmailPass().length}):`,
      err.message,
    );
    return false;
  }
  return true;
}

async function sendViaResend({ to, subject, text, html, replyTo }) {
  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
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
}

// True once a Resend key is paired with a From address on a domain we own —
// the only Resend setup that reaches anyone but the account owner.
function resendCanReachAnyone() {
  const from = process.env.EMAIL_FROM || '';
  return Boolean(process.env.RESEND_API_KEY) && from !== '' && !/resend\.dev/i.test(from);
}

// Returns true only when a transport accepted the message. Resend wins once a
// verified domain is configured, so switching to it later needs no code change;
// until then Gmail carries every message.
export async function sendEmail({ to, subject, text, html, replyTo }) {
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return false;
  if (!emailConfigured()) return false;
  const message = { to, subject, text, html, replyTo };
  try {
    if (resendCanReachAnyone()) return await sendViaResend(message);
    if (gmailReady()) return await sendViaGmail(message);
    if (process.env.RESEND_API_KEY) return await sendViaResend(message);
    return false;
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

// The password-reset mail. The link carries the single-use token; nothing else
// in the mail is secret. Returns true only when the provider accepted it, so
// the caller can fall back to logging the link when no key is configured.
export async function emailPasswordReset({ to, businessName, link }) {
  if (!emailConfigured()) return false;
  const subject = 'BudsBox — apna password reset karein';
  const text = [
    `Aapne ${businessName ? `${businessName} ke ` : ''}BudsBox account ka password reset maanga hai.`,
    '',
    'Naya password set karne ke liye ye link kholen (1 ghante tak valid):',
    link,
    '',
    'Agar aapne ye nahi maanga, to is mail ko ignore kar dein — aapka password waisa hi rahega.',
    '',
    'BudsBox',
  ].join('\n');
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.55">
    <p><b>Aapne ${escapeHtml(businessName || 'apne BudsBox account')} ka password reset maanga hai.</b></p>
    <p><a href="${escapeHtml(link)}">Naya password set karein</a> — link 1 ghante tak valid hai.</p>
    <p style="color:#888;font-size:12px">Agar aapne ye nahi maanga, to is mail ko ignore kar dein.</p>
    <p style="color:#888;font-size:12px">BudsBox</p>
  </div>`;
  return sendEmail({ to, subject, text, html });
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
