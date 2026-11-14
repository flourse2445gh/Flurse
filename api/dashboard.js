import { requireSession, assertTenantWritable } from '../lib/auth.js';
import {
  getDashboardSummary,
  listOrders,
  updateOrderStatus,
} from '../lib/orders.js';
import { daysLeft } from '../lib/trial.js';
import { handler, readJson, json, requireMethod, HttpError } from '../lib/http.js';

const VALID_STATUSES = ['pending', 'confirmed', 'fulfilled', 'cancelled'];

// GET  /api/dashboard              -> summary + recent orders
// POST /api/dashboard?order_id=...  -> update order status
export default handler(async (req, res) => {
  const session = await requireSession(req);

  if (req.method === 'GET') {
    const [summary, orders] = await Promise.all([
      getDashboardSummary(session.tenant_id),
      listOrders(session.tenant_id, 25),
    ]);

    json(res, 200, {
      tenant: {
        slug: session.slug,
        businessName: session.business_name,
        status: session.status,
        trialEndsAt: session.trial_ends_at,
        daysLeft: daysLeft(session.trial_ends_at),
      },
      summary,
      orders,
    });
    return;
  }

  if (!requireMethod(req, res, ['POST'])) return;
  assertTenantWritable({ status: session.status });

  const params = new URL(req.url, 'http://localhost').searchParams;
  const orderId = params.get('order_id');
  if (!orderId) throw new HttpError(400, 'order_id is required');

  const { status } = await readJson(req);
  if (!VALID_STATUSES.includes(status)) {
    throw new HttpError(400, `status must be one of: ${VALID_STATUSES.join(', ')}`);
  }

  const updated = await updateOrderStatus(session.tenant_id, orderId, status);
  if (!updated) throw new HttpError(404, 'Order not found');
  json(res, 200, { order: updated });
});
