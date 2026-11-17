import { query } from './db.js';

// A Cloud API token bought through Embedded Signup lives 60 days. Warn the
// owner with a week to spare: enough time to reconnect, not so early that the
// warning is wallpaper.
export const TOKEN_WARN_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

// Kinds that mean the connection itself is broken, so the shop cannot send to
// anyone. Everything else is either one bad recipient or a passing hiccup.
const CONNECTION_KINDS = new Set(['token', 'permission']);

// Recipient-specific failures. Meta answers a number that is not on the test
// allow-list with 131030 and an unreachable one with 131026. Those say nothing
// about the connection, so they must not raise a shop-wide alarm.
const RECIPIENT_KINDS = new Set(['recipient_not_allowed', 'undeliverable']);

// Turns a Cloud API send failure into a kind the dashboard can act on. Meta
// signals a dead or revoked token with 401/190, a rate limit with 429/131056.
// Anything unrecognised stays `other` rather than being guessed at.
export function classifySendError(err) {
  const status = err?.httpStatus;
  const code = err?.code;
  if (status === 401 || code === 190) return 'token';
  if (status === 403) return 'permission';
  if (status === 429 || code === 131056) return 'rate_limit';
  if (code === 131030) return 'recipient_not_allowed';
  if (code === 131026) return 'undeliverable';
  if (status === 400) return 'bad_request';
  return 'other';
}

// Remembers the last send outcome on the tenant. A success clears the flag, so
// the warning disappears the moment the shop can send again. A failure keeps
// the reason, so the banner can say what actually went wrong. Best-effort: this
// is telemetry, so a DB hiccup here must never break message handling.
export async function recordSendOutcome(tenantId, err) {
  if (!tenantId) return;
  try {
    if (!err) {
      await query(
        `UPDATE tenants
            SET wa_last_error = NULL,
                wa_last_error_kind = NULL,
                wa_last_error_at = NULL,
                updated_at = now()
          WHERE id = $1
            AND (wa_last_error IS NOT NULL OR wa_last_error_kind IS NOT NULL)`,
        [tenantId],
      );
      return;
    }
    await query(
      `UPDATE tenants
          SET wa_last_error = $2,
              wa_last_error_kind = $3,
              wa_last_error_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [tenantId, String(err?.message ?? err).slice(0, 300), classifySendError(err)],
    );
  } catch (e) {
    console.error('Could not record WhatsApp send outcome', e.message);
  }
}

// One place decides whether a shop must be told its connection is at risk, so
// the dashboard, the WhatsApp tab and the daily cron never disagree. Returns
// null when the connection is healthy or was never set up.
export function connectionAlert(tenant, now = new Date()) {
  if (!tenant?.wa_phone_number_id || !tenant?.wa_access_token) return null;

  const kind = tenant.wa_last_error_kind;
  const expiresAt = tenant.wa_token_expires_at ? new Date(tenant.wa_token_expires_at) : null;
  const daysLeft = expiresAt ? Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS) : null;

  // A rejected token outranks everything: no reply is reaching any customer.
  if (kind && CONNECTION_KINDS.has(kind)) {
    return {
      level: 'error',
      kind: 'token_dead',
      daysLeft,
      message: 'WhatsApp ne connection reject kar diya — AI jawab bhej nahi pa raha. Number dobara connect karein.',
    };
  }
  if (expiresAt && daysLeft <= 0) {
    return {
      level: 'error',
      kind: 'token_expired',
      daysLeft,
      message: 'WhatsApp token expire ho gaya — AI jawab bhej nahi pa raha. Number dobara connect karein.',
    };
  }
  if (expiresAt && daysLeft <= TOKEN_WARN_DAYS) {
    return {
      level: 'warning',
      kind: 'token_expiring',
      daysLeft,
      message: `WhatsApp token ${daysLeft === 1 ? 'kal' : `${daysLeft} din me`} expire hoga. Abhi dobara connect kar lein, warna AI chup ho jayega.`,
    };
  }
  // A send failure that is not about one recipient is worth a softer nudge.
  if (kind && !RECIPIENT_KINDS.has(kind)) {
    return {
      level: 'warning',
      kind: 'send_failed',
      daysLeft,
      message: 'Kuch WhatsApp messages fail hue. Connection ek baar check kar lein — ya dobara connect karein.',
    };
  }
  return null;
}

// Shops whose token is about to lapse or has already lapsed. The daily cron
// logs these so a problem is visible before a shop's customers notice.
export async function expiringTokenTenants(now = new Date()) {
  const horizon = new Date(now.getTime() + TOKEN_WARN_DAYS * DAY_MS);
  const { rows } = await query(
    `SELECT id, slug, business_name, owner_email, wa_token_expires_at
       FROM tenants
      WHERE wa_access_token IS NOT NULL
        AND wa_token_expires_at IS NOT NULL
        AND wa_token_expires_at <= $1
      ORDER BY wa_token_expires_at ASC`,
    [horizon],
  );
  return rows;
}
