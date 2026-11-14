import { query } from '../lib/db.js';
import { daysLeft } from '../lib/trial.js';
import { handler, readJson, json, requireMethod, HttpError } from '../lib/http.js';

// Cross-tenant operator view. Guarded by a bearer secret, not a user session,
// so it stays off the tenant dashboard surface entirely.
function requireAdmin(req) {
  const secret = process.env.ADMIN_SECRET || process.env.CRON_SECRET;
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!secret || token !== secret) throw new HttpError(401, 'Unauthorized');
}

// GET  /api/admin?view=tenants|stats|export
// POST /api/admin?action=suspend|activate|disconnect  (body: { slug })
export default handler(async (req, res) => {
  requireAdmin(req);

  const params = new URL(req.url, 'http://localhost').searchParams;

  if (req.method === 'POST') {
    const action = params.get('action');
    const { slug } = await readJson(req);
    if (!slug) throw new HttpError(400, 'slug is required');

    // suspend/activate flip the tenant lifecycle; disconnect also clears the
    // WhatsApp credentials so the number stops replying immediately.
    const sql = {
      suspend: `UPDATE tenants SET status = 'suspended', disconnected_at = now(),
                  disconnect_reason = 'operator_suspend', updated_at = now()
                 WHERE slug = $1 RETURNING slug, business_name, status`,
      activate: `UPDATE tenants SET status = 'active', disconnected_at = NULL,
                  disconnect_reason = NULL, updated_at = now()
                 WHERE slug = $1 RETURNING slug, business_name, status`,
      disconnect: `UPDATE tenants SET wa_access_token = NULL, wa_phone_number_id = NULL,
                  updated_at = now()
                 WHERE slug = $1 RETURNING slug, business_name, status`,
    }[action];
    if (!sql) throw new HttpError(400, `Unknown action: ${action}`);

    const { rows } = await query(sql, [slug]);
    if (!rows.length) throw new HttpError(404, 'Shop not found');
    json(res, 200, { tenant: rows[0] });
    return;
  }

  if (!requireMethod(req, res, ['GET'])) return;

  const view = params.get('view') ?? 'tenants';

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
            (t.wa_phone_number_id IS NOT NULL AND t.wa_access_token IS NOT NULL) AS connected,
            (SELECT COUNT(*)::int FROM orders o WHERE o.tenant_id = t.id) AS order_count
       FROM tenants t
      ORDER BY t.created_at DESC
      LIMIT 200`,
  );

  const tenants = rows.map((t) => ({
    ...t,
    daysLeft: t.status === 'trialing' ? daysLeft(t.trial_ends_at) : 0,
  }));

  if (view === 'export') {
    const header = 'shop,slug,owner,status,trial_ends_at,days_left,orders,connected,created_at';
    const csv = [header, ...tenants.map((t) => [
      csvCell(t.business_name), csvCell(t.slug), csvCell(t.owner_email), t.status,
      t.trial_ends_at ? new Date(t.trial_ends_at).toISOString() : '',
      t.daysLeft, t.order_count, t.connected,
      t.created_at ? new Date(t.created_at).toISOString() : '',
    ].join(','))].join('\n');

    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="budsbox-shops.csv"');
    res.end(csv);
    return;
  }

  json(res, 200, { tenants });
});

function csvCell(value) {
  const s = String(value ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
