import { query, withTransaction } from '../lib/db.js';
import { requireSession } from '../lib/auth.js';
import { handler, readRaw, readJson, json, requireMethod, HttpError } from '../lib/http.js';
import {
  razorpayConfigured, createRazorpayOrder, verifyCheckoutSignature, fetchPayment,
  ensureMonthlyPlan, createSubscription, fetchSubscription,
} from '../lib/razorpay.js';
import { PLANS, planList, DEFAULT_PLAN } from '../lib/plans.js';

// Lifts the suspension and extends the paid period by the plan's length,
// counting from whichever is later: now, or the period already paid for. A
// shop that renews early does not lose the days it has left.
async function activate(client, tenantId, planId) {
  const plan = PLANS[planId];
  const { rows } = await client.query(
    `UPDATE tenants
        SET status = 'active',
            plan = $2,
            paid_until = GREATEST(COALESCE(paid_until, now()), now()) + ($3 || ' days')::interval,
            disconnected_at = NULL,
            disconnect_reason = NULL,
            updated_at = now()
      WHERE id = $1
      RETURNING slug, business_name, status, plan, paid_until`,
    [tenantId, planId, plan.days],
  );
  return rows[0];
}

// Marks a checkout paid and activates the shop, exactly once. Both the browser
// callback and the webhook land here, and either may arrive first.
async function settle({ razorpayOrderId, razorpayPaymentId }) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE payments
          SET status = 'paid', razorpay_payment_id = $2, paid_at = now()
        WHERE razorpay_order_id = $1 AND status <> 'paid'
        RETURNING tenant_id, plan`,
      [razorpayOrderId, razorpayPaymentId ?? null],
    );
    if (!rows.length) return null; // unknown order, or already settled
    const tenant = await activate(client, rows[0].tenant_id, rows[0].plan);
    return { tenant, plan: rows[0].plan };
  });
}

// Confirms a webhook against Razorpay before activating anything. The payment
// must be captured, must belong to the order the webhook names, and must match
// the amount we recorded, so a forged body can settle nothing.
async function settleFromRazorpay({ paymentId, orderId }) {
  let payment;
  try {
    payment = await fetchPayment(paymentId);
  } catch {
    return null;
  }
  if (!payment || payment.status !== 'captured' || payment.order_id !== orderId) return null;

  const { rows } = await query(
    'SELECT amount_cents FROM payments WHERE razorpay_order_id = $1',
    [orderId],
  );
  if (!rows.length || Number(payment.amount) !== rows[0].amount_cents) return null;

  return settle({ razorpayOrderId: orderId, razorpayPaymentId: paymentId });
}

// --- Auto-renewal ---------------------------------------------------------
// A subscription charge is settled by asking Razorpay, never by trusting the
// webhook body. Razorpay reports `current_end`, which is when the paid period
// now runs to; setting paid_until from it keeps the shop active without any
// operator action, and stays correct if a webhook is retried.

async function applySubscriptionState(subscriptionId) {
  let sub;
  try {
    sub = await fetchSubscription(subscriptionId);
  } catch {
    return null;
  }
  if (!sub || !['halted', 'cancelled'].includes(sub.status)) return null;
  const status = sub.status;

  const { rows } = await query(
    `UPDATE subscriptions
        SET status = $2, updated_at = now()
      WHERE razorpay_subscription_id = $1
      RETURNING tenant_id`,
    [subscriptionId, status],
  );
  if (!rows.length) return null;
  const tenantId = rows[0].tenant_id;

  // A failed mandate should not silently keep serving. Suspend now; the owner
  // can pay by hand and keep their number, exactly like a trial expiry.
  await query(
    `UPDATE tenants
        SET status = 'suspended',
            disconnected_at = now(),
            disconnect_reason = 'subscription_halted',
            wa_access_token = NULL,
            updated_at = now()
      WHERE id = $1 AND status <> 'cancelled'`,
    [tenantId],
  );
  return tenantId;
}

// Extends paid_until to the end of the period Razorpay just charged for.
async function settleSubscriptionCharge(subscriptionId) {
  let sub;
  try {
    sub = await fetchSubscription(subscriptionId);
  } catch {
    return null;
  }
  if (!sub) return null;

  const currentEnd = sub.current_end ? new Date(sub.current_end * 1000) : null;
  const status = sub.status === 'active' ? 'active' : sub.status;

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE subscriptions
          SET status = $2,
              current_end = COALESCE($3, current_end),
              updated_at = now()
        WHERE razorpay_subscription_id = $1
        RETURNING tenant_id`,
      [subscriptionId, status, currentEnd],
    );
    if (!rows.length) return null;
    const tenantId = rows[0].tenant_id;

    if (currentEnd) {
      await client.query(
        `UPDATE tenants
            SET status = 'active',
                paid_until = GREATEST(COALESCE(paid_until, now()), $2),
                disconnected_at = NULL,
                disconnect_reason = NULL,
                updated_at = now()
          WHERE id = $1 AND status <> 'cancelled'`,
        [tenantId, currentEnd],
      );
    }
    return { tenantId, currentEnd };
  });
}

export default handler(async (req, res) => {
  const action = new URL(req.url, 'http://localhost').searchParams.get('action') ?? 'plans';

  // Razorpay calls this with no session. The body is treated as a hint only:
  // the payment is confirmed at Razorpay, so nothing here can be forged into a
  // free activation, and no shared secret has to be kept anywhere.
  if (action === 'webhook') {
    if (!requireMethod(req, res, ['POST'])) return;
    const raw = await readRaw(req);
    let event = {};
    try { event = JSON.parse(raw.toString('utf8') || '{}'); } catch { event = {}; }

    const entity = event?.payload?.payment?.entity;
    if (event.event === 'payment.captured' && entity?.id && entity?.order_id) {
      const settled = await settleFromRazorpay({ paymentId: entity.id, orderId: entity.order_id });
      console.log(settled ? `Activated ${settled.tenant.slug}` : 'Webhook: nothing to settle');
    }

    // Auto-renewal. Every event carries the subscription id, so the shop is
    // found by that and the real state is read back from Razorpay. The event
    // name only decides which lookup to do — it is never trusted on its own, so
    // a forged body can neither suspend a shop nor extend it for free.
    const subEntity = event?.payload?.subscription?.entity;
    const subId = subEntity?.id;
    if (subId) {
      if (event.event === 'subscription.charged' || event.event === 'subscription.activated') {
        const done = await settleSubscriptionCharge(subId);
        console.log(done ? `Renewed subscription ${subId}` : `Webhook: nothing to renew for ${subId}`);
      } else if (event.event === 'subscription.halted' || event.event === 'subscription.cancelled') {
        const done = await applySubscriptionState(subId);
        console.log(done ? `Suspended for subscription ${subId}` : `Webhook: nothing to suspend for ${subId}`);
      }
    }
    json(res, 200, { received: true });
    return;
  }

  const session = await requireSession(req);

  if (req.method === 'GET') {
    const { rows: subRows } = await query(
      `SELECT razorpay_subscription_id, status, current_end
         FROM subscriptions WHERE tenant_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [session.tenant_id],
    );
    const sub = subRows[0] ?? null;

    // Fair-use counter: how many AI replies this shop has used this month. The
    // plan decides the allowance; a shop with no plan yet gets the starter one.
    const planId = session.plan ?? DEFAULT_PLAN;
    const { rows: usageRows } = await query(
      `SELECT COUNT(*)::int AS n FROM messages
        WHERE tenant_id = $1 AND direction = 'inbound' AND ai_reply
          AND created_at >= date_trunc('month', now())`,
      [session.tenant_id],
    );
    const allowance = PLANS[planId]?.aiReplies ?? PLANS[DEFAULT_PLAN].aiReplies;

    json(res, 200, {
      plans: planList(),
      current: {
        status: session.status,
        trialEndsAt: session.trial_ends_at,
        plan: session.plan ?? null,
        paidUntil: session.paid_until ?? null,
        usage: { aiReplies: usageRows[0]?.n ?? 0, allowance },
        autoRenew: sub && sub.status === 'active'
          ? { subscriptionId: sub.razorpay_subscription_id, currentEnd: sub.current_end }
          : null,
      },
      configured: razorpayConfigured(),
    });
    return;
  }

  if (!requireMethod(req, res, ['POST'])) return;

  // Opens a checkout: records the attempt, then asks Razorpay for an order id.
  if (action === 'checkout') {
    const { plan: planId } = await readJson(req);
    const plan = PLANS[planId];
    if (!plan) throw new HttpError(400, `plan must be one of: ${Object.keys(PLANS).join(', ')}`);
    if (!razorpayConfigured()) throw new HttpError(503, 'Payments are not configured yet');

    const order = await createRazorpayOrder({
      amountCents: plan.priceCents,
      receipt: `bb_${session.tenant_id.slice(0, 8)}_${Date.now()}`,
      notes: { tenant_id: session.tenant_id, plan: planId },
    });

    await query(
      `INSERT INTO payments (tenant_id, plan, amount_cents, razorpay_order_id)
       VALUES ($1, $2, $3, $4)`,
      [session.tenant_id, planId, plan.priceCents, order.id],
    );

    json(res, 200, {
      orderId: order.id,
      amount: plan.priceCents,
      currency: plan.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      name: session.business_name,
      plan: { id: planId, ...plan },
    });
    return;
  }

  // Auto-renewal. Creates (or reuses) a monthly Razorpay plan, opens a
  // subscription for this shop, and returns the id the browser hands to
  // Razorpay checkout. The owner approves the mandate once; Razorpay then
  // charges every month and tells us by webhook.
  if (action === 'subscribe') {
    const { plan: planId } = await readJson(req);
    const plan = PLANS[planId];
    if (!plan) throw new HttpError(400, `plan must be one of: ${Object.keys(PLANS).join(', ')}`);
    if (!plan.recurring) throw new HttpError(400, 'This plan is a one-time payment, not a subscription');
    if (!razorpayConfigured()) throw new HttpError(503, 'Payments are not configured yet');

    const rzpPlanId = await ensureMonthlyPlan({ amountCents: plan.priceCents, name: `BudsBox ${plan.tier}` });
    const subscription = await createSubscription({
      planId: rzpPlanId,
      tenantId: session.tenant_id,
      plan: planId,
      notifyEmail: session.email,
    });

    await query(
      `INSERT INTO subscriptions (tenant_id, plan, amount_cents, razorpay_subscription_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (razorpay_subscription_id) DO NOTHING`,
      [session.tenant_id, planId, plan.priceCents, subscription.id],
    );
    await query(
      'UPDATE tenants SET razorpay_subscription_id = $2, updated_at = now() WHERE id = $1',
      [session.tenant_id, subscription.id],
    );

    json(res, 200, {
      subscriptionId: subscription.id,
      amount: plan.priceCents,
      currency: plan.currency,
      keyId: process.env.RAZORPAY_KEY_ID,
      name: session.business_name,
      plan: { id: planId, ...plan },
    });
    return;
  }

  // The browser callback. The signature proves the payment id belongs to this
  // order, so a hand-edited request cannot activate a shop for free.
  if (action === 'verify') {
    const { razorpay_order_id: orderId, razorpay_payment_id: paymentId,
      razorpay_signature: signature } = await readJson(req);
    if (!verifyCheckoutSignature({ orderId, paymentId, signature })) {
      throw new HttpError(400, 'Payment could not be verified');
    }
    const settled = await settle({ razorpayOrderId: orderId, razorpayPaymentId: paymentId });
    if (!settled) throw new HttpError(404, 'Payment not found');
    json(res, 200, { ok: true, tenant: settled.tenant });
    return;
  }

  // Kept for local work with no keys: flips the shop active without money
  // moving. Refused once Razorpay is configured, so it cannot be used in
  // production to skip paying.
  if (action === 'upgrade') {
    if (razorpayConfigured()) throw new HttpError(400, 'Use checkout to pay');
    const { plan: planId } = await readJson(req);
    const plan = PLANS[planId];
    if (!plan) throw new HttpError(400, `plan must be one of: ${Object.keys(PLANS).join(', ')}`);
    const tenant = await withTransaction((client) => activate(client, session.tenant_id, planId));
    json(res, 200, {
      tenant,
      plan: { id: planId, ...plan },
      note: 'Stubbed activation — no payment was captured.',
    });
    return;
  }

  throw new HttpError(400, `Unknown action: ${action}`);
});
