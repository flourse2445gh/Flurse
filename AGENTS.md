# BudsBox — repo notes

Multi-tenant WhatsApp ordering SaaS. One platform, many shops. Each shop
connects its own Meta WhatsApp Cloud API number; BudsBox turns inbound
messages into orders and shows them in a dashboard. 3-day trial, then
₹599/month.

## Layout

- `api/` — Vercel serverless functions (products, conversations, whatsapp,
  dashboard, webhook, onboard, admin, payments, cron, health)
- `lib/` — shared code (db, auth, whatsapp, ai, orders, trial, http)
- `public/` — static frontend: `index.html` (landing), `app.html` (shop
  dashboard), `admin.html` (operator panel), `assets/app.css` + `app.js`
- `db/schema.sql` — Postgres schema
- `scripts/dev-server.js` — local dev server (loads `.env`)
- `tests/e2e.test.js` — end-to-end API tests

## Commands

- `npm run dev` — dev server on :3000, uses `.env` (local Postgres)
- `npm test` — runs `node --test tests/*.test.js` against the local DB
- `npm run migrate` — applies `db/schema.sql`

## Deploy

- Vercel project `flowers`, aliased to `https://flowers-one-puce.vercel.app`.
- The project is **not** linked to GitHub (`link: null`), so a `git push`
  does not trigger a build. Deploy from the CLI instead:
  `vercel --prod --yes --token "$Vercel_token"` from the repo root (the
  `.vercel/project.json` id is `prj_7VyDNo8e35coEjEmh6KLksbH9Kmf`,
  team `team_KzNJiOJKwipHpImVp8JH6OSf`). Relinking Git needs a Vercel
  account "Login Connection" first.
- Production DB is Neon; connection string is in the Vercel env
  (`DATABASE_URL`). Local dev uses the local Postgres in `.env`.

## Conventions

- **Money is stored in paise** (`price_cents`, `total_cents`); the currency
  column is always `INR`. Rupee inputs are multiplied by 100 on write.
- **Tenant scoping**: every table carries `tenant_id`; every API query
  filters on the session's tenant. Never trust a client-supplied tenant id.
- **Landing page copy must match reality.** Do not advertise features the
  code does not implement. Current honest claims: catalog-based AI order
  parsing, auto confirmation reply, WhatsApp-style inbox, catalog manager,
  booking dashboard, multi-tenant isolation, Cloud API connect/disconnect.
  Do NOT claim: QR/Linked-Devices pairing, same-day detection, budget-based
  bouquet suggestions, UPI payment links, or a `/join?shop=` route.
- **WhatsApp connect** is done by pasting a Meta *Phone number ID* +
  *Access token* in the app's WhatsApp tab. **Disconnect** is the DELETE on
  `/api/whatsapp`, surfaced in that tab and as a header chip (`waChip`).
- Design system lives in `public/assets/app.css`; the landing page uses the
  Tailwind CDN with the BudsBox theme inlined in its `<head>`.
- `/admin` runs **open** while `ADMIN_SECRET` is unset: no login, and
  `ADMIN_SECRET` is what gates it once set (`CRON_SECRET` no longer does).
  Set `ADMIN_SECRET` in Vercel and redeploy to lock the panel.
- Webhook replies are best-effort: the message is stored before the send is
  attempted, so an outage never loses a shop's reply.
