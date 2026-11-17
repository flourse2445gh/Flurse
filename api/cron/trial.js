import { expireTrials } from '../../lib/trial.js';
import { expiringTokenTenants, TOKEN_WARN_DAYS } from '../../lib/wahealth.js';
import { handler, json, requireMethod, HttpError } from '../../lib/http.js';

// GET /api/cron/trial — invoked hourly by the Vercel cron in vercel.json.
// Vercel sends `Authorization: Bearer $CRON_SECRET` for scheduled runs.
export default handler(async (req, res) => {
  if (!requireMethod(req, res, ['GET', 'POST'])) return;

  const secret = process.env.CRON_SECRET;
  if (secret) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token !== secret) throw new HttpError(401, 'Unauthorized');
  }

  const expired = await expireTrials();

  // A Cloud API token lapses 60 days after it was issued. Watch that clock here
  // so a shop about to go silent is visible in the logs before its customers
  // notice, rather than only on the dashboard nobody opened.
  const expiring = await expiringTokenTenants();
  for (const t of expiring) {
    console.warn(
      `WhatsApp token for ${t.slug} expires ${new Date(t.wa_token_expires_at).toISOString()} `
      + `(within ${TOKEN_WARN_DAYS} days) — owner ${t.owner_email}`,
    );
  }

  console.log(`Trial cron suspended ${expired.length} tenant(s); ${expiring.length} token(s) expiring`);
  json(res, 200, {
    suspended: expired.length,
    tenants: expired.map((t) => t.slug),
    expiringTokens: expiring.map((t) => t.slug),
  });
});
