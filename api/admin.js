import { query } from '../lib/db.js';
import { daysLeft } from '../lib/trial.js';
import { handler, json, requireMethod, HttpError } from '../lib/http.js';

// Cross-tenant operator view. Guarded by a bearer secret, not a user session,
// so it stays off the tenant dashboard surface entirely.
function requireAdmin(req) {
  const secret = process.env.ADMIN_SECRET || process.env.CRON_SECRET;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!secret || token !== secret) throw new HttpError(401, 'Unauthorized');
}

// GET /api/admin?view=tenants|stats
export default handler(async (req, res) => {
  if (!requireMethod(req, res, ['GET'])) return;
  requireAdmin(req);

  const view = new URL(req.url, 'http://localhost').searchParams.get('view') ?? 'tenants';

  if (view === 'stats') {
    const { rows } = await query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'trialing')::int  AS trialing,
         COUNT(*) FILTER (WHERE status = 'active')::int    AS active,
         COUNT(*) FILTER (WHERE status = 'suspended')::int AS suspended,
         COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled,
         COUNT(*)::int                                     AS total
       FROM tenants`,
    );
    const { rows: orderRows } = await query(
      `SELECT COUNT(*)::int AS orders,
              COALESCE(SUM(total_cents), 0)::int AS revenue_cents
         FROM orders WHERE status <> 'cancelled'`,
    );
    json(res, 200, { tenants: rows[0], orders: orderRows[0] });
    return;
  }

  const { rows } = await query(
    `SELECT t.id, t.slug, t.business_name, t.owner_email, t.status,
            t.trial_ends_at, t.disconnected_at, t.created_at,
            (SELECT COUNT(*)::int FROM orders o WHERE o.tenant_id = t.id) AS order_count
       FROM tenants t
      ORDER BY t.created_at DESC
      LIMIT 200`,
  );

  json(res, 200, {
    tenants: rows.map((t) => ({
      ...t,
      daysLeft: t.status === 'trialing' ? daysLeft(t.trial_ends_at) : 0,
    })),
  });
});
