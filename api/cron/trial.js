import { expireTrials } from '../../lib/trial.js';
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
  console.log(`Trial cron suspended ${expired.length} tenant(s)`);
  json(res, 200, { suspended: expired.length, tenants: expired.map((t) => t.slug) });
});
