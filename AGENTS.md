# BudsBox — repo notes

Multi-tenant WhatsApp ordering SaaS. One platform, many shops. Each shop
connects its own Meta WhatsApp Cloud API number; BudsBox turns inbound
messages into orders and shows them in a dashboard. 14-day trial, then
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

- Vercel project `flowers`, aliased to `https://budsbox.vercel.app`.
- The project is **not** linked to GitHub (`link: null`), so a `git push`
  does not trigger a build. Deploy from the CLI instead:
  `vercel --prod --yes --token "$Vercel_token"` from the repo root (the
  `.vercel/project.json` id is `prj_7VyDNo8e35coEjEmh6KLksbH9Kmf`,
  team `team_KzNJiOJKwipHpImVp8JH6OSf`). Relinking Git needs a Vercel
  account "Login Connection" first.
- **Do not use the dashboard "Redeploy" button to ship a change.** It rebuilds
  whichever deployment you clicked, so redeploying an older one silently rolls
  the live site back. Deploy from the CLI on a clean checkout of `main`
  instead, then check `https://budsbox.vercel.app/api/admin` still answers 401
  when `ADMIN_SECRET` is unset.
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
  otherwise drag an English reply into Hinglish. Detection counts Hinglish
  words, and any single word no English message uses ("chahiye", "gulab",
  "mujhe", "aap") is enough on its own — otherwise "rose chahiye" reads as
  English. Devanagari anywhere means Hindi.
- **Greeting and length**: a first message that is only a hello ("Hi", "hii",
  "namaste") is answered with a fixed short greeting — `Hi! Kya chahiye aapko? 😊`
  (Devanagari hello gets `Hi! क्या चाहिए आपको? 😊`) — with no provider call, so it
  never drifts and never costs a request. The word "Namaste" is deliberately not
  used.
- **Word budget (lifetime rule)**: a reply never carries more words than the
  customer's own message. `wordBudget(messageText)` counts the customer words and
  the prompt states that exact limit; `fitReply(reply, budget)` then trims any
  overshoot in code, so the rule holds even when the model ignores it. Emoji do
  not count as words, and `ensureTrailingEmoji` moves a mid-sentence emoji to the
  very end.
- **Emoji are occasional, not mandatory**: the prompt tells the model most
  replies should have no emoji at all, the way a real shopkeeper types. Do not
  add a rule that forces one on every reply.
- **Order vs chat**: only a message that names catalog items creates an order.
  Small talk is still stored and answered, but never becomes a ₹0 order. The
  inbound `wa_message_id` is claimed in `messages` first, so a Meta retry
  produces neither a second order nor a second reply.
- **Shop profile** (`/api/shop`): address, hours, delivery, tone, extra
  instructions and the shop's **UPI id** are fed to the model so a reply sounds
  like the owner. The same endpoint's `?preview` action runs the real order +
  reply path and drafts a sample reply using the live providers, which is also
  how you check that keys and model names still work.
- **Order details** (`orders` table): the AI fills `fulfilment`
  (delivery/pickup), `delivery_address`, `delivery_at`, `delivery_note`,
  `recipient_name` and `recipient_phone` from the thread. A later message that
  only adds an address or a time merges onto the customer's newest open order
  (`pending`/`confirmed`) instead of creating a new one. `guessDeliveryAt()`
  resolves "kal shaam 6 baje" in IST without the model, as a backstop.
- **Payment QR shortcut (no AI).** The shop owner uploads their own payment QR
  in Shop profile (`POST /api/shop?qr`, PNG/JPEG/WebP data URL, <=400 KB). It is
  stored as a data URL and served publicly at `GET /api/shop?qr=<token>` so WhatsApp
  can fetch it. When an inbound message looks like a payment question
  (`wantsPaymentInfo()` in `lib/whatsapp.js` — pay/upi/qr/scan/paisa/भुगतान…),
  the webhook sends that QR image with a short caption and **returns before any
  AI call**, so a payment question never spends a credit. The caption carries
  the payee name (`shop_payment_name`) so the customer can confirm the money
  reaches the right shop before paying. Falls back to the UPI
  id text if the image send fails. Only fires when a QR is uploaded; otherwise
  the normal AI reply handles it. `PUBLIC_BASE_URL` overrides the link base
  (falls back to Vercel's production URL).
- **Subscription billing via Razorpay.** `lib/razorpay.js` wraps the Orders API
  and both signature checks. `POST /api/payments?action=checkout` opens a
  checkout (records a `payments` row as `created`), `action=verify` settles the
  browser callback, and `action=webhook` (`payment.captured`) settles
  server-to-server, but its body is treated as a hint only: the payment is
  re-fetched from Razorpay and must be `captured`, belong to the named order,
  and match the recorded amount before anything activates. No shared webhook
  secret is kept, so a forged body can never buy a free activation. Both paths call
  `settle()`, which is idempotent on `razorpay_order_id`, so whichever arrives
  first activates the shop once. Activation sets `status='active'`, `plan`, and
  `paid_until` (extended from the later of now or the existing `paid_until`, so
  renewing early never loses days). `expireTrials()` also suspends an `active`
  tenant whose `paid_until` has passed. `action=upgrade` stays as a no-money
  stub but is refused once keys are configured, so it cannot skip payment in
  production. Amounts are paise, like orders.
- **Payment is manual and required before fulfilment.** Orders default to
  `payment_status = 'unpaid'`. The owner marks `paid` (or `refunded`) from the
  dashboard after the UPI transfer lands; `POST /api/dashboard?order_id=..&payment=1`
  does it. `POST` with `status=fulfilled` on an unpaid order returns **409**
  (`PAYMENT_REQUIRED`) — money before flowers. The dashboard also renders a
  tappable `upi://pay?...` link from the shop's UPI id. There is **no** PSP
  integration: nothing captures money automatically, and the AI only ever
  shares the shop's own UPI id, never asks for card/CVV/OTP.
- **Landing page copy must match reality.** Do not advertise features the
  code does not implement. Current honest claims: catalog-based AI order
  parsing, delivery details captured from the chat, human-sounding replies that
  match the customer's language (English/Hinglish/Hindi), automatic failover
  across several AI providers, WhatsApp-style inbox, catalog manager,
  shop-profile settings, booking dashboard with payment tracking, multi-tenant
  isolation, Cloud API connect/disconnect.
  Do NOT claim: automatic payment capture or a payment gateway, QR/Linked-Devices
  pairing, same-day detection, budget-based bouquet suggestions, or a
  `/join?shop=` route.
- **WhatsApp connect** has two paths. With `WHATSAPP_APP_ID` and
  `WHATSAPP_ES_CONFIG_ID` set, the tab shows **Connect with Facebook**
  (Embedded Signup): the browser sends the short-lived `code` plus the asset
  ids to `POST /api/whatsapp?action=embedded-signup`, and the server does the
  token exchange, the WABA `subscribed_apps` call and the phone-number lookup.
  The access token never reaches the page. Without those vars the tab falls
  back to pasting a Meta *Phone number ID* + *Access token* by hand. Both paths
  land in the same columns. **Disconnect** is the DELETE on `/api/whatsapp`,
  surfaced in that tab and as a header chip (`waChip`).
  - Meta side: create a Facebook Login for Business configuration from the
    *WhatsApp Embedded Signup* template and add every hosting domain to
    **Allowed domains** and **Valid OAuth redirect URIs**. Domains are a list —
    add a new one later without removing the old, and the Meta app id and
    config id do not change.
- Design system lives in `public/assets/app.css`; the landing page uses the
  Tailwind CDN with the BudsBox theme inlined in its `<head>`.
- `/admin` is **locked by default**: with `ADMIN_SECRET` unset the admin API
  answers 401 and the panel shows only the gate. Set `ADMIN_SECRET` in Vercel
  and redeploy to open it with that password. An unset secret never means open
  access, so a forgotten env var cannot expose every shop.
- Webhook replies are best-effort: the message is stored before the send is
  attempted, so an outage never loses a shop's reply.
