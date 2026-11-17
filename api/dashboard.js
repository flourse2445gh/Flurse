import { requireSession, assertTenantWritable } from '../lib/auth.js';
import {
  getDashboardSummary,
  listOrders,
  updateOrderStatus,
  setOrderPayment,
  unseenOrderCount,
  markOrdersSeen,
  ordersDueTomorrow,
  customerWaIdForOrder,
} from '../lib/orders.js';
import { upcomingOccasions, markOccasionsReminded } from '../lib/occasions.js';
import {
  createBroadcast, runBroadcast, listBroadcasts, getBroadcast,
} from '../lib/broadcasts.js';
import { sendDeliveryPhoto } from '../lib/photos.js';
import { daysLeft } from '../lib/trial.js';
import { connectionAlert } from '../lib/wahealth.js';
import { handler, readJson, json, requireMethod, HttpError } from '../lib/http.js';
import { query } from '../lib/db.js';

const VALID_STATUSES = ['pending', 'confirmed', 'fulfilled', 'cancelled'];
const VALID_PAYMENTS = ['unpaid', 'paid', 'refunded'];

// GET  /api/dashboard              -> summary + recent orders
// GET  /api/dashboard?occasions    -> birthdays/anniversaries coming up
// GET  /api/dashboard?broadcasts   -> past festival sends and their outcome
// POST /api/dashboard?order_id=...  -> update order status
// POST /api/dashboard?order_id=...&payment=1 -> mark paid/refunded
// POST /api/dashboard?broadcast=1  -> start a festival broadcast
// POST /api/dashboard?broadcast-run=<id> -> send the next batch
export default handler(async (req, res) => {
  const session = await requireSession(req);
  const params = new URL(req.url, 'http://localhost').searchParams;

  if (req.method === 'GET') {
    // The occasions the owner should act on now, from the shop's own memory of
    // birthdays and anniversaries.
    if (params.has('occasions')) {
      const occasions = await upcomingOccasions(session.tenant_id);
      json(res, 200, { occasions });
      return;
    }

    if (params.has('broadcasts')) {
      const broadcasts = await listBroadcasts(session.tenant_id);
      json(res, 200, { broadcasts });
      return;
    }

    const [summary, orders, unseen, dueTomorrow] = await Promise.all([
      getDashboardSummary(session.tenant_id),
      listOrders(session.tenant_id, 25),
      unseenOrderCount(session.tenant_id),
      ordersDueTomorrow(session.tenant_id),
    ]);

    json(res, 200, {
      tenant: {
        slug: session.slug,
        businessName: session.business_name,
        status: session.status,
        trialEndsAt: session.trial_ends_at,
        daysLeft: daysLeft(session.trial_ends_at),
        upiId: session.shop_upi_id ?? null,
        // Whether the WhatsApp connection is healthy, decided in one place so
        // the banner and the WhatsApp tab cannot disagree.
        waAlert: connectionAlert(session),
        // Orders that landed since the owner last opened the dashboard, so the
        // app can chime and badge a new one the moment it arrives.
        unseenOrders: unseen,
        // Deliveries due tomorrow, so the owner is told on screen even when no
        // WhatsApp window is open and no email key is set.
        dueTomorrow,
      },
      summary,
      orders,
    });
    return;
  }

  if (!requireMethod(req, res, ['POST'])) return;
  assertTenantWritable({ status: session.status });

  // Start a festival broadcast. The owner writes the message, so nothing here
  // costs a model call — it is the owner's own words to their own customers.
  if (params.has('broadcast')) {
    const { message, audience } = await readJson(req);
    try {
      const { broadcast, total } = await createBroadcast({
        tenantId: session.tenant_id,
        body: message,
        audience,
      });
      json(res, 201, { broadcast, total });
    } catch (err) {
      if (err.code === 'EMPTY_BODY' || err.code === 'BODY_TOO_LONG') {
        throw new HttpError(400, err.message);
      }
      throw err;
    }
    return;
  }

  // Send the next batch of a broadcast. The dashboard re-invokes this while
  // `remaining` is non-zero, so one serverless call never has to send the whole
  // list.
  if (params.has('broadcast-run')) {
    const broadcastId = params.get('broadcast-run');
    const broadcast = await getBroadcast(session.tenant_id, broadcastId);
    if (!broadcast) throw new HttpError(404, 'Broadcast not found');
    const { rows } = await query(
      `SELECT wa_phone_number_id, wa_access_token FROM tenants WHERE id = $1`,
      [session.tenant_id],
    );
    const tenant = {
      wa_phone_number_id: rows[0]?.wa_phone_number_id,
      wa_access_token: rows[0]?.wa_access_token,
      body: broadcast.body,
    };
    const result = await runBroadcast({
      tenantId: session.tenant_id, broadcastId, tenant,
    });
    json(res, 200, result);
    return;
  }

  // The owner has opened the dashboard, so the "naya order" badge clears.
  if (params.has('seen')) {
    await markOrdersSeen(session.tenant_id);
    json(res, 200, { ok: true });
    return;
  }

  // Dismiss the occasions the owner has seen, so the same birthday is not shown
  // on every dashboard load.
  if (params.has('occasions-seen')) {
    const { ids } = await readJson(req);
    if (Array.isArray(ids) && ids.length) await markOccasionsReminded(ids);
    json(res, 200, { ok: true });
    return;
  }

  const orderId = params.get('order_id');
  if (!orderId) throw new HttpError(400, 'order_id is required');

  // The owner uploaded the delivered photo and wants it sent now, without
  // changing the order status. Same once-only stamp as fulfilment.
  if (params.has('send-photo')) {
    const waId = await customerWaIdForOrder(session.tenant_id, orderId);
    const { rows } = await query(
      `SELECT id, recipient_name, total_cents, delivery_address, delivery_at,
              payment_status, fulfilment
         FROM orders WHERE id = $1 AND tenant_id = $2`,
      [orderId, session.tenant_id],
    );
    if (!rows.length) throw new HttpError(404, 'Order not found');
    const deliveryPhoto = await sendDeliveryPhoto({
      tenant: {
        id: session.tenant_id,
        wa_phone_number_id: session.wa_phone_number_id,
        wa_access_token: session.wa_access_token,
      },
      order: rows[0],
      customerWaId: waId,
    });
    json(res, 200, { deliveryPhoto });
    return;
  }

  if (params.get('payment')) {
    const { payment_status: paymentStatus, method } = await readJson(req);
    if (!VALID_PAYMENTS.includes(paymentStatus)) {
      throw new HttpError(400, `payment_status must be one of: ${VALID_PAYMENTS.join(', ')}`);
    }
    const updated = await setOrderPayment(session.tenant_id, orderId, { paymentStatus, method });
    if (!updated) throw new HttpError(404, 'Order not found');
    json(res, 200, { order: updated });
    return;
  }

  const { status } = await readJson(req);
  if (!VALID_STATUSES.includes(status)) {
    throw new HttpError(400, `status must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  try {
    const updated = await updateOrderStatus(session.tenant_id, orderId, status);
    if (!updated) throw new HttpError(404, 'Order not found');
    // Fulfilling an order is the moment the shop can send the delivered photo
    // with a thank-you. Best-effort: the status change already succeeded.
    let deliveryPhoto = null;
    if (status === 'fulfilled') {
      const waId = await customerWaIdForOrder(session.tenant_id, orderId);
      const { rows } = await query(
        `SELECT id, recipient_name, total_cents, delivery_address, delivery_at,
                payment_status, fulfilment
           FROM orders WHERE id = $1 AND tenant_id = $2`,
        [orderId, session.tenant_id],
      );
      deliveryPhoto = await sendDeliveryPhoto({
        tenant: {
          id: session.tenant_id,
          wa_phone_number_id: session.wa_phone_number_id,
          wa_access_token: session.wa_access_token,
        },
        order: rows[0],
        customerWaId: waId,
      });
    }
    json(res, 200, { order: updated, deliveryPhoto });
  } catch (err) {
    // Money before flowers: surface a clear, actionable message instead of 500.
    if (err.code === 'PAYMENT_REQUIRED') {
      throw new HttpError(409, 'Mark the order paid before marking it fulfilled');
    }
    throw err;
  }
});
