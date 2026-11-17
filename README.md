# BudsBox

Multi-tenant WhatsApp ordering SaaS. Each shop connects its own WhatsApp number and
gets an AI assistant that turns customer messages into structured orders in a
dashboard. Shops start on a 14-day free trial; when it ends the platform
automatically disconnects the number until the shop upgrades.

**Live:** https://budsbox.vercel.app — landing page, shop app at `/app`,
operator panel at `/admin`. Postgres runs on Neon, provisioned through the
Vercel marketplace.

## What works today

- Shop self-onboarding + secure login (scrypt password hashing, signed session cookies)
- WhatsApp Cloud API webhook: signature verification, idempotent message receipt
- One-click WhatsApp connect via Meta Embedded Signup (or hand-pasted ids)
- AI replies in the customer's own language (English / Hinglish / Hindi), with a
  per-plan fair-use allowance and a zero-cost keyword fallback past it, so a
  shop never goes silent
- Orders carry the delivery details the AI lifts from the thread — delivery or
  pickup, address, date-time, recipient name and phone
- A new order reaches the owner: an email with the full order, plus a "naya
  order" badge and a chime on the dashboard that clear once seen (the chime is
  a local sound file, so it costs no AI credit and no message)
- A new shop starts with a starter flower catalog, so the first customer message
  can become an order instead of "which flower?"
- A delivery due tomorrow gets one reminder to the customer (WhatsApp, while the
  24-hour window is open) or, failing that, an email to the owner
- Money before flowers: the shop's own UPI QR is sent on "payment kaise karu?"
  without spending an AI call, and an order is not fulfilled until it is marked
  paid
- Per-shop dashboard: orders, revenue, customer counts, chat inbox, catalog
- WhatsApp connection health: warns the owner before the 60-day token expires
  and flags a send that fails, instead of going quiet silently
- Cron that expires overdue trials and auto-disconnects those shops, logs
  tokens that are about to lapse, and sends delivery-day reminders
- Operator panel: all shops, live status, order counts, trial countdown
- Plan upgrade via Razorpay — a monthly auto-renew mandate or a one-time yearly
  payment — that reactivates a suspended shop

## Logging in

- **Shop owner:** open `/app` and log in, or click "Start free trial" to create a shop.
- **Operator (you):** open `/admin` and enter `ADMIN_SECRET`. Until that env
  var is set the panel is locked. From there you can see every shop, its trial
  countdown and order count, and **Disconnect**, **Suspend** or **Activate**
  any shop.
  - While `ADMIN_SECRET` is unset the panel is **locked** — the admin API
    answers 401 and only the gate shows, so a forgotten env var can never
    expose every shop.
  - Set `ADMIN_SECRET` in the Vercel env and redeploy to open it with that
    password. No code change is needed either way.

## Layout

```
api/                    serverless functions (one file per route)
  onboard.js            shop self-registration (starts the trial)
  auth.js               login / logout / session
  webhook.js            Meta webhook: verify (GET) + inbound messages (POST)
  dashboard.js          per-shop orders, summary, status updates
  admin.js              operator view (cross-tenant), bearer-secret gated
  payments.js           plan list + Razorpay checkout / verify
  health.js             liveness + database reachability
  cron/trial.js         trial expiry -> suspend + disconnect, token watch, delivery reminders
lib/                    shared code
  db.js                 Postgres pool
  auth.js               password hashing + sessions
  whatsapp.js           Cloud API send + signature verification + Embedded Signup
  wahealth.js           token-expiry / send-failure watch
  notify.js             owner alert + delivery-reminder email (Resend)
  samples.js            starter catalog for a new shop
  ai.js                 reply drafting + order parsing (provider chain)
  trial.js              trial window + expiry
  orders.js             order persistence
  plans.js              plan catalogue (prices + AI allowance)
  razorpay.js           checkout, subscriptions, webhook verification
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
6. **Embedded Signup** (optional) — set `WHATSAPP_APP_ID` and
   `WHATSAPP_ES_CONFIG_ID` from the Meta app, and shops can connect their
   number with one click instead of pasting ids by hand. See below.

## Key environment variables

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `SESSION_SECRET` | signs shop session cookies |
| `ADMIN_SECRET` | operator panel + admin API password (panel is locked while unset) |
| `WHATSAPP_VERIFY_TOKEN` | Meta webhook verification |
| `WHATSAPP_APP_SECRET` | verifies inbound webhook signatures |
| `WHATSAPP_ACCESS_TOKEN` | sends replies via the Cloud API |
| `WHATSAPP_APP_ID` | Embedded Signup app id (public) |
| `WHATSAPP_ES_CONFIG_ID` | Embedded Signup configuration id (public) |
| `OPENAI_API_KEY` | AI order parsing (falls back to the catalog parser) |
| `RESEND_API_KEY` | owner alert + delivery-reminder email (off = dashboard only) |
| `EMAIL_FROM` | sender for those emails (defaults to Resend's onboarding address) |
| `TRIAL_DAYS` | trial length, default `14` |
| `CRON_SECRET` | protects the trial cron |

## Security notes

- Inbound webhooks are trusted only after HMAC signature verification.
- Every dashboard query is scoped by the session's `tenant_id`, so one shop can
  never read or mutate another's orders.
- Sessions are `HttpOnly` cookies holding a random token; only its hash is stored.
- Embedded Signup: the browser only ever holds the short-lived `code` and the
  asset ids Meta returns. The exchange, the WABA subscription and the phone
  number lookup all run server-side, so the shop's access token never reaches
  the page.
- Razorpay is the source of truth for money: a checkout is only marked paid
  when the signed webhook says so, never when the browser says so. The monthly
  mandate is charged by Razorpay itself; a halted mandate suspends the shop
  rather than serving it free.
