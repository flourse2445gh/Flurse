import { query } from './db.js';

// A small fixed-window limiter for the two unauthenticated doors that take a
// guessable secret: login (a password) and the reset request (an email that
// sends mail). Without it, anyone can sit and guess a password or use BudsBox
// to spray reset mails at a stranger.
//
// The counter lives in Postgres, not in memory: a serverless function is frozen
// between requests and runs as many copies, so an in-process Map would reset on
// every cold start and never be shared. The upsert below is a single atomic
// statement, so two concurrent requests cannot both read the old count.
export async function rateLimit(key, { max, windowMs }) {
  const { rows } = await query(
    `INSERT INTO rate_limits (key, count, window_start)
          VALUES ($1, 1, now())
     ON CONFLICT (key) DO UPDATE
            SET count = CASE
                          WHEN rate_limits.window_start < now() - ($2::bigint * interval '1 millisecond')
                          THEN 1
                          ELSE rate_limits.count + 1
                        END,
                window_start = CASE
                          WHEN rate_limits.window_start < now() - ($2::bigint * interval '1 millisecond')
                          THEN now()
                          ELSE rate_limits.window_start
                        END
      RETURNING count, window_start`,
    [key, windowMs],
  );
  const { count, window_start: windowStart } = rows[0];
  const allowed = count <= max;
  const retryAfterMs = allowed
    ? 0
    : windowMs - (Date.now() - new Date(windowStart).getTime());
  return { allowed, retryAfterMs: Math.max(retryAfterMs, 0) };
}

// A clean slate after a good login, so a legit owner who fat-fingered their
// password a few times is not locked out once they get it right.
export async function clearRateLimit(key) {
  await query('DELETE FROM rate_limits WHERE key = $1', [key]);
}

// Best-effort client address for per-IP keys. Vercel sets x-forwarded-for; the
// first entry is the caller.
export function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress ?? 'unknown';
}

export function tooManyResponse(res, retryAfterMs) {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  res.statusCode = 429;
  res.setHeader('Retry-After', String(seconds));
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({
    error: `Bahut zyada koshish. Thodi der baad try karein (${seconds}s).`,
  }));
}
