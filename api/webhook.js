import { query } from '../lib/db.js';
import { verifyWebhookSignature, parseInboundMessages, sendWhatsAppText } from '../lib/whatsapp.js';
import { createOrderFromMessage, recordOutboundMessage } from '../lib/orders.js';
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
            shop_address, shop_hours, shop_delivery, shop_tone, shop_instructions, shop_upi_id
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
