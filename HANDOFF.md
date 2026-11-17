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
- `npm test` (node --test). **67 tests** hain, sab pass hone chahiye.
- Postgres chahiye. Pehle ek **sidecar Postgres** `172.17.0.2:5432` par chalta
  tha (localhost refuse kar sakta hai). Sidecar na ho to local cluster chalao:
  ```
  export PGBIN=/usr/lib/postgresql/17/bin
  sudo mkdir -p /var/lib/pgtest && sudo chown postgres:postgres /var/lib/pgtest
  sudo -u postgres $PGBIN/initdb -D /var/lib/pgtest -U b --auth=trust
  sudo -u postgres $PGBIN/pg_ctl -D /var/lib/pgtest -l /tmp/pg.log -o "-p 5432" start
  sudo -u postgres $PGBIN/psql -h 127.0.0.1 -U b -d postgres -c "create database budsbox_test;"
  sudo -u postgres $PGBIN/psql -h 127.0.0.1 -U b -d postgres -c "create role budsbox login password 'budsbox' superuser;"
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
- `lib/` — ai.js (reply+parse), auth.js, db.js, http.js, notify.js (owner
  email), orders.js, plans.js, razorpay.js, samples.js (starter catalog),
  trial.js, wahealth.js (token-expiry watch), whatsapp.js
- `public/` — admin.html, app.html, index.html, assets/
- `db/schema.sql`, `vercel.json`, `tests/e2e.test.js`, `scripts/`

## Jo kaam HO CHUKA hai (dobara mat banao)
- Multi-tenant backend + **67 passing tests**
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
- **Naye order par owner ko alert (koi signup nahi)** — naya order aane par
  dashboard pe "naya order" badge aur **order chime** (local sound file, zero AI
  credit, koi account/key nahi) jo dekhne par clear hote hain. Email optional
  hai (`RESEND_API_KEY` mile to hi bhejta hai, warna chup-chaap skip)
- **Nayi shop ka starter catalog** — signup par 8 common flower items seed hote
  hain (`is_sample` flag), taaki pehla message hi order ban sake
- **Delivery-day reminder** — kal delivery wale order ko ek reminder; WhatsApp
  24-ghante window khuli ho to customer ko, warna owner ko email
- Trial cron: expired trial -> auto suspend + token revoke, token watch, aur
  delivery reminders (daily 03:00 IST)

## Jo ABHI BAAKI hai (asli launch blockers, is order me)
1. **Email provider ka key lagana.** Owner-alert email ka poora code ready aur
   tested hai, par `RESEND_API_KEY` set hone tak bhejta nahi (dashboard badge
   phir bhi chalta hai, aur app "Email alerts off" bata deta hai). User se
   Resend key maango aur Vercel env me daalo, phir redeploy karo.
2. **Landing page copy update** — ab jo features live hain (owner email alert,
   starter catalog, delivery reminder) unhe landing page par add karo, aur jo
   nahi hai wo mat likho (sach ka rule).
3. **Meta number live karna** — App Mode abhi "Development" hai, isliye sirf
   test numbers ko reply jaata hai. Live customers ke liye Business Verification
   + App Review chahiye (user ke account par).

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

> "Upar ka context padh lo. Owner-alert email ke liye RESEND_API_KEY maango,
> phir landing page copy update karo (jo features ab live hain). Tests chalane
> ke baad deploy karke live par dikhao."
