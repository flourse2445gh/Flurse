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

// Suspends every tenant whose trial or paid period has run out. The WhatsApp
// credentials are deliberately kept: the status gate is what stops replies
// (webhook, manual reply and the reminder cron all check it), and keeping the
// token is what lets a payment re-enable the number without the owner redoing
// Meta signup. Clearing it here was the bug — a shop that paid came back
// "active" but could not send a single message, because the token it needed had
// been thrown away. The operator's own suspend has always worked this way.
// Returns the tenants it acted on.
export async function expireTrials(now = new Date()) {
  const { rows } = await query(
    `UPDATE tenants
        SET status = 'suspended',
            disconnected_at = now(),
            disconnect_reason = CASE WHEN status = 'trialing' THEN 'trial_expired'
                                     ELSE 'subscription_expired' END,
            updated_at = now()
      WHERE (status = 'trialing' AND trial_ends_at <= $1)
         OR (status = 'active' AND paid_until IS NOT NULL AND paid_until <= $1)
      RETURNING id, slug, business_name, owner_email, trial_ends_at, paid_until`,
    [now],
  );
  return rows;
}
