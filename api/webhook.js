import { query } from '../lib/db.js';
import {
  verifyWebhookSignature, parseInboundMessages, sendWhatsAppText,
  sendWhatsAppImage, wantsPaymentInfo, publicBaseUrl,
} from '../lib/whatsapp.js';
import {
  createOrderFromMessage, recordOutboundMessage, recordInboundOnly, openAmountFor,
} from '../lib/orders.js';
import { handler, readRaw, json, error, requireMethod } from '../lib/http.js';

// GET /api/webhook  — Meta's subscription handshake
function verify(req, res) {
  const params = new URL(req.url, 'http://localhost').searchParams;
  const mode = params.get('hub.mode');
  const token = params.get('hub.verify_token');
  const challenge = params.get('hub.challenge');

  if (mode === 'subscribe' && token && token === process.env.WHATSAPP_VERIFY_TOKEN) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end(challenge ?? '');
    return;
  }
  error(res, 403, 'Verification failed');
}

export default handler(async (req, res) => {
  if (req.method === 'GET') return verify(req, res);
  if (!requireMethod(req, res, ['POST'])) return;

  const raw = await readRaw(req);
  const signature = req.headers['x-hub-signature-256'];

  if (!verifyWebhookSignature(raw, signature, process.env.WHATSAPP_APP_SECRET)) {
    error(res, 401, 'Invalid signature');
    return;
  }

  // Process first, then ack: a serverless function can be frozen the moment
  // the response ends, which would drop work still in flight.
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    console.error('Webhook body was not JSON');
    json(res, 200, { received: true });
    return;
  }

  const messages = parseInboundMessages(payload);
  for (const message of messages) {
    try {
      await handleMessage(message);
    } catch (err) {
      console.error('Failed to handle message', message.waMessageId, err);
      await query(
        `INSERT INTO webhook_events (wa_message_id, event_type, payload, error)
         VALUES ($1, 'message', $2, $3)
         ON CONFLICT (wa_message_id) DO NOTHING`,
        [message.waMessageId, JSON.stringify(payload), err.message],
      ).catch(() => {});
    }
  }

  json(res, 200, { received: true });
});

async function handleMessage(message) {
  const { rows: tenants } = await query(
    `SELECT id, status, wa_phone_number_id, wa_access_token, business_name,
            shop_address, shop_hours, shop_delivery, shop_tone, shop_instructions,
            shop_upi_id, shop_payment_name, shop_payment_qr_token
       FROM tenants WHERE wa_phone_number_id = $1`,
    [message.phoneNumberId],
  );

  const tenant = tenants[0];
  if (!tenant) {
    console.warn('No tenant for phone number id', message.phoneNumberId);
    return;
  }

  // A suspended tenant's number stays wired to Meta, so drop inbound traffic
  // rather than creating orders we cannot fulfil.
  if (tenant.status !== 'trialing' && tenant.status !== 'active') {
    await query(
      `INSERT INTO webhook_events (tenant_id, wa_message_id, event_type, payload, error)
       VALUES ($1, $2, 'message', $3, 'tenant_inactive')
       ON CONFLICT (wa_message_id) DO NOTHING`,
      [tenant.id, message.waMessageId, JSON.stringify(message)],
    );
    return;
  }

  await query(
    `INSERT INTO webhook_events (tenant_id, wa_message_id, event_type, payload, processed)
     VALUES ($1, $2, 'message', $3, true)
     ON CONFLICT (wa_message_id) DO NOTHING`,
    [tenant.id, message.waMessageId, JSON.stringify(message)],
  );

  if (!message.text) return;

  // Payment shortcut. A shop owner wants "payment kaise karu?" answered with
  // their own QR, every time, without spending an AI call on it. Only when a
  // QR is actually uploaded — otherwise fall through to the normal reply.
  const qrUrl = tenant.shop_payment_qr_token && publicBaseUrl()
    ? `${publicBaseUrl()}/api/qr?t=${tenant.shop_payment_qr_token}`
    : null;
  if (qrUrl && wantsPaymentInfo(message.text)) {
    const turn = await recordInboundOnly({ tenant, message });
    if (!turn) return; // duplicate delivery

    const cents = await openAmountFor(tenant.id, turn.customerId);
    const amount = cents ? `₹${(cents / 100).toFixed(0)}` : '';
    // The payee name travels with the QR, so the customer can confirm the money
    // reaches the right shop before paying.
    const name = tenant.shop_payment_name?.trim();
    const caption = amount && name
      ? `Scan karke ${amount} bhejiye. Naam "${name}" dikhna chahiye 🙏`
      : amount
        ? `Scan karke ${amount} pay kar dijiye 🙏`
        : name
          ? `Payment ke liye ye QR scan kijiye. Naam "${name}" dikhna chahiye 🙏`
          : 'Payment ke liye ye QR scan kijiye 🙏';

    if (tenant.wa_access_token) {
      try {
        await sendWhatsAppImage({
          phoneNumberId: tenant.wa_phone_number_id,
          accessToken: tenant.wa_access_token,
          to: message.from,
          link: qrUrl,
          caption,
        });
      } catch (err) {
        // A WhatsApp hiccup must not lose the fact the shop answered.
        console.error('Failed to send payment QR', err.message);
        if (tenant.shop_upi_id) {
          await sendWhatsAppText({
            phoneNumberId: tenant.wa_phone_number_id,
            accessToken: tenant.wa_access_token,
            to: message.from,
            body: tenant.shop_payment_name
              ? `${caption} UPI: ${tenant.shop_upi_id} (${tenant.shop_payment_name})`
              : `${caption} UPI: ${tenant.shop_upi_id}`,
          }).catch(() => {});
        }
      }
    }
    await recordOutboundMessage({
      tenantId: tenant.id,
      customerId: turn.customerId,
      orderId: null,
      body: caption,
    });
    return;
  }

  const result = await createOrderFromMessage({ tenant, message });
  if (!result) return; // duplicate delivery

  if (tenant.wa_access_token) {
    await sendWhatsAppText({
      phoneNumberId: tenant.wa_phone_number_id,
      accessToken: tenant.wa_access_token,
      to: message.from,
      body: result.reply,
    });
  }

  await recordOutboundMessage({
    tenantId: tenant.id,
    customerId: result.customerId,
    orderId: result.order ? result.order.id : null,
    body: result.reply,
  });
}
