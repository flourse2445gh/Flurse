import { withTransaction, query } from './db.js';
import { parseOrder, draftReply, detectLanguage, matchCatalogItems } from './ai.js';
import { freeReply, freeIntent, freePhotoTarget, needsOpenOrder, looksLikeOrder } from './replies.js';
import { rememberOccasion } from './occasions.js';
import { PLANS, DEFAULT_PLAN } from './plans.js';

// How much of the thread the reply writer sees. Enough for context, small
// enough to stay inside a free-tier token budget.
const HISTORY_LIMIT = 10;

// How many AI replies the shop has used this calendar month. Counted from the
// messages the shop already stores, so nothing extra has to be tracked.
async function aiRepliesThisMonth(tenantId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM messages
      WHERE tenant_id = $1 AND direction = 'inbound' AND ai_reply
        AND created_at >= date_trunc('month', now())`,
    [tenantId],
  );
  return rows[0]?.n ?? 0;
}

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

  // Fair use: once the month's AI allowance is spent, the shop keeps answering
  // every customer, but through the keyword matcher, which costs nothing. The
  // shop never goes silent, and the cost of a heavy shop stays bounded.
  const allowance = PLANS[tenant.plan]?.aiReplies ?? PLANS[DEFAULT_PLAN].aiReplies;
  const used = await aiRepliesThisMonth(tenant.id);
  const aiAllowed = used < allowance;

  // A clear question that is not also an order ("Latte ka price kya hai?") is
  // answered from the shop's own catalog and profile with no model call at all,
  // not even the order parse. A message that asks for something ("2 roses bhej
  // do") is left to the normal path below, so its items and delivery details are
  // never lost to save a paisa.
  const freeOnly = Boolean(freeIntent(message.text)) && !looksLikeOrder(message.text);

  const parsed = freeOnly
    ? { items: [], details: {}, source: 'free' }
    : await parseOrder(message.text, orderable, { aiAllowed });
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

    return { order, detailsOrder, customerId, items, parseSource: parsed.source, inboundMessageId };
  });

  if (!turn) return null;

  // A free answer, before any model call, for the questions a florist gets all
  // day that the shop's own profile already answers. Same idea as the payment
  // shortcut: nothing to invent, so nothing to pay for. Only when it is clearly
  // that question — otherwise the message goes through the normal path below.
  const free = freeReply({
    tenant,
    products: orderable,
    messageText: message.text,
    // A free question was never parsed, so match the catalog deterministically
    // for the price answer. No model is involved either way.
    items: turn.items.length ? turn.items : matchCatalogItems(message.text, orderable),
    openOrder: needsOpenOrder(message.text)
      ? await openOrderForCustomer(tenant.id, turn.customerId)
      : null,
  });
  if (free) {
    // The date a card message names ("Happy Birthday Rahul, 15 August") is the
    // shop's most valuable asset: it is what brings the customer back next
    // year. Best-effort, and never allowed to break the reply.
    rememberOccasion({
      tenantId: tenant.id, customerId: turn.customerId, text: message.text,
    }).catch((err) => console.error('Occasion capture failed', err.message));

    const photoItem = freePhotoTarget({
      messageText: message.text,
      items: turn.items.length ? turn.items : matchCatalogItems(message.text, orderable),
    });
    return {
      order: turn.order,
      detailsOrder: turn.detailsOrder,
      reply: free,
      replySource: 'free',
      language: detectLanguage(message.text),
      customerId: turn.customerId,
      newOrder: turn.order,
      items: turn.items,
      // The product whose photo should ride along with a price answer, if the
      // shop has uploaded one. Resolved to a URL by the caller.
      photoItem,
    };
  }

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
    aiAllowed,
  });

  // Stamp the turn only when a model actually wrote the reply, so the monthly
  // count reflects real spend and not greetings or template answers.
  if (String(drafted.source).startsWith('llm:')) {
    await query('UPDATE messages SET ai_reply = true WHERE id = $1', [turn.inboundMessageId]);
  }

  // A card message on an order ("Happy Birthday Rahul, 15 August") carries the
  // same occasion a bare question does, so it is remembered here too.
  rememberOccasion({
    tenantId: tenant.id, customerId: turn.customerId, text: message.text,
  }).catch((err) => console.error('Occasion capture failed', err.message));

  return {
    order: turn.order,
    detailsOrder: turn.detailsOrder,
    reply: drafted.reply,
    replySource: drafted.source,
    language: drafted.language,
    customerId: turn.customerId,
    // Only set when this message actually created an order, so the webhook
    // emails the owner once and not again on every follow-up message.
    newOrder: turn.order,
    items: turn.items,
  };
}

// Stores an inbound message on its own, with no AI call. Used for the payment
// shortcut: a customer asking how to pay must not spend an AI credit, and the
// shop answers with its own QR. Idempotent, so a Meta retry is ignored.
export async function recordInboundOnly({ tenant, message }) {
  return withTransaction(async (client) => {
    const customerId = await upsertCustomer(
      client, tenant.id, message.from, message.displayName,
    );
    const { rows } = await client.query(
      `INSERT INTO messages (tenant_id, customer_id, direction, body, wa_message_id)
       VALUES ($1, $2, 'inbound', $3, $4)
       ON CONFLICT (tenant_id, wa_message_id) DO NOTHING
       RETURNING id`,
      [tenant.id, customerId, message.text, message.waMessageId],
    );
    if (!rows.length) return null;
    return { customerId };
  });
}

// The amount to ask for, taken from the customer's newest open unpaid order.
export async function openAmountFor(tenantId, customerId) {
  const { rows } = await query(
    `SELECT total_cents FROM orders
      WHERE tenant_id = $1 AND customer_id = $2
        AND status IN ('pending', 'confirmed') AND payment_status <> 'paid'
      ORDER BY created_at DESC LIMIT 1`,
    [tenantId, customerId],
  );
  return rows[0]?.total_cents ?? null;
}

// The customer's newest open order, for a free reply that has to state its
// status. Query-based (the reply path is outside the write transaction).
export async function openOrderForCustomer(tenantId, customerId) {
  if (!customerId) return null;
  const { rows } = await query(
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
            o.delivery_photo_token, o.delivery_photo_sent_at,
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

// Orders due tomorrow that have not had a reminder yet, with everything the
// reminder needs. Delivery-day only, since a pickup needs no nudge, and only
// while the shop can still send (a live connection is checked by the caller).
export async function ordersNeedingReminder(now = new Date()) {
  const { rows } = await query(
    `SELECT o.id, o.tenant_id, o.total_cents, o.fulfilment, o.delivery_at,
            o.delivery_address, o.recipient_name, o.recipient_phone, o.delivery_note,
            o.payment_status, o.status, o.customer_id,
            c.wa_id AS customer_wa_id, c.display_name AS customer_name,
            t.slug, t.business_name, t.owner_email, t.wa_phone_number_id, t.wa_access_token
       FROM orders o
       JOIN tenants t ON t.id = o.tenant_id
       LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.status IN ('pending', 'confirmed')
        AND o.fulfilment = 'delivery'
        AND o.reminder_sent_at IS NULL
        AND o.delivery_at IS NOT NULL
        AND o.delivery_at > $1::timestamptz
        AND o.delivery_at <= $1::timestamptz + interval '24 hours'
        AND t.status IN ('trialing', 'active')
      ORDER BY o.delivery_at ASC
      LIMIT 50`,
    [now],
  );
  return rows;
}

// Orders due to be delivered tomorrow (IST calendar day), for the dashboard
// banner. This is the reminder that survives with no email key and no open
// WhatsApp window: the cron cannot reach the owner outside those channels, so
// the app states it plainly on the screen the owner already has open.
export async function ordersDueTomorrow(tenantId, now = new Date()) {
  const { rows } = await query(
    `SELECT o.id, o.delivery_at, o.recipient_name, o.payment_status,
            c.display_name AS customer_name
       FROM orders o
       LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.tenant_id = $1
        AND o.status IN ('pending', 'confirmed')
        AND o.fulfilment = 'delivery'
        AND o.delivery_at IS NOT NULL
        AND (o.delivery_at AT TIME ZONE 'Asia/Kolkata')::date
            = (($2::timestamptz) AT TIME ZONE 'Asia/Kolkata')::date + 1
      ORDER BY o.delivery_at ASC
      LIMIT 20`,
    [tenantId, now],
  );
  return rows.map((r) => ({
    id: r.id,
    deliveryAt: r.delivery_at,
    recipient: r.recipient_name || r.customer_name || null,
    paid: r.payment_status === 'paid',
  }));
}

// The line items for a set of orders, keyed by order id, so the reminder and
// the owner email can both list what was ordered.
export async function itemsByOrder(tenantId, orderIds) {
  if (!orderIds.length) return new Map();
  const { rows } = await query(
    `SELECT order_id, name, quantity, unit_price_cents
       FROM order_items
      WHERE tenant_id = $1 AND order_id = ANY($2::uuid[])`,
    [tenantId, orderIds],
  );
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.order_id)) map.set(r.order_id, []);
    map.get(r.order_id).push({
      name: r.name, quantity: r.quantity, unitPriceCents: r.unit_price_cents,
    });
  }
  return map;
}

export async function markReminderSent(orderId) {
  await query('UPDATE orders SET reminder_sent_at = now() WHERE id = $1', [orderId]);
}

// WhatsApp only lets a business send a free-form message within 24 hours of the
// customer's last message. Outside that window the reminder would be rejected,
// so the cron checks before sending and falls back to the owner email instead.
export async function customerWindowOpen(tenantId, customerId, now = new Date()) {
  if (!customerId) return false;
  const { rows } = await query(
    `SELECT 1 FROM messages
      WHERE tenant_id = $1 AND customer_id = $2 AND direction = 'inbound'
        AND created_at > $3::timestamptz - interval '24 hours'
      LIMIT 1`,
    [tenantId, customerId, now],
  );
  return rows.length > 0;
}

// How many orders landed since the owner last opened the dashboard. Drives the
// "naya order" badge, so an owner who is at a screen still notices one arrive.
export async function unseenOrderCount(tenantId) {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS n
       FROM orders
      WHERE tenant_id = $1
        AND status <> 'cancelled'
        AND created_at > COALESCE((SELECT orders_seen_at FROM tenants WHERE id = $1), 'epoch')`,
    [tenantId],
  );
  return rows[0]?.n ?? 0;
}

export async function markOrdersSeen(tenantId) {
  await query('UPDATE tenants SET orders_seen_at = now() WHERE id = $1', [tenantId]);
}

// The WhatsApp number of the customer on an order, so a delivered photo can be
// sent to them without another join at the call site.
export async function customerWaIdForOrder(tenantId, orderId) {
  const { rows } = await query(
    `SELECT c.wa_id
       FROM orders o JOIN customers c ON c.id = o.customer_id
      WHERE o.id = $1 AND o.tenant_id = $2`,
    [orderId, tenantId],
  );
  return rows[0]?.wa_id ?? null;
}
