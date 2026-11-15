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
    if (items.length) {
      const { rows } = await client.query(
        `INSERT INTO orders (tenant_id, customer_id, wa_message_id, total_cents, currency, raw_message)
         VALUES ($1, $2, $3, $4, 'INR', $5)
         ON CONFLICT (tenant_id, wa_message_id) DO NOTHING
         RETURNING id, total_cents, status`,
        [tenant.id, customerId, message.waMessageId, totalCents, message.text],
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
      }
    }

    return { order, customerId, items, parseSource: parsed.source };
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
  });

  return {
    order: turn.order,
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
