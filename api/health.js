import { query } from '../lib/db.js';
import { handler, json, requireMethod } from '../lib/http.js';

// GET /api/health — liveness + database reachability.
export default handler(async (req, res) => {
  if (!requireMethod(req, res, ['GET'])) return;

  let db = 'ok';
  try {
    await query('SELECT 1');
  } catch (err) {
    db = `error: ${err.message}`;
  }

  const healthy = db === 'ok';
  json(res, healthy ? 200 : 503, {
    status: healthy ? 'ok' : 'degraded',
    db,
    version: process.env.npm_package_version ?? '1.0.0',
    time: new Date().toISOString(),
  });
});
