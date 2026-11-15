import { query } from './db.js';

export const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '14', 10);

export function trialEndDate(from = new Date()) {
  return new Date(from.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
}

export function daysLeft(trialEndsAt) {
  const ms = new Date(trialEndsAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

export function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

// Suspends every tenant whose trial or paid period has run out and revokes its
// WhatsApp access token so the disconnected number can no longer send replies.
// The phone number id is kept so inbound traffic still routes to the tenant
// and is logged as `tenant_inactive` rather than vanishing, and so an upgrade
// can re-enable the number without a new Meta registration.
// Returns the tenants it acted on.
export async function expireTrials(now = new Date()) {
  const { rows } = await query(
    `UPDATE tenants
        SET status = 'suspended',
            disconnected_at = now(),
            disconnect_reason = CASE WHEN status = 'trialing' THEN 'trial_expired'
                                     ELSE 'subscription_expired' END,
            wa_access_token = NULL,
            updated_at = now()
      WHERE (status = 'trialing' AND trial_ends_at <= $1)
         OR (status = 'active' AND paid_until IS NOT NULL AND paid_until <= $1)
      RETURNING id, slug, business_name, owner_email, trial_ends_at, paid_until`,
    [now],
  );
  return rows;
}
