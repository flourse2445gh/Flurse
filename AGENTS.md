# BudsBox — repo notes

Multi-tenant WhatsApp ordering SaaS. One platform, many shops. Each shop
connects its own Meta WhatsApp Cloud API number; BudsBox turns inbound
messages into orders and shows them in a dashboard. 14-day trial, then three
tiers, each monthly or yearly — Starter ₹999/month (₹9,990/year), Growth
₹1,999/month (₹19,990/year) and Pro ₹3,999/month (₹39,990/year), yearly being
ten months' price so two months are free. Each plan carries a fair-use
allowance of AI replies per month (Starter 1,500, Growth 4,000, Pro 10,000).

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
- `npm test` — runs `node --test tests/*.test.js` against a real Postgres
  (`TEST_DATABASE_URL`, default `postgres://budsbox:budsbox@localhost:5432/budsbox_test`).
  The DB may be a sidecar (`grep ':1538 ' /proc/net/tcp` — hex for 5432 — then
  pass that host) or, when no sidecar is running, a local cluster:
  ```
  export PGBIN=/usr/lib/postgresql/17/bin
  sudo mkdir -p /var/lib/pgtest && sudo chown postgres:postgres /var/lib/pgtest
  sudo -u postgres $PGBIN/initdb -D /var/lib/pgtest -U b --auth=trust
  sudo -u postgres $PGBIN/pg_ctl -D /var/lib/pgtest -l /tmp/pg.log -o "-p 5432" start
  sudo -u postgres $PGBIN/psql -h 127.0.0.1 -U b -d postgres -c "create database budsbox_test;"
  sudo -u postgres $PGBIN/psql -h 127.0.0.1 -U b -d postgres -c "create role budsbox login password 'budsbox' superuser;"
  ```
  Run the suite in a clean env (`env -i PATH="$PATH" HOME="$HOME" …`) so an
  exported prod `DATABASE_URL` cannot point the tests at production.
- `npm run migrate` — applies `db/schema.sql`. **Also run it against production
  after a schema change** (pull the prod `DATABASE_URL` from Vercel env), or the
  new code queries columns that do not exist yet.

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
- **Auto-renewal (Razorpay Subscriptions).** `action=subscribe` opens a monthly
  mandate: `ensureMonthlyPlan()` finds or creates a monthly plan for the plan
  price (plans are immutable, so the amount is part of the lookup) and
  `createSubscription()` enrols the shop for 120 months. The subscription id is
  stored on `tenants.razorpay_subscription_id` and in a `subscriptions` row, so
  a renewal webhook can find the shop without trusting the body. `action=webhook`
  handles `subscription.charged`/`activated` by re-fetching the subscription and
  setting `paid_until` to Razorpay's `current_end` — the shop stays active with
  no operator action. `subscription.halted`/`cancelled` suspends the shop and
  clears the access token, same as a trial expiry, so a dead mandate cannot keep
  serving free. The browser flow returns `subscriptionId`, which goes to
  Razorpay checkout as `subscription_id` (not `order_id`).
- **Plans live in `lib/plans.js`.** One place holds the price, the period and
  the fair-use allowance, so the checkout, the dashboard and the usage counter
  cannot drift apart. Three tiers, each monthly or yearly: `starter_monthly`
  (₹999, 1,500 replies), `growth_monthly` (₹1,999, 4,000), `pro_monthly`
  (₹3,999, 10,000), and `starter_yearly` / `growth_yearly` / `pro_yearly` at
  exactly ten months' price (₹9,990 / ₹19,990 / ₹39,990), so two months are
  free. Only the monthly plans are `recurring`, so they are the only ones
  `action=subscribe` accepts; a yearly plan is a one-time `action=checkout`. A
  plan that is not `recurring` is refused with 400, which keeps a yearly
  purchase from silently becoming a monthly mandate. `DEFAULT_PLAN`
  (`starter_monthly`) is what an unbilled shop is counted against, so a trial
  never gets a bigger allowance than it paid for.
- **Fair use caps AI spend without ever silencing a shop.** Each plan includes
  `aiReplies` — 1,500 on Starter, 4,000 on Growth, 10,000 on Pro — model-written
  replies a month.
  `messages.ai_reply` marks only the turns where a model actually wrote the
  reply; a greeting or a payment-QR answer is free and never counts.
  `createOrderFromMessage()` counts the month's stamped turns and passes
  `aiAllowed` down to `parseOrder()` and `draftReply()`; past the allowance both
  fall back to the deterministic keyword matcher. The shop keeps replying to
  every customer, the number never goes quiet, and the cost of a heavy shop
  stays bounded and known. The dashboard shows the running count.
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
  land in the same columns.
  - **Disconnect has two levels, and the difference is what Meta allows.** The
    DELETE on `/api/whatsapp` is *AI pause*: credentials are kept, the status
    gate stops replies, and one click brings the number back. **Release**
    (`POST /api/whatsapp?action=release`, button *Number wapas lo*) is leaving
    for good: it calls Meta's `POST /{phone-number-id}/deregister`, which stops
    the number working with Cloud API, then clears the credentials. Meta offers
    **no API to delete a number** — deleting it from the portfolio, the step
    that frees it for the normal WhatsApp app, is WhatsApp Manager only, and a
    number used for paid messages in the last 30 days can only be deleted after
    those 30 days. So the UI does the API half and walks the owner through the
    WhatsApp Manager half in place (`waReleaseDone`); it never claims the number
    is already back to normal. The operator panel has the same release button
    (`POST /api/admin?action=release`), for a shop that has gone quiet.
    A failed deregister still clears the local side and reports `metaReleased:
    false`, so the owner is never trapped by a Meta hiccup.
  - The leaving controls (`waDisconnectBox`) are hidden until a number is
    connected, so an unconnected shop is not offered a disconnect.
  - Meta side: create a Facebook Login for Business configuration from the
    *WhatsApp embedded sign-up configuration with 60-day expiry token* template
    and add every hosting domain to **Allowed domains** and **Valid OAuth
    redirect URIs**. Domains are a list — add a new one later without removing
    the old, and the Meta app id and config id do not change.
  - **Allowed domains takes a bare host** (`budsbox.vercel.app`), while the
    redirect URI takes a full URL (`https://budsbox.vercel.app/app`). A scheme
    or trailing slash in the allowed-domains box silently breaks the popup.
  - `WHATSAPP_API_VERSION` must be recent for Embedded Signup v4; it is `v27.0`
    in production, not the old `v21.0` default.
  - Production has `WHATSAPP_APP_ID` and `WHATSAPP_ES_CONFIG_ID` set, so the
    one-click button is the live path. Running the flow needs the app admin's
    own Meta credentials, so it cannot be covered by the test suite beyond the
    stubbed Graph calls.
  - `WHATSAPP_MANUAL_CONNECT=true` re-exposes the hand-paste form while
    Embedded Signup is configured. Shop owners should only ever see **Connect
    with Facebook**; the form is an operator escape hatch for connecting a
    number before Meta approves the portfolio for ES.
  - **When the popup returns no `phone_number_id`, say what to do, not why.**
    Meta sends `FINISH_ONLY_WABA` when the owner finished without adding a
    number; that is the common case and it is the owner's to fix, so the tab
    names the fix inline (`waEsError`, which stays on the page — a toast is
    gone in 2.6s). Portfolio verification is a Meta-side step and is only
    mentioned after a second failed try, so the first message does not send the
    owner down the wrong path.
  - **A silent webhook is almost always a missing `subscribed_apps` call, not
    a code bug.** If inbound messages never reach the DB, check
    `GET /{waba-id}/subscribed_apps` — the WABA is often subscribed to a
    different app (e.g. a sandbox "WA DevX Webhook Events 1P App") and never to
    this one. Fix with `POST /{waba-id}/subscribed_apps`. The handshake can
    return 200 the whole time, so a healthy `GET /api/webhook` proves nothing
    about delivery.
  - **Test numbers only deliver to an allowed recipient list** (max 5). Sends
    to anyone else fail with `(#131030) Recipient phone number not in allowed
    list`. Add the number under *API Setup → To → Manage phone number list*.
    The inbound message still arrives and the AI still generates a reply, so
    the failure shows up only in the send step — the inbox gets an inbound row
    with no matching outbound row.
  - **The token expires 60 days after Embedded Signup, and nothing used to
    watch it.** `lib/wahealth.js` is the one place that decides whether a
    connection is at risk. `exchangeSignupCode` returns `{ accessToken,
    expiresAt }` (Meta's `expires_in`); the ES path stores `wa_token_expires_at`
    and clears any old error. The manual path stores no expiry (the operator
    owns that token). Every webhook send calls `recordSendOutcome`, which keeps
    `wa_last_error` / `wa_last_error_kind` on the tenant (cleared on success),
    so a 401 that kills sends early is caught too. `connectionAlert` turns that
    into the banner: `token_dead` (kind `token`/`permission` — an error),
    `token_expired` (error), `token_expiring` (within `TOKEN_WARN_DAYS`, a
    warning) or `send_failed` (a non-recipient failure). The dashboard exposes
    it as `tenant.waAlert`; `/api/whatsapp` as `alert`; `app.html` renders it in
    `#waBanner` and the WhatsApp tab. The daily cron logs expiring shops.
    `sendWhatsApp*` errors carry `httpStatus` and Meta's `code`, because a bare
    message cannot tell a dead token (401/190) from one bad recipient (131030).
    A `token_expiring` alert only appears when an expiry is stored, so a shop
    connected by hand before this change shows no false warning.
- **A new order reaches the owner, not just the dashboard.** `createOrderFromMessage`
  returns a `newOrder` flag (true only on the first insert, so a follow-up that
  adds details never re-alerts). The dashboard carries a live "naya order" badge
  plus a bell: it counts orders newer than `tenants.orders_seen_at`
  (`unseenOrderCount` in `lib/orders.js`), `GET /api/dashboard` returns it as
  `tenant.unseenOrders`, and `POST /api/dashboard?seen=1` calls `markOrdersSeen`
  to move the watermark.
  - **The badge + bell are the primary alert and need no signup, key or
    account.** `app.html` polls its own `/api/dashboard` every 15s
    (`startOrderWatch`/`refreshQuietly`); when `unseenOrders` grows it plays
    `public/assets/order-bell.mp3` and shows a toast, then marks the orders
    seen. It is a local file played by the browser — no Meta call, no message,
    no AI request — so the alert costs nothing, which is the whole point. The
    bell is unlocked on the first click/keypress (browsers block audio until
    the user interacts, and the owner always has by logging in), the very first
    load stays silent (orders were already waiting), the poll pauses while the
    tab is hidden, and the owner can mute it (🔔/🔕, remembered in
    `localStorage.bb_sound`). A WebAudio two-tone beep is the fallback if the
    file cannot play.
  - **Email is an optional extra, never a dependency.** When `RESEND_API_KEY`
    is set, `api/webhook.js` also calls `emailNewOrder` from `lib/notify.js`
    best-effort, after the reply is queued, so an email outage cannot break a
    reply. Without a key the email is simply skipped and nothing on screen nags
    the owner about it — the badge and bell are the product.
  - **A delivery due tomorrow is shown on screen, not only messaged.**
    `ordersDueTomorrow` (IST calendar day) feeds `tenant.dueTomorrow` on
    `GET /api/dashboard`, and `renderDueBanner` in `app.html` lists it with the
    unpaid count. This matters because the two push channels both have holes: a
    free-form WhatsApp message is rejected outside the 24-hour window, and the
    email fallback needs `RESEND_API_KEY`. The banner needs neither — no
    account, no key, nothing to configure — so a reminder is never silently
    lost to a log line. It is a view of live data, not a one-shot, so it keeps
    showing until the order is delivered or its date moves.
- **A delivery date is a day, not an hour.** `guessDeliveryAt` (in `lib/ai.js`)
  runs after the model, as a deterministic backstop so a wrong day cannot reach
  the kitchen. It reads a clock only when the text carries a marker (`6 baje`,
  `18:30`, `shaam 6`) — a bare number is never an hour, which is what keeps
  "15 tarikh ko chahiye" from being stored as 3pm today. A named day
  ("15 tarikh", "15 August", "august 15") is resolved against the IST calendar
  day, rolling to next month or next year when that day has already passed, and
  gets a default 11:00 IST slot when no time is given. A vague window
  ("agle hafte", "next week") stores nothing so the reply flow asks. The order
  prompt also states today's date in IST, not UTC — `toISOString()` is a day
  behind after 5:30am IST, which silently shifted relative dates.
- **A new shop is not born empty.** `lib/samples.js` seeds eight common flower
  items on onboarding (`is_sample = true`), so the first customer message can
  become an order. `api/products.js` returns `is_sample` and clears it on the
  first owner edit, which is the cue the dashboard uses to drop the "sample
  price" hint.
- **Delivery-day reminder, once.** `ordersNeedingReminder(now)` finds delivery
  orders due in the next 24h that have never been reminded; `markReminderSent`
  stamps `reminder_sent_at` so a reminder never repeats. `customerWindowOpen`
  checks whether an inbound message in the last 24h keeps WhatsApp's free-form
  window open. When it is open the cron sends the customer a WhatsApp text;
  when it is shut it emails the owner instead (`lib/notify.js`), because a
  template message would cost money the zero-credit rule forbids. Both queries
  cast the timestamp parameter (`$1::timestamptz`) — without it Postgres cannot
  compare a bound parameter against `interval`.
- Design system lives in `public/assets/app.css`; the landing page uses the
  Tailwind CDN with the BudsBox theme inlined in its `<head>`. The theme there
  defines `brand`, `brandDark`, `wa` and `waDark`; a class that uses a colour
  the config does not define renders in the default ink colour, so add the
  colour before using it.
- **The landing page and the pay modal show the same three plans, two ways.**
  A Monthly/Yearly toggle rewrites every price from its own `data-mo` /
  `data-yr` (landing) or filters the catalogue by `billing` (modal), so only
  three prices ever show at once and the two screens cannot disagree. A yearly
  card carries a yearly-only line — "Mahine ka sirf ₹833 · ₹1,998 bachat" —
  derived from the price, so the owner sees the per-month equivalent and the
  saving without doing the division. Yearly is ten months' price, so the
  "2 mahine free" claim is always true; a test asserts it.
- **Every card carries a helper-vs-plan saving, in both periods.** The line
  reads "Sabse sasta helper (₹8,000) se bhi ₹7,001/mahina bachat" and swaps to
  the yearly figure with the toggle, so the monthly view gets the same value
  message the yearly view has. The figure is arithmetic against the *cheapest*
  helper (₹8,000/mahina), never a range's top end — a comparison that can only
  under-sell. Yearly saving is `8000×12 − yearly price`, monthly is
  `8000 − monthly price`. A test recomputes both from the prices, so a price
  change cannot leave a stale number on the page.
- **`public/app.html` loads plain `app.css`, not Tailwind.** Utility classes
  there (`rounded-full`, `bg-ink/5`, `text-[12px]`) are undefined and render
  unstyled. Add a component class to `app.css` (`.period`, `.value-note`)
  instead. Only `index.html` has the Tailwind CDN.
- `/admin` is **locked by default**: with `ADMIN_SECRET` unset the admin API
  answers 401 and the panel shows only the gate. Set `ADMIN_SECRET` in Vercel
  and redeploy to open it with that password. An unset secret never means open
  access, so a forgotten env var cannot expose every shop.
- Webhook replies are best-effort: the message is stored before the send is
  attempted, so an outage never loses a shop's reply.

## Agent runtime notes (not BudsBox app code)

- The agent server is a **hosted runtime**, not `localhost:8001`. Use
  `$RUNTIME_URL` (e.g. `https://<runtime-id>.prod-runtime.all-hands.dev`) and
  authenticate with `X-Session-API-Key` read from PID 1's environment.
  `localhost:8001` is unreachable here, so the local Agent Canvas recipe
  does not apply.
- MCP servers are registered through the agent-server settings API, not a
  JSON file: `POST /api/settings/mcp/{name}` with
  `{url, transport, headers}`; `transport` is `streamable-http`. Secrets go
  through `PUT /api/settings/secrets` as `{name, value}`. Header values may
  reference a secret as `${NAME}` and the server expands it at connect time.
- `POST /api/mcp/test` validates a candidate server without persisting it and
  returns the advertised tool names on success. Use it to verify before saving.
- The `21st` MCP server (`https://21st.dev/api/mcp`) is registered and its
  config persists. It stays unauthenticated until a secret named
  `API_KEY_21ST` exists; a live test then reaches 21st.dev and fails only with
  its own "not authenticated" message, which is the expected signal that the
  wiring is correct.

## Lifecycle rule: suspend by status, never by clearing the token

A suspended shop must keep `wa_access_token`. The **status gate** is what stops
it replying: `api/webhook.js` drops any tenant that is not `trialing`/`active`,
`assertTenantWritable` refuses manual replies and order edits, and the reminder
cron only selects `trialing`/`active`. Clearing the token was never required for
that, and it broke the one promise the product is sold on: a shop that pays
after its trial lapsed came back `status='active'` with no token, so it could
not send a single message. `expireTrials` (lib/trial.js) and
`applySubscriptionState` (api/payments.js) now keep the token; only the
operator's **Disconnect** and the shop's own DELETE on `/api/whatsapp` clear it,
because those are the two places that genuinely mean "forget this number".
`a shop that pays after its trial lapses gets its number working again` in
tests/e2e.test.js is the regression guard — it lapses a shop, proves it is
quiet, pays, and proves the same inbound message becomes an order again.

## Rate limiting lives in Postgres, not in memory

The login and reset-request endpoints are the two unauthenticated doors that
take a guessable secret, so both are capped by `lib/ratelimit.js`. The counter
is a `rate_limits` row, not an in-process `Map`: a Vercel function is frozen
between requests and runs as several copies, so an in-memory counter would
reset on every cold start and never be shared across instances. The upsert in
`rateLimit()` is one atomic statement, so two concurrent requests cannot both
read the old count. Login is keyed by **both** IP and email (10 / 15 min) so an
attacker can neither hammer one account from many IPs nor spray many accounts
from one; a correct password calls `clearRateLimit` so a real owner who
mistyped is not locked out. The reset request is keyed per IP (5 / 15 min) so it
cannot be used to spray a stranger's inbox. Any new unauthenticated endpoint
that takes a secret or sends mail must call `rateLimit()` too.

## Email goes out over Gmail until a domain exists

`lib/notify.js` sends owner alerts and password-reset links. A Resend key alone
is not enough: the shared `onboarding@resend.dev` sender is refused with a 403
for every address but the Resend account owner's, so a shopkeeper who forgot
their password would never receive the link. `vercel.app` cannot fix this
either — it is Vercel's domain, so its DNS records cannot be edited to verify it
with Resend.

So `sendEmail` has two transports and prefers the first that can actually reach
a recipient:
1. **Resend**, only when `RESEND_API_KEY` is paired with an `EMAIL_FROM` on a
   domain we own (`resendCanReachAnyone()`). Verifying the domain later switches
   this on with no code change.
2. **Gmail SMTP** (`GMAIL_USER` + `GMAIL_APP_PASSWORD`, an App Password, not the
   account password). Google signs it with its own SPF/DKIM, so it reaches any
   recipient and lands in the inbox. This carries mail until a domain exists.

`emailReady()` is the honest signal: it is true only when a transport can reach
anyone, and the forgot endpoint and screen report it. A failed send logs only
the fact of the failure — never the reset link, which is enough to take over an
account and is visible to anyone with access to the deployment logs.

A Gmail App Password is **exactly 16 letters** (Google shows it as four groups
of four). A longer value is almost always the account password pasted by
mistake, and Gmail answers every send with `535 Username and Password not
accepted`, which reads like a server fault. `gmailReady()` therefore requires the
sanitized value to be exactly 16 letters, and the failure log prints the account
and the sanitized length (never the secret) — that is what located the bad
value. When a Gmail send starts failing, check that length first.

## Never email a stranger's address

`startt.47@gmail.com` is **not the owner's mailbox** — it was a throwaway used
once to test signup, and sending mail to it reaches a third party. Do not put it
in code, tests, seed data, or a manual send. Test mail only against the account
owner's own address (`startt.247@gmail.com`), which is also the only address a
bare Resend key can reach.

## Free replies: the questions that repeat are answered without a model

`lib/replies.js` answers the questions a florist gets all day — price, payment,
address, timings, delivery, order status — from the shop's own catalog and
profile, with no model call at all. The payment-QR shortcut was the first of
these; this is the same idea generalised, and it is where most of a shop's AI
cost would otherwise go.

The rules that keep it safe:
- Only a clear question is answered free. `freeIntent()` finds the topic and
  `looksLikeOrder()` vetoes it: a message that asks for something ("2 roses bhej
  do", "ek bouquet chahiye") always goes through the normal parse, so its items
  and delivery details are never lost to save a paisa.
- A topic with nothing written down (no address on file) returns null and the
  model takes over, so a missing field never becomes a wrong or empty reply.
- `createOrderFromMessage` skips `parseOrder` entirely for a pure question, so
  the saving is real and not just the reply call.
- The free path is surfaced as `source: 'free'` in the dashboard preview, with
  the wording "AI credit kharch nahi hua", so the owner can see it working.

Keep the intent order in `lib/replies.js` (payment, status, location, hours,
delivery, then price) — price last so "delivery kitna?" is a delivery question,
not a price one.

## Bouquet photos, delivered photos and the free-reply photo (still zero AI)

`lib/photos.js` stores two kinds of picture — a product's bouquet photo and an
order's delivered photo — as a data URL on the row, and serves them publicly at
`GET /api/shop?product=<token>` and `GET /api/shop?delivery=<token>`, exactly
like the payment QR (same file, because the Hobby plan caps `api/` at 12
functions; the token keeps each image unguessable). Uploads are
`POST /api/shop?photo` (`{product_id, image}`) and `POST /api/shop?delivery-photo`
(`{order_id, image}`), PNG/JPEG/WebP data URLs under 400 KB.

- **A price question about a named bouquet is answered with its photo.** The
  free path already priced the item; `freePhotoTarget()` in `lib/replies.js`
  returns the first named item on a *price* question, `api/webhook.js` resolves
  its URL and sends the price as the image caption. Still no model call. If the
  image send fails the code falls back to the text reply, so a picture problem
  never costs the customer their answer. `createOrderFromMessage` returns
  `photoItem` for this; nothing is sent when the shop uploaded no photo.
- **The delivered photo is sent once, when the order is fulfilled.** The owner
  uploads it on the Orders row (the `delivery_photo_token` is set), then
  `sendDeliveryPhoto` fires on `status=fulfilled` (or the explicit
  `POST /api/dashboard?order_id=..&send-photo=1`). `delivery_photo_sent_at`
  keeps a second click from sending it twice. It is best-effort: a failed photo
  never undoes the status change.

## Occasion memory: the birthday that brings the customer back

A flower shop lives on repeat orders, and the repeat is an occasion.
`lib/occasions.js` reads the birthday/anniversary a card message already names
("Happy Birthday Rahul, 15 August") using the same Indian-calendar reader the
order parser uses, and stores it in `customer_occasions` (idempotent on tenant +
customer + kind + date). Capture is best-effort and never blocks the reply
(`createOrderFromMessage` fires it without awaiting).

- Only a clear occasion word **and** a date are remembered — "meri mummy ka
  birthday aa raha hai" with no date stores nothing, so nothing is guessed.
- The date is stored as an IST calendar day; the year is irrelevant, because a
  birthday repeats. `upcomingOccasions`/`tenantsWithUpcomingOccasions` resolve
  the month/day against the current year (rolling to next year once it has
  passed, and folding 29 Feb to the 28th), so the cron and the dashboard agree.
- The owner sees them on the Customers tab and is emailed by the daily cron
  (`emailOccasionReminder`) within `OCCASION_LEAD_DAYS` (5). `reminded_on` keeps
  the hourly cron from nudging the same occasion twice; the dashboard dismiss is
  `POST /api/dashboard?occasions-seen`.

## Festival broadcasts: the owner's words, sent honestly

`lib/broadcasts.js` sends one owner-written message to the whole customer list —
Diwali and Valentine's are where a flower shop makes its year. The owner writes
it, so **no model call**. `POST /api/dashboard?broadcast` creates the job and its
per-recipient rows; `POST /api/dashboard?broadcast-run=<id>` sends the next batch
(`runBroadcast`, bounded) and the dashboard re-invokes it while `remaining > 0`,
so one serverless call never has to reach 500 customers.

- WhatsApp only accepts a free-form message within 24h of the customer's last
  message. Recipients outside that window are recorded `skipped` with the reason
  — never silently dropped. `audience=open_window` is the safe default;
  `repeat` targets customers with 2+ orders.
- The history reports `sent_count` / `skipped_count` / `failed_count` per job, so
  the owner is told how many people actually got the offer instead of a single
  "sent" that hides the truth.

## The customer list (CRM)

`lib/customers.js` backs `GET /api/conversations?customers`: one row per
customer with order count, lifetime spend, last order, and the next occasion,
sorted by spend. The Chats tab shows threads as they happen; this is the asset
underneath them, and it is what makes a repeat order possible.
