# BudsBox — Handoff Prompt (new conversation me paste karo)

> Neeche `=====` ke beech ka poora text copy karke nayi OpenHands conversation me
> paste kar do. Bas.

=====

## Tumhara kaam
Repo `flourse2445gh/Flurse`, branch `phase-1-backend`. Ye **BudsBox** hai —
flower shops ke liye multi-tenant WhatsApp ordering SaaS. Sab kuch already
ban chuka hai aur **live** hai. Tumhe sirf naya kaam karna hai, zero se kuch
nahi banana.

**Sabse pehle ye padho:** `AGENTS.md` (repo root) aur `README.md`. Inme
deploy, conventions aur architecture likha hai. Wahi sach hai.

## Live setup (abhi yahi chal raha hai)
- Live URL: `https://flowers-one-puce.vercel.app`
  - `/` landing, `/app` shop dashboard, `/admin` operator panel, `/api/health`
- Vercel project: `flowers`, id `prj_7VyDNo8e35coEjEmh6KLksbH9Kmf`,
  team `team_KzNJiOJKwipHpImVp8JH6OSf`
- DB: Neon Postgres (connection string Vercel env `DATABASE_URL` me)
- **`/admin` abhi OPEN hai** — koi password nahi. `ADMIN_SECRET` env set karne
  par panel khud lock ho jata hai (code change ki zaroorat nahi). User ne
  jaan-boojh kar abhi open rakha hai kyunki wo test kar raha hai.

## Deploy kaise hota hai (IMPORTANT)
- Ye Vercel project GitHub se **linked NAHI** hai. Isliye `git push` se
  deploy **nahi** hota.
- Deploy karne ke liye repo root se:
  ```
  vercel --prod --yes --token "$Vercel_token"
  ```
  (`.vercel/project.json` me project id already hai)
- `vercel` CLI agar na ho: `sudo npm i -g vercel` then
  `sudo ln -sf /usr/local/lib/node_modules/vercel/dist/vc.js /usr/local/bin/vercel`
- Env variable badla ho to **naya deploy zaroori** hai, warna purani value chalti rahegi.
- Git push: remote URL me token inline karo —
  `git push https://flourse2445gh:${GITHUB_TOKEN}@github.com/flourse2445gh/Flurse.git phase-1-backend:phase-1-backend`

## Test kaise chalate hain
- `npm test` (node --test). 39 tests hain, sab pass hone chahiye.
- Postgres chahiye. Docker is env me kaam nahi karta. Isliye:
  ```
  sudo apt-get install -y postgresql
  PGBIN=/usr/lib/postgresql/17/bin
  sudo mkdir -p /var/lib/pgtest && sudo chown postgres:postgres /var/lib/pgtest
  sudo -u postgres $PGBIN/initdb -D /var/lib/pgtest -U b --auth=trust
  sudo -u postgres $PGBIN/pg_ctl -D /var/lib/pgtest -l /tmp/pg.log -o "-p 5432" start
  sudo -u postgres $PGBIN/psql -h 127.0.0.1 -U b -d postgres -c "create database budsbox_test;"
  TEST_DATABASE_URL="postgres://b@127.0.0.1:5432/budsbox_test" npm test
  # kaam ke baad: sudo -u postgres $PGBIN/pg_ctl -D /var/lib/pgtest stop -m fast
  ```

## Code kahan hai
- `api/` — admin, auth, conversations, dashboard, health, onboard, payments,
  products, shop (profile + `?preview`), webhook, whatsapp, cron/trial.
  **Vercel Hobby par sirf 12 functions allowed hain** aur `api/` already 12 par
  hai — naya endpoint banane ke bajaye kisi purani file me jodo.
- `lib/` — ai.js (reply+parse), auth.js (scrypt, 7-day session), db.js,
  http.js, orders.js, trial.js, whatsapp.js
- `public/` — admin.html, app.html, index.html, assets/
- `db/schema.sql`, `vercel.json`, `tests/e2e.test.js`, `scripts/`

## Jo kaam HO CHUKA hai (dobara mat banao)
- Multi-tenant backend + 39 passing tests
- Operator panel: saari shops, trial countdown, order count,
  Suspend / Activate / Disconnect / Export CSV
- Shop dashboard: orders, catalog (rupees), chat inbox, manual reply
- WhatsApp Cloud API webhook: signature verify, idempotent, message -> order
- Trial cron: expired trial -> auto suspend + token revoke (daily 03:00 IST)
- Shop owner khud "Phone number ID + Access token" paste karke WhatsApp connect
  karta hai; Disconnect bhi hai
- Plan upgrade ka **stub** — suspended shop ko wapas active karta hai

## Jo ABHI BAAKI hai (is order me karo)
1. **Order me address / delivery date-time / pickup-or-delivery / customer
   name + phone** — abhi `orders` table me sirf items + total hai. Bina address
   ke phool deliver nahi hote. AI ko bhi sikhana hai ye message se nikalna
   ("kal shaam 6 baje, 12 Gandhi Road").
2. ~~**Asli AI reply**~~ **HO GAYA.** `lib/ai.js` ab gemini → groq → cerebras →
   openrouter → openai chain chalata hai; jo pehle jawab de wo jeet gaya. Reply
   **customer ki bhasha** me (English/Hinglish/Hindi) aata hai. Vercel par
   `GEMINI_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`
   lagi hain. `CEREBRAS_API_KEY` abhi **nahi** hai (optional).
   - **Dhyan do:** model ke naam badalte rehte hain. Live par `/api/shop?preview`
     chalao — response me har provider ka fail reason aata hai (404 = model
     purana, 429 = quota khatam, 401 = key galat). Model override ke liye
     `GEMINI_MODEL` / `GROQ_MODEL` / `OPENROUTER_MODEL` / `OPENAI_MODEL` env.
   - Vercel par AI keys **sensitive** hain, isliye `vercel env pull` unki jagah
     `[SENSITIVE]` likhta hai — local par verify nahi ho sakta, sirf deploy ke
     baad `?preview` se.
   - Shop profile (address/hours/delivery/tone) `/api/shop` se save hota hai aur
     AI use karta hai taaki reply asli dukaandaar jaisa lage.
3. **Meta Embedded Signup** — abhi manual token paste hai, jo shop owner ke
   liye bahut mushkil hai. Isko proper signup flow banana hai.
4. **Payment QR** — owner apna UPI QR upload karta hai; customer "payment kaise
   karu?" likhe to wo QR seedha chala jaata hai, bina AI credit. (Razorpay/PSP
   se automatic capture abhi bhi baaki hai.)
5. **Asli payment capture (Razorpay/PSP)** — abhi order par `payment_status`
   (unpaid/paid/refunded) hai aur owner khud "Mark paid" karta hai UPI transfer
   dekh kar. Automatic capture nahi hai: PSP wire karna baaki hai.
6. **Brand naam** — code me BudsBox 25 jagah, OrderBuds 1 jagah. Sab
   **BudsBox** karna hai.

## Jo sirf USER kar sakta hai (tum nahi kar sakte, usse maango)
- OpenAI API key dena (Vercel env me daalne ke liye)
- Meta WhatsApp Business / Facebook Developer app banana (Embedded Signup ke liye)
- Razorpay account + keys
- ADMIN_SECRET lagana jab live jana ho

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
- Badlav ke baad **`npm test` chalao** — sab 33 pass hone chahiye.
- Phir `vercel --prod` se deploy karo aur live URL par curl/browser se verify karo.
- Commit message me `Co-authored-by: openhands <openhands@all-hands.dev>` daalo.
- Push/PR sirf jab user bole. PR #1, #2, #3 merge ho chuke hain; abhi koi PR open nahi.

=====

## Uske baad user kya likhe
Prompt paste karne ke baad ye line likh do:

> "Upar ka context padh lo. Pehle mera order-address wala kaam (#1) karo.
> Postgres setup karke tests chalao, phir deploy karke live par dikhao."
