import { query } from '../lib/db.js';
import { requireSession } from '../lib/auth.js';
import { handler, readJson, json, requireMethod, HttpError } from '../lib/http.js';

const PLANS = {
  starter: { name: 'Pro Monthly', priceCents: 59900, currency: 'INR' },
  growth:  { name: 'Multi-Outlet', priceCents: 149900, currency: 'INR' },
};

// GET  /api/payments            -> available plans
// POST /api/payments?action=upgrade  -> activate a plan, lift suspension
//
// Payment capture is stubbed: this flips the tenant to `active` without
// contacting a processor. Wire a real PSP before taking money.
export default handler(async (req, res) => {
  const session = await requireSession(req);

  if (req.method === 'GET') {
    json(res, 200, {
      plans: Object.entries(PLANS).map(([id, p]) => ({ id, ...p })),
      current: { status: session.status, trialEndsAt: session.trial_ends_at },
    });
    return;
  }

  if (!requireMethod(req, res, ['POST'])) return;

  const action = new URL(req.url, 'http://localhost').searchParams.get('action') ?? 'upgrade';
  if (action !== 'upgrade') throw new HttpError(400, `Unknown action: ${action}`);

  const { plan } = await readJson(req);
  const chosen = PLANS[plan];
  if (!chosen) {
    throw new HttpError(400, `plan must be one of: ${Object.keys(PLANS).join(', ')}`);
  }

  const { rows } = await query(
    `UPDATE tenants
        SET status = 'active',
            disconnected_at = NULL,
            disconnect_reason = NULL,
            updated_at = now()
      WHERE id = $1
      RETURNING slug, business_name, status`,
    [session.tenant_id],
  );

  json(res, 200, {
    tenant: rows[0],
    plan: { id: plan, ...chosen },
    note: 'Stubbed activation — no payment was captured.',
  });
});
