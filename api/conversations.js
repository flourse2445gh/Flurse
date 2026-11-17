import { query } from '../lib/db.js';
import { requireSession, assertTenantWritable } from '../lib/auth.js';
import { sendWhatsAppText } from '../lib/whatsapp.js';
import { recordOutboundMessage } from '../lib/orders.js';
import { customerList, customerStats } from '../lib/customers.js';
import { handler, readJson, json, requireMethod, HttpError } from '../lib/http.js';

// GET  /api/conversations            -> customer threads, newest activity first
// GET  /api/conversations?id=<uuid>  -> one thread with its full message history
// GET  /api/conversations?customers  -> the CRM list (spend, repeats, occasion)
// POST /api/conversations            -> record a manual reply (and send it if
//                                       the shop's WhatsApp number is connected)
export default handler(async (req, res) => {
  const session = await requireSession(req);

  if (req.method === 'POST') {
    assertTenantWritable({ status: session.status });
    const { customer_id: customerId, body } = await readJson(req);
    const text = String(body ?? '').trim();
    if (!customerId) throw new HttpError(400, 'customer_id is required');
    if (!text) throw new HttpError(400, 'body is required');

    const { rows } = await query(
      `SELECT c.id, c.wa_id, t.wa_phone_number_id, t.wa_access_token
         FROM customers c JOIN tenants t ON t.id = c.tenant_id
        WHERE c.id = $1 AND c.tenant_id = $2`,
      [customerId, session.tenant_id],
    );
    if (!rows.length) throw new HttpError(404, 'Customer not found');
    const customer = rows[0];

    await recordOutboundMessage({
      tenantId: session.tenant_id,
      customerId: customer.id,
      orderId: null,
      body: text,
    });

    // Best-effort delivery. A WhatsApp outage must not lose the reply the shop
    // typed — it is already stored above.
    let delivered = false;
    if (customer.wa_phone_number_id && customer.wa_access_token) {
      try {
        await sendWhatsAppText({
          phoneNumberId: customer.wa_phone_number_id,
          accessToken: customer.wa_access_token,
          to: customer.wa_id,
          body: text,
        });
        delivered = true;
      } catch (err) {
        console.error('Failed to send WhatsApp reply', err.message);
      }
    }

    json(res, 201, { ok: true, delivered });
    return;
  }

  if (!requireMethod(req, res, ['GET'])) return;

  const params = new URL(req.url, 'http://localhost').searchParams;

  // The CRM list: the customers underneath the chats, with what they are worth
  // and when their next occasion is. This is the repeat-order base a flower
  // shop runs on, so it gets its own view rather than being buried in threads.
  if (params.has('customers')) {
    const [customers, stats] = await Promise.all([
      customerList(session.tenant_id),
      customerStats(session.tenant_id),
    ]);
    json(res, 200, { customers, stats });
    return;
  }

  const id = params.get('id');

  if (id) {
    const { rows: customers } = await query(
      'SELECT id, wa_id, display_name, phone FROM customers WHERE id = $1 AND tenant_id = $2',
      [id, session.tenant_id],
    );
    if (!customers.length) throw new HttpError(404, 'Conversation not found');

    const [messages, orders] = await Promise.all([
      query(
        `SELECT id, direction, body, created_at
           FROM messages
          WHERE tenant_id = $1 AND customer_id = $2
          ORDER BY created_at ASC
          LIMIT 500`,
        [session.tenant_id, id],
      ),
      query(
        `SELECT o.id, o.status, o.total_cents, o.currency, o.created_at, o.raw_message,
                COALESCE(
                  json_agg(
                    json_build_object('name', oi.name, 'quantity', oi.quantity,
                                      'unitPriceCents', oi.unit_price_cents)
                  ) FILTER (WHERE oi.id IS NOT NULL), '[]'
                ) AS items
           FROM orders o
           LEFT JOIN order_items oi ON oi.order_id = o.id
          WHERE o.tenant_id = $1 AND o.customer_id = $2
          GROUP BY o.id
          ORDER BY o.created_at DESC`,
        [session.tenant_id, id],
      ),
    ]);

    json(res, 200, { customer: customers[0], messages: messages.rows, orders: orders.rows });
    return;
  }

  const { rows } = await query(
    `SELECT c.id, c.wa_id, c.display_name,
            (SELECT body FROM messages m
              WHERE m.customer_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_message,
            (SELECT created_at FROM messages m
              WHERE m.customer_id = c.id ORDER BY m.created_at DESC LIMIT 1) AS last_at,
            (SELECT COUNT(*)::int FROM messages m WHERE m.customer_id = c.id) AS message_count,
            (SELECT status FROM orders o
              WHERE o.customer_id = c.id ORDER BY o.created_at DESC LIMIT 1) AS last_order_status,
            (SELECT COUNT(*)::int FROM orders o WHERE o.customer_id = c.id) AS order_count
       FROM customers c
      WHERE c.tenant_id = $1
      ORDER BY last_at DESC NULLS LAST, c.created_at DESC
      LIMIT 100`,
    [session.tenant_id],
  );

  json(res, 200, { conversations: rows });
});
