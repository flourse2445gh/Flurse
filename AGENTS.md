# BudsBox — repo notes

Multi-tenant WhatsApp ordering SaaS. One platform, many shops. Each shop
connects its own Meta WhatsApp Cloud API number; BudsBox turns inbound
messages into orders and shows them in a dashboard. 3-day trial, then
₹599/month.

## Layout

- `api/` — Vercel serverless functions (products, conversations, whatsapp,
  dashboard, webhook, onboard, admin, payments, cron, health, shop). `shop.js`
  carries the shop-profile settings and the `?preview` reply check
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
- The Vercel plan is **Hobby, capped at 12 serverless functions**. `api/` is at
  that limit, so a new endpoint must be folded into an existing file (see
  `api/shop.js`, which serves both settings and `?preview`) rather than added
  as a 13th file.
- Provider keys in Vercel are marked **sensitive**, so `vercel env pull` writes
  `[SENSITIVE]` placeholders for them — they cannot be read back locally. To
  check them, deploy and use `/api/shop?preview`, whose response lists each
  provider's failure reason.

## Conventions

- **Money is stored in paise** (`price_cents`, `total_cents`); the currency
  column is always `INR`. Rupee inputs are multiplied by 100 on write.
- **Tenant scoping**: every table carries `tenant_id`; every API query
  filters on the session's tenant. Never trust a client-supplied tenant id.
- **AI providers** (`lib/ai.js`): a chain of OpenAI-compatible providers plus
  Gemini, tried in order — gemini, groq, cerebras, openrouter, openai — and the
  first that answers wins, so one exhausted quota does not silence the shop.
  Model defaults live in the `PROVIDERS` table; override per provider with
  `GEMINI_MODEL`, `GROQ_MODEL`, `CEREBRAS_MODEL`, `OPENROUTER_MODEL`,
  `OPENAI_MODEL`. Each provider's base URL can be redirected with
  `*_BASE_URL` (used by tests). Keys are read with a trim/quote-strip
  (`keyFor`), because dashboard pastes often carry whitespace. With no keys
  configured the deterministic keyword matcher takes over, so tests and local
  dev run without the network.
- **Language matching**: the reply is written in the customer's own language —
  English, Hinglish (Roman-script Hindi), or Hindi (Devanagari) — detected by
  `detectLanguage`. The language instruction is restated at the end of the
  user turn, because `shop_tone` may itself mention a language and would
  otherwise drag an English reply into Hinglish.
- **Greeting and length**: a first message that is only a hello ("Hi", "hii",
  "namaste") is answered with a fixed short greeting — `Hi! Kya chahiye aapko? 😊`
  (Devanagari hello gets `Hi! क्या चाहिए आपको? 😊`) — with no provider call, so it
  never drifts and never costs a request. The word "Namaste" is deliberately not
  used. Every other reply is asked to stay within 1-10 words with exactly one
  emoji, and `ensureTrailingEmoji` moves a mid-sentence emoji to the very end,
  because models like to drop it in the middle.
- **Order vs chat**: only a message that names catalog items creates an order.
  Small talk is still stored and answered, but never becomes a ₹0 order. The
  inbound `wa_message_id` is claimed in `messages` first, so a Meta retry
  produces neither a second order nor a second reply.
- **Shop profile** (`/api/shop`): address, hours, delivery, tone and extra
  instructions are fed to the model so a reply sounds like the owner. The same
  endpoint's `?preview` action drafts a sample reply using the live providers,
  which is also how you check that keys and model names still work.
- **Landing page copy must match reality.** Do not advertise features the
  code does not implement. Current honest claims: catalog-based AI order
  parsing, human-sounding replies that match the customer's language
  (English/Hinglish/Hindi), automatic failover across several AI providers,
  WhatsApp-style inbox, catalog manager, shop-profile settings, booking
  dashboard, multi-tenant isolation, Cloud API connect/disconnect.
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
