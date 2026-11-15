import { withTransaction, query } from './db.js';
import { parseOrder, draftReply } from './ai.js';

// How much of the thread the reply writer sees. Enough for context, small
// enough to stay inside a free-tier token budget.
const HISTORY_LIMIT = 10;

// Finds or creates the customer row for an inbound WhatsApp number.
async function upsertCustomer(client, tenantId, waId, displayName) {
  const { rows } = await client.query(
    `INSERT INTO customers (tenant_id, wa_id, display_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, wa_id)
     DO UPDATE SET display_name = COALESCE(EXCLUDED.display_name, customers.display_name)
     RETURNING id`,
    [tenantId, waId, displayName],
  );
  return rows[0].id;
}

// Fills delivery details on an open order as the customer reveals them across
// messages, so "12 Gandhi Road" or "kal 6 baje" does not need a new order.
async function applyDetails(client, tenantId, orderId, details) {
  const patch = {
    fulfilment: details.fulfilment ?? null,
    delivery_address: details.address ?? null,
    delivery_at: details.at ?? null,
    delivery_note: details.note ?? null,
    recipient_name: details.name ?? null,
    recipient_phone: details.phone ?? null,
  };
  const { rows } = await client.query(
    `UPDATE orders SET
        fulfilment       = COALESCE($3, fulfilment),
        delivery_address = COALESCE($4, delivery_address),
        delivery_at      = COALESCE($5, delivery_at),
        delivery_note    = COALESCE($6, delivery_note),
        recipient_name   = COALESCE($7, recipient_name),
        recipient_phone  = COALESCE($8, recipient_phone)
      WHERE tenant_id = $1 AND id = $2
      RETURNING id, status, total_cents, payment_status, fulfilment, delivery_address,
                delivery_at, delivery_note, recipient_name, recipient_phone`,
    [
      tenantId,
      orderId,
      patch.fulfilment,
      patch.delivery_address,
      patch.delivery_at,
      patch.delivery_note,
      patch.recipient_name,
      patch.recipient_phone,
    ],
  );
  return rows[0] ?? null;
}

// The newest open order for this customer, so a later message that only adds
// an address lands on the order it belongs to.
async function openOrderFor(client, tenantId, customerId) {
  const { rows } = await client.query(
    `SELECT id, status, total_cents, payment_status, fulfilment, delivery_address,
            delivery_at, delivery_note, recipient_name, recipient_phone
       FROM orders
      WHERE tenant_id = $1 AND customer_id = $2 AND status IN ('pending', 'confirmed')
      ORDER BY created_at DESC
      LIMIT 1`,
    [tenantId, customerId],
  );
  return rows[0] ?? null;
}

// Turns one inbound message into a conversation turn. When the message names
// catalog items it also creates an order. Idempotent on wa_message_id so a
// webhook retry from Meta neither double-charges the customer nor sends a
// second reply.
export async function createOrderFromMessage({ tenant, message }) {
  const { rows: products } = await query(
    `SELECT id, name, price_cents, active
       FROM products WHERE tenant_id = $1 ORDER BY name`,
    [tenant.id],
  );
  const orderable = products.filter((p) => p.active !== false);

  const parsed = await parseOrder(message.text, orderable);
  const items = parsed.items;
  const totalCents = items.reduce(
    (sum, i) => sum + i.unitPriceCents * i.quantity,
    0,
  );

  const turn = await withTransaction(async (client) => {
    const customerId = await upsertCustomer(
      client,
      tenant.id,
      message.from,
      message.displayName,
    );

    // Claim the message id first: a retry that loses this race is a duplicate.
    const { rows: msgRows } = await client.query(
      `INSERT INTO messages (tenant_id, customer_id, direction, body, wa_message_id)
       VALUES ($1, $2, 'inbound', $3, $4)
       ON CONFLICT (tenant_id, wa_message_id) DO NOTHING
       RETURNING id`,
      [tenant.id, customerId, message.text, message.waMessageId],
    );
    if (!msgRows.length) return null;
    const inboundMessageId = msgRows[0].id;

    let order = null;
    let detailsOrder = null;
    if (items.length) {
      const { rows } = await client.query(
        `INSERT INTO orders (tenant_id, customer_id, wa_message_id, total_cents, currency, raw_message,
                             fulfilment, delivery_address, delivery_at, delivery_note,
                             recipient_name, recipient_phone)
         VALUES ($1, $2, $3, $4, 'INR', $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (tenant_id, wa_message_id) DO NOTHING
         RETURNING id, total_cents, status, payment_status, fulfilment, delivery_address,
                   delivery_at, delivery_note, recipient_name, recipient_phone`,
        [
          tenant.id,
          customerId,
          message.waMessageId,
          totalCents,
          message.text,
          parsed.details.fulfilment ?? null,
          parsed.details.address ?? null,
          parsed.details.at ?? null,
          parsed.details.note ?? null,
          parsed.details.name ?? null,
          parsed.details.phone ?? null,
        ],
      );
      if (rows.length) {
        order = rows[0];
        for (const item of items) {
          await client.query(
            `INSERT INTO order_items (tenant_id, order_id, product_id, name, quantity, unit_price_cents)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [tenant.id, order.id, item.productId, item.name, item.quantity, item.unitPriceCents],
          );
        }
        await client.query('UPDATE messages SET order_id = $2 WHERE id = $1', [
          inboundMessageId,
          order.id,
        ]);
        detailsOrder = order;
      }
    }

    // A message with no catalog item can still be the customer filling in
    // "12 Gandhi Road" or "kal 6 baje" for the order they already placed.
    if (!detailsOrder && Object.keys(parsed.details).length) {
      const open = await openOrderFor(client, tenant.id, customerId);
      if (open) {
        detailsOrder = await applyDetails(client, tenant.id, open.id, parsed.details);
        await client.query('UPDATE messages SET order_id = $2 WHERE id = $1', [
          inboundMessageId,
          open.id,
        ]);
      }
    }

    return { order, detailsOrder, customerId, items, parseSource: parsed.source };
  });

  if (!turn) return null;

  const { rows: history } = await query(
    `SELECT direction, body
       FROM messages
      WHERE tenant_id = $1 AND customer_id = $2
      ORDER BY created_at DESC
      LIMIT $3`,
    [tenant.id, turn.customerId, HISTORY_LIMIT],
  );

  const drafted = await draftReply({
    tenant,
    products,
    messageText: message.text,
    items: turn.items,
    history: history.reverse(),
    order: turn.detailsOrder,
  });

  return {
    order: turn.order,
    detailsOrder: turn.detailsOrder,
    reply: drafted.reply,
    replySource: drafted.source,
    language: drafted.language,
    customerId: turn.customerId,
  };
}

export async function recordOutboundMessage({ tenantId, customerId, orderId, body }) {
  await query(
    `INSERT INTO messages (tenant_id, customer_id, order_id, direction, body)
     VALUES ($1, $2, $3, 'outbound', $4)`,
    [tenantId, customerId ?? null, orderId ?? null, body],
  );
}

export async function getDashboardSummary(tenantId) {
  const [orders, revenue, customers, pending] = await Promise.all([
    query('SELECT COUNT(*)::int AS n FROM orders WHERE tenant_id = $1', [tenantId]),
    query(
      `SELECT COALESCE(SUM(total_cents), 0)::int AS cents
         FROM orders WHERE tenant_id = $1 AND status <> 'cancelled'`,
      [tenantId],
    ),
    query('SELECT COUNT(*)::int AS n FROM customers WHERE tenant_id = $1', [tenantId]),
    query(
      "SELECT COUNT(*)::int AS n FROM orders WHERE tenant_id = $1 AND status = 'pending'",
      [tenantId],
    ),
  ]);

  return {
    orders: orders.rows[0].n,
    revenueCents: revenue.rows[0].cents,
    customers: customers.rows[0].n,
    pending: pending.rows[0].n,
  };
}

export async function listOrders(tenantId, limit = 25) {
  const { rows } = await query(
    `SELECT o.id, o.status, o.total_cents, o.currency, o.created_at, o.raw_message,
            o.fulfilment, o.delivery_address, o.delivery_at, o.delivery_note,
            o.recipient_name, o.recipient_phone,
            o.payment_status, o.payment_method, o.paid_at,
            c.wa_id, c.display_name,
            COALESCE(
              json_agg(
                json_build_object('name', oi.name, 'quantity', oi.quantity,
                                  'unitPriceCents', oi.unit_price_cents)
              ) FILTER (WHERE oi.id IS NOT NULL), '[]'
            ) AS items
       FROM orders o
       LEFT JOIN customers c ON c.id = o.customer_id
       LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.tenant_id = $1
      GROUP BY o.id, c.wa_id, c.display_name
      ORDER BY o.created_at DESC
      LIMIT $2`,
    [tenantId, limit],
  );
  return rows;
}

export async function updateOrderStatus(tenantId, orderId, status) {
  // Money first: a florist does not hand over flowers until the order is paid.
  // Cancelling stays allowed so an order can always be dropped.
  if (status === 'fulfilled') {
    const { rows: current } = await query(
      'SELECT payment_status FROM orders WHERE id = $1 AND tenant_id = $2',
      [orderId, tenantId],
    );
    if (!current.length) return null;
    if (current[0].payment_status !== 'paid') {
      const err = new Error('Order must be paid before it can be fulfilled');
      err.code = 'PAYMENT_REQUIRED';
      throw err;
    }
  }
  const { rows } = await query(
    `UPDATE orders SET status = $3
      WHERE id = $1 AND tenant_id = $2
      RETURNING id, status`,
    [orderId, tenantId, status],
  );
  return rows[0] ?? null;
}

// Marks an order paid (or refunded) by hand, the way a florist does after
// seeing the UPI transfer land in their account.
export async function setOrderPayment(tenantId, orderId, { paymentStatus, method }) {
  const { rows } = await query(
    `UPDATE orders
        SET payment_status = $3,
            payment_method = $4,
            paid_at        = CASE WHEN $3 = 'paid' THEN COALESCE(paid_at, now()) ELSE NULL END
      WHERE id = $1 AND tenant_id = $2
      RETURNING id, payment_status, payment_method, paid_at`,
    [orderId, tenantId, paymentStatus, method ?? null],
  );
  return rows[0] ?? null;
}

// A UPI intent link the customer can tap. Amount is in paise and encoded in
// rupees, as every UPI app expects.
export function upiLink({ upiId, businessName, amountCents, note }) {
  if (!upiId || !amountCents) return null;
  const params = new URLSearchParams({
    pa: upiId,
    pn: businessName || 'Shop',
    am: (amountCents / 100).toFixed(2),
    cu: 'INR',
    tn: (note || 'Order').slice(0, 50),
  });
  return `upi://pay?${params.toString()}`;
}
