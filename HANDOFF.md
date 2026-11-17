# BudsBox — Handoff Prompt (new conversation me paste karo)

> Neeche `=====` ke beech ka poora text copy karke nayi OpenHands conversation me
> paste kar do. Bas.

=====

## Tumhara kaam
Repo `flourse2445gh/Flurse`, branch `gate-manual-whatsapp-connect`. Ye **BudsBox** hai —
flower shops ke liye multi-tenant WhatsApp ordering SaaS. Sab kuch already
ban chuka hai aur **live** hai. Tumhe sirf naya kaam karna hai, zero se kuch
nahi banana.

**Sabse pehle ye padho:** `AGENTS.md` (repo root) aur `README.md`. Inme
deploy, conventions aur architecture likha hai. Wahi sach hai.

## Live setup (abhi yahi chal raha hai)
- Live URL: `https://budsbox.vercel.app`
  - `/` landing, `/app` shop dashboard, `/admin` operator panel, `/api/health`
- Vercel project: `flowers`, id `prj_7VyDNo8e35coEjEmh6KLksbH9Kmf`,
  team `team_KzNJiOJKwipHpImVp8JH6OSf`
- DB: Neon Postgres (connection string Vercel env `DATABASE_URL` me)
- **`/admin` ab default LOCKED hai** — `ADMIN_SECRET` unset hone par admin API
  401 deta hai aur panel sirf gate dikhata hai. Panel kholne ke liye
  `ADMIN_SECRET` env set karo (Vercel) aur redeploy karo.

## Deploy kaise hota hai (IMPORTANT)
- Ye Vercel project GitHub se **linked NAHI** hai. Isliye `git push` se
  deploy **nahi** hota.
- Deploy karne ke liye repo root se:
  ```
  vercel --prod --yes --token "$Vercel_token"
  ```
  (`.vercel/project.json` me project id already hai). `npx --yes vercel@latest`
  bhi chal jata hai.
- **Schema badla ho to pehle prod DB par `db/schema.sql` chalao**, warna naya
  code naye columns dhoondhega aur 500 dega. Prod `DATABASE_URL` Vercel env se
  aata hai (wo **Config** hai, secret nahi, isliye `vercel env pull` se mil
  jaata hai); `PGSSLMODE=require` ke saath chalao.
- Env variable badla ho to **naya deploy zaroori** hai, warna purani value chalti rahegi.
- Git push: remote URL me token inline karo —
  `git push https://flourse2445gh:${GITHUB_TOKEN}@github.com/flourse2445gh/Flurse.git gate-manual-whatsapp-connect:gate-manual-whatsapp-connect`

## Test kaise chalate hain
- `npm test` (node --test). **61 tests** hain, sab pass hone chahiye.
- Postgres chahiye. Is env me ek **sidecar Postgres** `172.17.0.2:5432` par
  chalta hai (localhost refuse kar sakta hai). Isliye:
  ```
  TEST_DATABASE_URL="postgres://budsbox:budsbox@172.17.0.2:5432/budsbox_test" npm test
  ```
  Host dhoondhne ke liye `grep ':1538 ' /proc/net/tcp` (1538 = hex 5432).
- **Env leak se bacho:** prod `DATABASE_URL`/WhatsApp/Razorpay keys shell me
  export mat hone do, warna tests prod DB ko chhoo lete hain. Clean env me chalao:
  `env -i PATH="$PATH" HOME="$HOME" TEST_DATABASE_URL=... node --test tests/*.test.js`

## Code kahan hai
- `api/` — admin, auth, conversations, dashboard, health, onboard, payments,
  products, shop (profile + `?preview`), webhook, whatsapp, cron/trial.
  **Vercel Hobby par sirf 12 functions allowed hain** aur `api/` already 12 par
  hai — naya endpoint banane ke bajaye kisi purani file me jodo.
- `lib/` — ai.js (reply+parse), auth.js, db.js, http.js, orders.js, plans.js,
  razorpay.js, trial.js, wahealth.js (token-expiry watch), whatsapp.js
- `public/` — admin.html, app.html, index.html, assets/
- `db/schema.sql`, `vercel.json`, `tests/e2e.test.js`, `scripts/`

## Jo kaam HO CHUKA hai (dobara mat banao)
- Multi-tenant backend + **61 passing tests**
- Operator panel: saari shops, trial countdown, order count,
  Suspend / Activate / Disconnect / Export CSV
- Shop dashboard: orders, catalog (rupees), chat inbox, manual reply
- WhatsApp Cloud API webhook: signature verify, idempotent, message -> order
- **Asli AI reply** — gemini -> groq -> cerebras -> openrouter -> openai chain;
  customer ki bhasha (English/Hinglish/Hindi) me reply; per-plan fair-use
  allowance aur uske baad zero-cost keyword fallback (shop chup nahi hota)
- **Order me delivery details** — fulfilment (delivery/pickup), address,
  date-time, recipient name + phone; AI thread se nikalta hai
- **Money before flowers** — owner ka UPI QR "payment kaise karu?" par bina AI
  credit jaata hai; order paid hone tak fulfil nahi hota
- **Meta Embedded Signup** — one-click "Connect with Facebook" (token server par
  hi rehta hai); manual paste fallback bhi hai
- **Asli Razorpay** — monthly auto-renew mandate + one-time yearly payment;
  signed webhook hi sach hai, halted mandate shop ko suspend karta hai
- **WhatsApp token expiry watch** — 60-din token expire hone se 7 din pehle
  dashboard banner, aur send fail hone par turant alert (pehle chup-chaap band
  ho jata tha)
- Trial cron: expired trial -> auto suspend + token revoke (daily 03:00 IST)

## Jo ABHI BAAKI hai (is order me karo — asli launch blockers)
1. **Naye order par owner ko koi alert nahi jaata.** Abhi dukaandaar ko
   dashboard kholke dekhna padta hai. Ek naya order aaye to owner ko email
   (`owner_email` already store hota hai) ya dashboard pe live badge/notification
   milna chahiye. Ye ek **sabse bada launch gap** hai — iske bina trial shop
   ko faayda dikhta hi nahi.
2. **Nayi shop ka catalog khaali hota hai.** Order banane ke liye shop ko pehle
   apna catalog add karna padta hai. Naye shop ke liye kuch common flower items
   (gulab, bouquet, etc.) pre-seed karo, ya onboarding me ek chhota "add your
   first items" step jodo — warna AI pehle din kuch nahi kar payega.
3. **Order confirmation / delivery-day message** — abhi customer ko sirf reply
   aur QR jaata hai. Proper order confirmation aur delivery ke din ka reminder
   jodna hai (sirf tab jab landing page usko advertise kare — "sach" ka rule).

## Jo sirf USER kar sakta hai (tum nahi kar sakte, usse maango)
- Meta WhatsApp Business / Facebook Developer app (Embedded Signup ke liye) —
  ho chuka hai
- Razorpay account + keys — ho chuka hai
- ADMIN_SECRET lagana jab live jana ho
- Email bhejne ke liye ek SMTP/email provider (Resend/SendGrid/Brevo) ka key,
  agar owner ko order-alert email chahiye (baaki kaam #1 ke liye zaroori)

## Product ke sakht rules (kabhi na todo)
- WhatsApp **official Cloud API** hi — WhatsApp Web automation bilkul nahi
  (ban ho jata hai).
- Customer ko lagna chahiye ki wo **asli dukandaar** se baat kar raha hai.
  Koi "Meta AI" ya "bot" label nahi.
- Landing page ki copy **sach** honi chahiye. Jo feature code me nahi hai, wo
  advertise mat karo (ye rule AGENTS.md me detail me likha hai).
- Paisa **paise (cents)** me store hota hai, currency hamesha INR. Rupee input
  par 100 se multiply.
- Har table me `tenant_id` — har query session ke tenant par filter. Client ke
  bheje tenant id par kabhi bharosa mat karo.

## User kaise baat karta hai
- User Hindi/Hinglish me baat karta hai. Usse **Hindi me simple jawab** do.
- Wo non-technical hai: commands/technical detail kam, seedha "kya hua / kya
  karna hai" zyada.
- Kaam khatam hone par chhota summary table do + jo usse karna hai wo batao.

## Kaam karne ka tarika
- Chhote, focused changes. Jo already hai usse mat todna.
- Badlav ke baad **`npm test` chalao** — sab 61 pass hone chahiye.
- Schema badla ho to **prod DB par bhi** schema chalao.
- Phir `vercel --prod` se deploy karo aur live URL par curl/browser se verify karo.
- Commit message me `Co-authored-by: openhands <openhands@all-hands.dev>` daalo.
- Push/PR sirf jab user bole.

=====

## Uske baad user kya likhe
Prompt paste karne ke baad ye line likh do:

> "Upar ka context padh lo. Pehle mera #1 (naye order par owner ko alert) karo.
> Postgres setup karke tests chalao, phir deploy karke live par dikhao."
