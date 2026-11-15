import { query, withTransaction } from '../lib/db.js';
import { requireSession } from '../lib/auth.js';
import { handler, readRaw, readJson, json, requireMethod, HttpError } from '../lib/http.js';
import {
  razorpayConfigured, createRazorpayOrder, verifyCheckoutSignature, fetchPayment,
} from '../lib/razorpay.js';

const PLANS = {
  starter: { name: 'Pro Monthly', priceCents: 59900, currency: 'INR', days: 30 },
};

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
    json(res, 200, { received: true });
    return;
  }

  const session = await requireSession(req);

  if (req.method === 'GET') {
    json(res, 200, {
      plans: Object.entries(PLANS).map(([id, p]) => ({ id, ...p })),
      current: {
        status: session.status,
        trialEndsAt: session.trial_ends_at,
        plan: session.plan ?? null,
        paidUntil: session.paid_until ?? null,
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
