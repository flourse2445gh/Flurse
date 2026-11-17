// The customer list the owner actually runs a flower shop on.
//
// A shop's real asset is not one order; it is the list of people who have
// ordered before, how much they spend, and when their next occasion is. The
// Chats tab shows threads as they happen; this shows the list underneath them,
// sorted so the best customers are at the top and the next occasion is visible.

import { query } from './db.js';

// One row per customer with the numbers that decide who is worth a message:
// how many orders, what they are worth, when they last ordered, and the next
// occasion coming up. Sorted by spend so a shopkeeper sees their best people
// first, then by recency so a brand-new customer is not buried.
export async function customerList(tenantId, limit = 200) {
  const { rows } = await query(
    `SELECT c.id, c.wa_id, c.display_name, c.phone, c.created_at,
            (SELECT COUNT(*)::int FROM orders o
              WHERE o.customer_id = c.id AND o.status <> 'cancelled') AS order_count,
            (SELECT COALESCE(SUM(o.total_cents), 0)::int FROM orders o
              WHERE o.customer_id = c.id AND o.status <> 'cancelled') AS spend_cents,
            (SELECT MAX(o.created_at) FROM orders o WHERE o.customer_id = c.id) AS last_order_at,
            (SELECT MIN(o.created_at) FROM orders o WHERE o.customer_id = c.id) AS first_order_at,
            (SELECT COUNT(*)::int FROM messages m WHERE m.customer_id = c.id) AS message_count,
            (SELECT o.status FROM orders o WHERE o.customer_id = c.id
              ORDER BY o.created_at DESC LIMIT 1) AS last_order_status,
            (SELECT o.payment_status FROM orders o WHERE o.customer_id = c.id
              ORDER BY o.created_at DESC LIMIT 1) AS last_payment_status,
            (SELECT json_build_object('kind', oc.kind, 'label', oc.label, 'onDate', oc.on_date)
               FROM customer_occasions oc
              WHERE oc.customer_id = c.id
              ORDER BY make_date(
                2024, EXTRACT(MONTH FROM oc.on_date)::int, EXTRACT(DAY FROM oc.on_date)::int
              ) ASC
              LIMIT 1) AS next_occasion
       FROM customers c
      WHERE c.tenant_id = $1
      ORDER BY spend_cents DESC, last_order_at DESC NULLS LAST, c.created_at DESC
      LIMIT $2`,
    [tenantId, limit],
  );
  return rows;
}

// Counts for the CRM header, so the owner sees the size of the asset at a
// glance: how many customers, how many have ordered more than once, and what
// the list has been worth.
export async function customerStats(tenantId) {
  const { rows } = await query(
    `SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (
          WHERE (SELECT COUNT(*) FROM orders o
                  WHERE o.customer_id = c.id AND o.status <> 'cancelled') >= 2
        )::int AS repeat_customers,
        (SELECT COUNT(*)::int FROM customer_occasions oc WHERE oc.tenant_id = $1) AS occasions_known
       FROM customers c
      WHERE c.tenant_id = $1`,
    [tenantId],
  );
  return rows[0] ?? { total: 0, repeat_customers: 0, occasions_known: 0 };
}
