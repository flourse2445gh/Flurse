// Minimal router that maps /api/* to the Vercel-style handlers in api/,
// so the app can be exercised with plain `node scripts/dev-server.js`.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { loadEnv } from './load-env.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
await loadEnv(join(root, '.env'));

const ROUTES = {
  '/api/onboard': 'api/onboard.js',
  '/api/auth': 'api/auth.js',
  '/api/webhook': 'api/webhook.js',
  '/api/dashboard': 'api/dashboard.js',
  '/api/admin': 'api/admin.js',
  '/api/payments': 'api/payments.js',
  '/api/health': 'api/health.js',
  '/api/cron/trial': 'api/cron/trial.js',
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const server = createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');

  if (ROUTES[pathname]) {
    try {
      const mod = await import(join(root, ROUTES[pathname]));
      await mod.default(req, res);
    } catch (err) {
      console.error(err);
      if (!res.writableEnded) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: 'Dev server error' }));
      }
    }
    return;
  }

  // Static files from public/
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\//, '');
  try {
    const file = await readFile(join(root, 'public', rel));
    res.setHeader('Content-Type', MIME[extname(rel)] || 'application/octet-stream');
    res.end(file);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
});

const port = process.env.PORT || 3000;
server.listen(port, () => console.log(`BudsBox dev server on http://localhost:${port}`));
