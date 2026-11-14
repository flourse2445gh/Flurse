import { query } from '../lib/db.js';
import {
  verifyPassword,
  createSession,
  destroySession,
  sessionCookie,
  clearSessionCookie,
  parseCookies,
  requireSession,
} from '../lib/auth.js';
import { daysLeft } from '../lib/trial.js';
import { handler, readJson, json, requireMethod, HttpError } from '../lib/http.js';

// POST /api/auth?action=login|logout   GET /api/auth  (current session)
export default handler(async (req, res) => {
  const action = new URL(req.url, 'http://localhost').searchParams.get('action') ?? 'session';

  if (req.method === 'GET') {
    const session = await requireSession(req);
    json(res, 200, {
      tenant: {
        slug: session.slug,
        businessName: session.business_name,
        status: session.status,
        trialEndsAt: session.trial_ends_at,
        daysLeft: daysLeft(session.trial_ends_at),
      },
      user: { email: session.email, role: session.role },
    });
    return;
  }

  if (!requireMethod(req, res, ['POST'])) return;

  if (action === 'logout') {
    const token = parseCookies(req).ob_session;
    if (token) await destroySession(token);
    res.setHeader('Set-Cookie', clearSessionCookie());
    json(res, 200, { ok: true });
    return;
  }

  if (action !== 'login') throw new HttpError(400, `Unknown action: ${action}`);

  const { email, password } = await readJson(req);
  const normalized = String(email ?? '').trim().toLowerCase();
  if (!normalized || !password) throw new HttpError(400, 'email and password are required');

  const { rows } = await query(
    `SELECT u.id, u.tenant_id, u.password_hash, t.status
       FROM users u JOIN tenants t ON t.id = u.tenant_id
      WHERE lower(u.email) = $1`,
    [normalized],
  );

  const user = rows[0];
  // Same response for unknown email and wrong password, so the endpoint does
  // not reveal which accounts exist.
  if (!user || !verifyPassword(password, user.password_hash)) {
    throw new HttpError(401, 'Invalid email or password');
  }

  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  const { token, expiresAt } = await createSession(user.id, user.tenant_id);
  res.setHeader('Set-Cookie', sessionCookie(token, expiresAt));
  json(res, 200, { ok: true });
});
