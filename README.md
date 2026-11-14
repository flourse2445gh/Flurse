# BudsBox

Multi-tenant WhatsApp ordering SaaS. Each shop connects its own WhatsApp number and
gets an AI assistant that turns customer messages into structured orders in a
dashboard. Shops start on a 3-day free trial; when it ends the platform
automatically disconnects the number until the shop upgrades.

## What works today

- Shop self-onboarding + secure login (scrypt password hashing, signed session cookies)
- WhatsApp Cloud API webhook: signature verification, message receipt, AI reply
- AI order parsing (OpenAI when configured, deterministic catalog parser otherwise)
- Per-shop dashboard: orders, revenue, customer counts, status updates
- Hourly-style cron that expires overdue trials and auto-disconnects those shops
- Operator panel: all shops, live status, order counts, trial countdown
- Stubbed plan upgrade that reactivates a suspended shop

## Layout

```
api/                    serverless functions (one file per route)
  onboard.js            shop self-registration (starts the trial)
  auth.js               login / logout / session
  webhook.js            Meta webhook: verify (GET) + inbound messages (POST)
  dashboard.js          per-shop orders, summary, status updates
  admin.js              operator view (cross-tenant), bearer-secret gated
  payments.js           plan list + stubbed upgrade
  health.js             liveness + database reachability
  cron/trial.js         trial expiry -> suspend + disconnect
lib/                    shared code
  db.js                 Postgres pool
  auth.js               password hashing + sessions
  whatsapp.js           Cloud API send + signature verification
  ai.js                 order parsing
  trial.js              trial window + expiry
  orders.js             order persistence
  http.js               request helpers, error handling
db/schema.sql           Postgres schema (run once)
public/                 static frontend
  index.html            landing page
  app.html              shop signup / login / dashboard
  admin.html            operator panel
scripts/                migrate, dev server, env loader
tests/e2e.test.js       end-to-end tests against a real Postgres
```

## Setup

1. **Database** — create a Postgres database, then run `npm run migrate`
   (or paste `db/schema.sql` into your provider's SQL editor).
2. **Env** — copy `.env.example` to `.env` and fill it in.
3. **Run** — `npm run dev` serves the API and `public/` on port 3000.
4. **Test** — `npm test` (needs `TEST_DATABASE_URL`, defaults to
   `budsbox_test` on localhost).
5. **WhatsApp** — point the Meta app webhook at `https://<domain>/api/webhook`
   and use `WHATSAPP_VERIFY_TOKEN` as the verify token.

## Key environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `SESSION_SECRET` | signs shop session cookies |
| `ADMIN_SECRET` | operator panel + admin API (falls back to `CRON_SECRET`) |
| `WHATSAPP_VERIFY_TOKEN` | Meta webhook verification |
| `WHATSAPP_APP_SECRET` | verifies inbound webhook signatures |
| `WHATSAPP_ACCESS_TOKEN` | sends replies via the Cloud API |
| `OPENAI_API_KEY` | AI order parsing (falls back to the catalog parser) |
| `TRIAL_DAYS` | trial length, default `3` |
| `CRON_SECRET` | protects the trial cron |

## Security notes

- Inbound webhooks are trusted only after HMAC signature verification.
- Every dashboard query is scoped by the session's `tenant_id`, so one shop can
  never read or mutate another's orders.
- Sessions are `HttpOnly` cookies holding a random token; only its hash is stored.
- Payment upgrade is stubbed and captures nothing — wire a real PSP before
  taking money.
