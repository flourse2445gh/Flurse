import crypto from 'node:crypto';

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v21.0';

// Verifies the X-Hub-Signature-256 header Meta sends with every webhook POST.
// Without this check anyone could POST fake orders to a public webhook URL.
export function verifyWebhookSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret) return false;
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex');
  const provided = signatureHeader.slice('sha256='.length);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Pulls the fields we care about out of a Cloud API webhook payload.
export function parseInboundMessages(payload) {
  const messages = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const phoneNumberId = value.metadata?.phone_number_id;
      const contacts = new Map(
        (value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name]),
      );
      for (const msg of value.messages ?? []) {
        messages.push({
          phoneNumberId,
          waMessageId: msg.id,
          from: msg.from,
          type: msg.type,
          text: msg.text?.body ?? '',
          displayName: contacts.get(msg.from) ?? null,
          timestamp: msg.timestamp,
        });
      }
    }
  }
  return messages;
}

// An owner who onboarded with the WhatsApp Business app (coexistence) can walk
// away from Cloud API themselves, from the app's Settings > Account > Business
// Platform > Disconnect Account. Meta tells us with an `account_update` webhook
// carrying a `PARTNER_REMOVED` event and the Messaging account id. This is the
// "leaving was simple" signal: the number is theirs again the moment they tap
// it, and our job is only to stop believing we still hold the connection.
export function parseAccountUpdates(payload) {
  const updates = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== 'account_update') continue;
      const value = change.value ?? {};
      updates.push({
        event: value.event ?? null,
        wabaId: value.waba_info?.waba_id ?? null,
        // Present on a WhatsApp Business app disconnection; says who ended it.
        initiatedBy: value.disconnection_info?.initiated_by ?? null,
        reason: value.disconnection_info?.reason ?? null,
      });
    }
  }
  return updates;
}

// Public base URL the QR image is served from. Meta fetches the picture from
// here when it delivers an image message, so it has to be reachable.
export function publicBaseUrl() {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return null;
}

// ---------------------------------------------------------------------------
// Embedded Signup
//
// A shop owner clicks "Connect with Facebook" and Meta returns a short-lived
// code plus the ids of the assets they just picked. Everything below is the
// server half of that handshake, and it is inert until WHATSAPP_APP_ID and
// WHATSAPP_ES_CONFIG_ID are set.
// ---------------------------------------------------------------------------

export function embeddedSignupConfigured() {
  return Boolean(process.env.WHATSAPP_APP_ID && process.env.WHATSAPP_ES_CONFIG_ID);
}

// The code Meta hands the browser expires in 30 seconds, so this has to be the
// first call made after the popup closes.
export async function exchangeSignupCode(code) {
  const id = process.env.WHATSAPP_APP_ID;
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!id || !secret) throw new Error('WhatsApp app credentials are not configured');

  const url = new URL(`https://graph.facebook.com/${API_VERSION}/oauth/access_token`);
  url.searchParams.set('client_id', id);
  url.searchParams.set('client_secret', secret);
  url.searchParams.set('code', code);

  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    const detail = body?.error?.message || `HTTP ${res.status}`;
    throw new Error(`Could not exchange the signup code: ${detail}`);
  }
  // Meta returns how long the token lives. Keeping it lets the dashboard warn
  // the owner before the 60-day token lapses and the shop goes silent.
  const expiresIn = Number(body.expires_in);
  return {
    accessToken: body.access_token,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0
      ? new Date(Date.now() + expiresIn * 1000)
      : null,
  };
}

// Grants this app access to the customer's account so their messages start
// arriving at our webhook.
export async function subscribeAppToWaba({ wabaId, accessToken }) {
  const res = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${wabaId}/subscribed_apps`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Could not subscribe to the account: ${body?.error?.message || res.status}`);
  }
}

// Releases the number from Cloud API. Meta only offers deregister over the API
// (`POST /{phone-number-id}/deregister`); actually deleting the number, which is
// what returns it to the WhatsApp app, is WhatsApp Manager only. So this stops
// the shop from sending and receiving here, which is the part the owner asked
// for, and the UI tells them the one remaining manual step.
export async function deregisterPhoneNumber({ phoneNumberId, accessToken }) {
  const res = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/deregister`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    },
  );
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`Could not release the number: ${body?.error?.message || res.status}`);
  }
}

// Looks up the human-readable number so the dashboard can show which one the
// owner just connected, and so two shops cannot claim the same number.
export async function fetchPhoneNumber({ phoneNumberId, accessToken }) {
  const url = new URL(`https://graph.facebook.com/${API_VERSION}/${phoneNumberId}`);
  url.searchParams.set('fields', 'display_phone_number,verified_name');
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) return null;
  return {
    displayPhoneNumber: body.display_phone_number ?? null,
    verifiedName: body.verified_name ?? null,
  };
}

// Words a customer uses when they want to know how to pay, in the three
// languages the shops write in.
const PAYMENT_INTENT = new RegExp(
  [
    '\\bpay(?:ment|ing)?\\b', '\\bupi\\b', '\\bqr\\b', '\\bscan\\b',
    '\\bgpay\\b', 'google ?pay', 'phonepe', 'paytm', '\\bpaise?\\b',
    'payment kaise', 'kaise karu', 'kaise karun', 'kaise bharu', 'kitna dena',
    'पैसा', 'पैसे', 'भुगतान', 'यूपीआई', 'क्यूआर', 'कैसे भरूं', 'कैसे करूं',
  ].join('|'),
  'i',
);

export function wantsPaymentInfo(text) {
  return PAYMENT_INTENT.test(String(text || ''));
}

export async function sendWhatsAppImage({ phoneNumberId, accessToken, to, link, caption }) {
  const res = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'image',
        image: caption ? { link, caption } : { link },
      }),
    },
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw sendFailure('image', res.status, data);
  return data;
}

export async function sendWhatsAppText({ phoneNumberId, accessToken, to, body }) {
  const res = await fetch(
    `https://graph.facebook.com/${API_VERSION}/${phoneNumberId}/messages`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body },
      }),
    },
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw sendFailure('text', res.status, data);
  return data;
}

// Builds a send error that carries the HTTP status and Meta's own error code,
// because a bare message string cannot tell a dead token (401/190) apart from
// one recipient who is not on the test allow-list (131030). `lib/wahealth.js`
// reads these fields to decide whether to alarm the shop.
function sendFailure(kind, status, data) {
  const err = new Error(`WhatsApp ${kind} send failed (${status}): ${JSON.stringify(data)}`);
  err.httpStatus = status;
  err.code = data?.error?.code ?? null;
  return err;
}
