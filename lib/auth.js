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
            t.shop_upi_id, t.shop_payment_qr_token
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
