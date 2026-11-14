import { withTransaction, query } from './db.js';
import { parseOrder, formatOrderConfirmation } from './ai.js';

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

// Turns one inbound message into an order. Idempotent on wa_message_id so a
// webhook retry from Meta does not create a duplicate order.
export async function createOrderFromMessage({ tenant, message }) {
  const { rows: products } = await query(
    'SELECT id, name, price_cents FROM products WHERE tenant_id = $1 AND active = true',
    [tenant.id],
  );

  const parsed = await parseOrder(message.text, products);
  const totalCents = parsed.items.reduce(
    (sum, i) => sum + i.unitPriceCents * i.quantity,
    0,
  );

  const order = await withTransaction(async (client) => {
    const customerId = await upsertCustomer(
      client,
      tenant.id,
      message.from,
      message.displayName,
    );

    const { rows } = await client.query(
      `INSERT INTO orders (tenant_id, customer_id, wa_message_id, total_cents, raw_message, notes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, wa_message_id) DO NOTHING
       RETURNING id, total_cents, status`,
      [
        tenant.id,
        customerId,
        message.waMessageId,
        totalCents,
        message.text,
        parsed.items.length === 0 ? 'no_catalog_match' : null,
      ],
    );

    // Conflict means we already handled this message id.
    if (!rows.length) return null;
    const created = rows[0];

    for (const item of parsed.items) {
      await client.query(
        `INSERT INTO order_items (tenant_id, order_id, product_id, name, quantity, unit_price_cents)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [tenant.id, created.id, item.productId, item.name, item.quantity, item.unitPriceCents],
      );
    }

    await client.query(
      `INSERT INTO messages (tenant_id, customer_id, order_id, direction, body, wa_message_id)
       VALUES ($1, $2, $3, 'inbound', $4, $5)`,
      [tenant.id, customerId, created.id, message.text, message.waMessageId],
    );

    return { ...created, customerId, items: parsed.items, parseSource: parsed.source };
  });

  if (!order) return null;

  const reply = order.items.length
    ? formatOrderConfirmation(order, order.items)
    : "Sorry, I couldn't match anything on our menu. Reply with item names, e.g. '2 lattes'.";

  return { order, reply };
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
  const { rows } = await query(
    `UPDATE orders SET status = $3
      WHERE id = $1 AND tenant_id = $2
      RETURNING id, status`,
    [orderId, tenantId, status],
  );
  return rows[0] ?? null;
}
