import crypto from 'node:crypto';
import { query } from './db.js';
import { HttpError } from './http.js';

const SCRYPT_KEYLEN = 64;
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

export function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    throw new HttpError(400, 'Password must be at least 8 characters');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, salt, digest] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !digest) return false;
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(digest, 'hex');
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function createSession(userId, tenantId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await query(
    `INSERT INTO sessions (user_id, tenant_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, tenantId, hashToken(token), expiresAt],
  );
  return { token, expiresAt };
}

export async function destroySession(token) {
  await query('DELETE FROM sessions WHERE token_hash = $1', [hashToken(token)]);
}

// How long a reset link stays good. Long enough to find the mail, short enough
// that a leaked inbox is not a standing key.
const RESET_TTL_MS = 1000 * 60 * 60; // 1 hour

// Issues a single-use reset token for a user. The raw token is returned to be
// emailed and is never stored — only its hash goes in the row, the same way
// sessions work, so a database read cannot be turned into an account takeover.
// Any earlier unused token for the user is dropped, so an old mail cannot be
// used after a newer one is requested.
export async function createPasswordReset(userId, tenantId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + RESET_TTL_MS);
  await query('DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL', [userId]);
  await query(
    `INSERT INTO password_resets (user_id, tenant_id, token_hash, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, tenantId, hashToken(token), expiresAt],
  );
  return { token, expiresAt };
}

// Resolves a reset token to its user, or null when it is unknown, already used
// or expired. The row is claimed (used_at set) in the same statement that finds
// it, so two requests racing on one link cannot both succeed.
export async function consumePasswordReset(token) {
  if (typeof token !== 'string' || !token) return null;
  const { rows } = await query(
    `UPDATE password_resets
        SET used_at = now()
      WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
      RETURNING user_id, tenant_id`,
    [hashToken(token)],
  );
  return rows[0] ?? null;
}

// Sets a new password and drops every live session for that user, so a reset
// also logs out anyone who had the old password.
export async function setUserPassword(userId, newPassword) {
  const hash = hashPassword(newPassword);
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, hash]);
  await query('DELETE FROM sessions WHERE user_id = $1', [userId]);
}

export function sessionCookie(token, expiresAt) {
  const attrs = [
    `ob_session=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
  ];
  if (process.env.NODE_ENV === 'production') attrs.push('Secure');
  return attrs.join('; ');
}

export function clearSessionCookie() {
  return 'ob_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
}

export function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

// Resolves the dashboard session for a request, or throws 401.
export async function requireSession(req) {
  const token = parseCookies(req).ob_session;
  if (!token) throw new HttpError(401, 'Not authenticated');

  const { rows } = await query(
    `SELECT s.id AS session_id, s.expires_at, s.tenant_id,
            u.id AS user_id, u.email, u.role,
            t.slug, t.business_name, t.status, t.trial_ends_at, t.plan, t.paid_until,
            t.shop_upi_id, t.shop_payment_qr_token,
            t.wa_phone_number_id, t.wa_access_token, t.wa_token_expires_at,
            t.wa_last_error, t.wa_last_error_kind, t.wa_last_error_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN tenants t ON t.id = s.tenant_id
      WHERE s.token_hash = $1`,
    [hashToken(token)],
  );

  const session = rows[0];
  if (!session) throw new HttpError(401, 'Not authenticated');
  if (new Date(session.expires_at) < new Date()) {
    await query('DELETE FROM sessions WHERE id = $1', [session.session_id]);
    throw new HttpError(401, 'Session expired');
  }
  return session;
}

// Dashboard data is readable during a trial and while active, but a suspended
// tenant gets a locked read-only view rather than a hard 401.
export function assertTenantWritable(tenant) {
  if (tenant.status === 'suspended' || tenant.status === 'cancelled') {
    throw new HttpError(402, 'Trial ended. Upgrade to keep using BudsBox.', {
      status: tenant.status,
    });
  }
}
