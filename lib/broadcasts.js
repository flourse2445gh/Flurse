// Festival broadcasts: one message from the owner to every past customer.
//
// Diwali and Valentine's are where a flower shop makes its year, and the offer
// has to reach the whole customer list at once. The owner writes the message
// themselves — a festival offer is the owner's words, not a model's — so a
// broadcast costs nothing but the WhatsApp send.
//
// WhatsApp only accepts a free-form message inside 24 hours of the customer's
// last message. Outside that window the send is rejected, so those customers
// are counted as `skipped` with the reason, never silently dropped: the owner
// sees exactly how many people actually got the offer.

import { query } from './db.js';
import { sendWhatsAppText } from './whatsapp.js';

export const MAX_BODY = 900;
export const AUDIENCES = ['all', 'open_window', 'repeat'];

// Customers a broadcast can be attempted for. `open_window` is the honest
// default for a free-form send, because everyone else will be refused by Meta.
export async function broadcastAudience(tenantId, audience = 'all') {
  const windowClause = audience === 'open_window'
    ? `AND EXISTS (SELECT 1 FROM messages m
                    WHERE m.customer_id = c.id AND m.direction = 'inbound'
                      AND m.created_at > now() - interval '24 hours')`
    : '';
  const repeatClause = audience === 'repeat'
    ? `AND (SELECT COUNT(*) FROM orders o WHERE o.customer_id = c.id) >= 2`
    : '';
  const { rows } = await query(
    `SELECT c.id, c.wa_id, c.display_name,
            EXISTS (SELECT 1 FROM messages m
                     WHERE m.customer_id = c.id AND m.direction = 'inbound'
                       AND m.created_at > now() - interval '24 hours') AS window_open
       FROM customers c
      WHERE c.tenant_id = $1
        AND c.wa_id IS NOT NULL
        ${windowClause}
        ${repeatClause}
      ORDER BY c.created_at ASC
      LIMIT 500`,
    [tenantId],
  );
  return rows;
}

// Creates the broadcast row and the per-recipient rows in one transaction, so a
// half-written job can never be sent.
export async function createBroadcast({ tenantId, body, audience = 'all' }) {
  const text = String(body ?? '').trim();
  if (!text) {
    const err = new Error('Message is required');
    err.code = 'EMPTY_BODY';
    throw err;
  }
  if (text.length > MAX_BODY) {
    const err = new Error(`Message must be ${MAX_BODY} characters or fewer`);
    err.code = 'BODY_TOO_LONG';
    throw err;
  }
  if (!AUDIENCES.includes(audience)) audience = 'all';

  const recipients = await broadcastAudience(tenantId, audience);
  const { rows } = await query(
    `INSERT INTO broadcasts (tenant_id, body, audience) VALUES ($1, $2, $3)
     RETURNING id, body, audience, status, created_at`,
    [tenantId, text, audience],
  );
  const broadcast = rows[0];
  for (const c of recipients) {
    await query(
      `INSERT INTO broadcast_recipients (tenant_id, broadcast_id, customer_id, status)
       VALUES ($1, $2, $3, $4)`,
      [tenantId, broadcast.id, c.id, c.window_open ? 'pending' : 'skipped'],
    );
  }
  return { broadcast, total: recipients.length };
}

// The pending recipients for a job, with the numbers needed to send.
export async function pendingRecipients(broadcastId, limit = 100) {
  const { rows } = await query(
    `SELECT br.id, br.customer_id, c.wa_id, c.display_name
       FROM broadcast_recipients br
       JOIN customers c ON c.id = br.customer_id
      WHERE br.broadcast_id = $1 AND br.status = 'pending'
      ORDER BY br.id ASC
      LIMIT $2`,
    [broadcastId, limit],
  );
  return rows;
}

export async function markRecipient(id, status, error = null) {
  await query(
    `UPDATE broadcast_recipients
        SET status = $2, error = $3, sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE NULL END
      WHERE id = $1`,
    [id, status, error ? String(error).slice(0, 500) : null],
  );
}

export async function finishBroadcast(broadcastId) {
  const { rows } = await query(
    `UPDATE broadcasts b SET
        sent_count    = (SELECT COUNT(*)::int FROM broadcast_recipients r
                          WHERE r.broadcast_id = b.id AND r.status = 'sent'),
        failed_count  = (SELECT COUNT(*)::int FROM broadcast_recipients r
                          WHERE r.broadcast_id = b.id AND r.status = 'failed'),
        skipped_count = (SELECT COUNT(*)::int FROM broadcast_recipients r
                          WHERE r.broadcast_id = b.id AND r.status = 'skipped'),
        status        = 'done',
        completed_at  = now()
      WHERE b.id = $1
      RETURNING id, status, sent_count, failed_count, skipped_count, completed_at`,
    [broadcastId],
  );
  return rows[0] ?? null;
}

// Sends the job one recipient at a time, recording each outcome. Bounded so a
// serverless function is never asked to send five hundred messages in one call:
// the caller re-invokes while `remaining` is non-zero.
export async function runBroadcast({ tenantId, broadcastId, tenant, limit = 60 }) {
  const recipients = await pendingRecipients(broadcastId, limit);
  let sent = 0;
  let failed = 0;

  for (const r of recipients) {
    if (!tenant.wa_access_token || !tenant.wa_phone_number_id) {
      await markRecipient(r.id, 'failed', 'WhatsApp is not connected');
      failed += 1;
      continue;
    }
    try {
      await sendWhatsAppText({
        phoneNumberId: tenant.wa_phone_number_id,
        accessToken: tenant.wa_access_token,
        to: r.wa_id,
        body: tenant.body,
      });
      await markRecipient(r.id, 'sent');
      sent += 1;
    } catch (err) {
      await markRecipient(r.id, 'failed', err.message);
      failed += 1;
    }
  }

  const { rows } = await query(
    `SELECT COUNT(*)::int AS n FROM broadcast_recipients
      WHERE broadcast_id = $1 AND status = 'pending'`,
    [broadcastId],
  );
  const remaining = rows[0]?.n ?? 0;
  const summary = remaining === 0 ? await finishBroadcast(broadcastId) : null;
  return { sent, failed, remaining, summary };
}

export async function listBroadcasts(tenantId, limit = 20) {
  const { rows } = await query(
    `SELECT id, body, audience, status, sent_count, failed_count, skipped_count,
            created_at, completed_at
       FROM broadcasts
      WHERE tenant_id = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [tenantId, limit],
  );
  return rows;
}

export async function getBroadcast(tenantId, broadcastId) {
  const { rows } = await query(
    `SELECT id, body, audience, status, sent_count, failed_count, skipped_count,
            created_at, completed_at
       FROM broadcasts
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, broadcastId],
  );
  return rows[0] ?? null;
}
