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
  if (!res.ok) {
    throw new Error(`WhatsApp send failed (${res.status}): ${JSON.stringify(data)}`);
  }
  return data;
}
