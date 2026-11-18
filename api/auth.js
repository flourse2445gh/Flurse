import { query } from '../lib/db.js';
import {
  verifyPassword,
  createSession,
  destroySession,
  sessionCookie,
  clearSessionCookie,
  parseCookies,
  requireSession,
  createPasswordReset,
  consumePasswordReset,
  setUserPassword,
} from '../lib/auth.js';
import { daysLeft } from '../lib/trial.js';
import { emailPasswordReset, emailConfigured, emailReady, appUrl } from '../lib/notify.js';
import { rateLimit, clearRateLimit, clientIp, tooManyResponse } from '../lib/ratelimit.js';
import { handler, readJson, json, requireMethod, HttpError } from '../lib/http.js';

// POST /api/auth?action=login|logout|forgot|reset   GET /api/auth  (current session)
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

  // Ask for a reset link. The response is always the same whether or not the
  // email exists, so this cannot be used to find out who has an account. Capped
  // per IP as well, so it cannot be turned into a mail-bomb aimed at a stranger.
  if (action === 'forgot') {
    const ip = clientIp(req);
    const limited = await rateLimit(`forgot:${ip}`, { max: 5, windowMs: 15 * 60 * 1000 });
    if (!limited.allowed) return tooManyResponse(res, limited.retryAfterMs);

    const { email } = await readJson(req);
    const normalized = String(email ?? '').trim().toLowerCase();
    if (normalized) {
      const { rows } = await query(
        `SELECT u.id, u.tenant_id, t.business_name, t.owner_email
           FROM users u JOIN tenants t ON t.id = u.tenant_id
          WHERE lower(u.email) = $1`,
        [normalized],
      );
      const user = rows[0];
      if (user) {
        const { token } = await createPasswordReset(user.id, user.tenant_id);
        const link = `${appUrl()}/app?reset=${token}`;
        const sent = await emailPasswordReset({
          to: user.owner_email || normalized,
          businessName: user.business_name,
          link,
        });
        // Never log the link itself: function logs are visible to anyone with
        // access to the deployment, and the link is enough to take over the
        // account. With no mail provider the operator can mint one from the
        // dashboard instead, so only the fact of the failure is recorded.
        if (!sent) {
          console.log(`Password reset mail not delivered for ${normalized} (provider not configured or rejected).`);
        }
      }
    }
    json(res, 200, {
      ok: true,
      emailConfigured: emailConfigured(),
      emailReady: emailReady(),
      note: 'Agar ye email registered hai, to reset link bhej diya gaya hai.',
    });
    return;
  }

  // Finish the reset: a single-use token plus a new password.
  if (action === 'reset') {
    const { token, password } = await readJson(req);
    // Validate the password shape before spending the token, so a too-short
    // password does not burn the link and force another email.
    if (typeof password !== 'string' || password.length < 8) {
      throw new HttpError(400, 'Password must be at least 8 characters');
    }
    const reset = await consumePasswordReset(String(token ?? ''));
    if (!reset) throw new HttpError(400, 'Ye reset link galat hai ya purana ho gaya. Dobara maangein.');
    await setUserPassword(reset.user_id, password);
    json(res, 200, { ok: true });
    return;
  }

  if (action !== 'login') throw new HttpError(400, `Unknown action: ${action}`);

  const { email, password } = await readJson(req);
  const normalized = String(email ?? '').trim().toLowerCase();
  if (!normalized || !password) throw new HttpError(400, 'email and password are required');

  // Two keys, so neither a single account nor a single IP can be hammered: an
  // attacker spraying many accounts is caught by the IP key, and one who
  // focuses on one account is caught by the email key.
  const ip = clientIp(req);
  for (const key of [`login:ip:${ip}`, `login:email:${normalized}`]) {
    const limited = await rateLimit(key, { max: 10, windowMs: 15 * 60 * 1000 });
    if (!limited.allowed) return tooManyResponse(res, limited.retryAfterMs);
  }

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

  // A correct password clears the counters, so a real owner who mistyped a few
  // times is not locked out after they get it right.
  await Promise.all([
    clearRateLimit(`login:ip:${ip}`),
    clearRateLimit(`login:email:${normalized}`),
  ]);

  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  const { token, expiresAt } = await createSession(user.id, user.tenant_id);
  res.setHeader('Set-Cookie', sessionCookie(token, expiresAt));
  json(res, 200, { ok: true });
});
