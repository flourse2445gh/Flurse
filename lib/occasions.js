// Occasion memory: the birthday and anniversary a florist's repeat business is
// built on.
//
// A flower shop does not live on one order; it lives on the same customer
// coming back every year. The date is the whole asset. The AI already reads the
// card message ("Happy Birthday Rahul") to write the reply, so the date can be
// remembered from the same message that carries it, and the owner is reminded a
// few days before — enough time to call the customer and take the order.
//
// Capture is best-effort and deterministic: a date the customer states is read
// by the same Indian-calendar reader the order parser uses. Nothing here calls
// a model.

import { query } from './db.js';
import { guessDeliveryAt } from './ai.js';

// Days before the occasion that the owner is told, so there is time to act.
export const OCCASION_LEAD_DAYS = 5;

const KIND_LABEL = {
  birthday: 'Birthday',
  anniversary: 'Anniversary',
  other: 'Occasion',
};

// The kind of occasion a message is about, from the words a customer actually
// types on a card. Only an explicit word counts; "happy" alone is not enough.
const BIRTHDAY_RE = /\b(?:birthday|bday|b'?day|janamdin|janam din|sal?girah)\b|जन्मदिन|बर्थडे/i;
const ANNIVERSARY_RE = /\b(?:anniversary|marriage day|shaadi ki saal?girah)\b|सालगिरह|एनिवर्सरी/i;

export function occasionKind(text) {
  const t = String(text || '');
  if (BIRTHDAY_RE.test(t)) return 'birthday';
  if (ANNIVERSARY_RE.test(t)) return 'anniversary';
  return null;
}

// A recipient name the card names, so the reminder can say whose birthday it is
// ("Rahul ji ka birthday"). The phrase is matched case-insensitively, but the
// name itself must look like a name (a single capitalised word), so "birthday
// aa raha hai" does not turn "aa" into a person.
export function occasionName(text) {
  const m = String(text || '').match(
    /\b(?:happy\s+(?:birthday|anniversary)|birthday|anniversary)\b\s+([A-Za-z]{2,20})\b/i,
  );
  if (!m) return null;
  return /^[A-Z][a-z]{1,19}$/.test(m[1]) ? m[1] : null;
}

// The date an occasion falls on, read from the customer's own words ("15
// August", "kal", "5 tarikh"). Reuses the order parser's Indian-calendar reader
// so a date means the same thing everywhere, and never guesses when nothing is
// stated. Returns an IST calendar day (YYYY-MM-DD), which is the day a florist
// would write on the card.
export function occasionDate(text, now = new Date()) {
  const at = guessDeliveryAt(text, now);
  if (!at) return null;
  const ist = new Date(new Date(at).getTime() + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
}

// Records the occasion for a customer when a message clearly names one and a
// date. Idempotent on (tenant, customer, kind, date), so the same card message
// handled twice — or the customer repeating it — leaves one row. Returns the
// row it created or found, or null when the message is not an occasion.
export async function rememberOccasion({ tenantId, customerId, text, now = new Date() }) {
  if (!customerId) return null;
  const kind = occasionKind(text);
  if (!kind) return null;
  const onDate = occasionDate(text, now);
  if (!onDate) return null;

  const { rows } = await query(
    `INSERT INTO customer_occasions (tenant_id, customer_id, kind, label, on_date, note)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, customer_id, kind, on_date) DO NOTHING
     RETURNING id, kind, on_date`,
    [tenantId, customerId, kind, KIND_LABEL[kind], onDate, occasionName(text)],
  );
  return rows[0] ?? { kind, on_date: onDate };
}

// Occasions coming up within the lead window, for the owner. Month and day are
// compared, not the year, because a birthday repeats every year. The date math
// is done here rather than in SQL: the same expression feeds both the reminder
// and the dashboard, and keeping it in one place means they cannot disagree
// about what "within five days" means. A 29 February occasion is pinned to the
// 28th in a non-leap year instead of throwing.
export async function upcomingOccasions(tenantId, now = new Date()) {
  const { rows } = await query(
    `SELECT o.id, o.kind, o.label, to_char(o.on_date, 'YYYY-MM-DD') AS on_date, o.note,
            c.id AS customer_id, c.display_name, c.wa_id,
            (SELECT COUNT(*)::int FROM orders od WHERE od.customer_id = c.id) AS order_count,
            (SELECT COALESCE(SUM(od.total_cents), 0)::int FROM orders od
              WHERE od.customer_id = c.id AND od.status <> 'cancelled') AS spend_cents
       FROM customer_occasions o
       JOIN customers c ON c.id = o.customer_id
      WHERE o.tenant_id = $1
        AND (o.reminded_on IS NULL OR o.reminded_on < $2::date)`,
    [tenantId, istDay(now)],
  );

  return rows
    .map((r) => ({ ...r, daysAway: daysUntil(r.on_date, now) }))
    .filter((r) => r.daysAway >= 0 && r.daysAway <= OCCASION_LEAD_DAYS)
    .sort((a, b) => a.daysAway - b.daysAway)
    .slice(0, 50)
    .map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      onDate: r.on_date,
      daysAway: r.daysAway,
      note: r.note,
      customerId: r.customer_id,
      customerName: r.display_name,
      waId: r.wa_id,
      orderCount: r.order_count,
      spendCents: r.spend_cents,
    }));
}

// How many days until an occasion next falls, counting today as zero. The date
// is resolved against the current IST year (not the year it was first written,
// which may be long past), and rolls to next year once it has passed, so the
// number is never negative for an upcoming occasion.
function daysUntil(onDate, now) {
  const today = istDate(now);
  const [, m, d] = String(onDate).slice(0, 10).split('-').map(Number);
  const thisYear = occasionInYear(today.getUTCFullYear(), m, d, today.getUTCFullYear());
  const next = thisYear < today
    ? occasionInYear(today.getUTCFullYear() + 1, m, d, today.getUTCFullYear() + 1)
    : thisYear;
  return Math.round((next - today) / 86_400_000);
}

// The occasion's date in a given year, with 29 February folded to the 28th when
// the year is not a leap year, so the comparison never throws.
function occasionInYear(year, month, day) {
  const m = Number.isFinite(month) && month >= 1 && month <= 12 ? month : 1;
  let d = Number.isFinite(day) && day >= 1 ? day : 1;
  const lastDay = new Date(Date.UTC(year, m, 0)).getUTCDate();
  if (d > lastDay) d = lastDay;
  return new Date(Date.UTC(year, m - 1, d));
}

// Today's Indian calendar day as a UTC midnight Date, so all comparisons are in
// whole days and never drift across the IST offset.
function istDate(now) {
  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  return new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
}

// Today's Indian calendar day as YYYY-MM-DD, for the `reminded_on` comparisons.
// Passed as text so Postgres does not reinterpret it in the server's timezone.
export function istDay(now = new Date()) {
  return istDate(now).toISOString().slice(0, 10);
}

// Every tenant that has an occasion in the lead window, so the daily cron can
// group the work by shop. Filtered in JS by the same `daysUntil`, so the cron
// and the dashboard always agree on what is coming up.
export async function tenantsWithUpcomingOccasions(now = new Date()) {
  const { rows } = await query(
    `SELECT t.id, t.slug, t.business_name, t.owner_email,
            to_char(o.on_date, 'YYYY-MM-DD') AS on_date
       FROM tenants t
       JOIN customer_occasions o ON o.tenant_id = t.id
      WHERE t.status IN ('trialing', 'active')
        AND (o.reminded_on IS NULL OR o.reminded_on < $1::date)`,
    [istDay(now)],
  );
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    const days = daysUntil(r.on_date, now);
    if (days < 0 || days > OCCASION_LEAD_DAYS) continue;
    seen.add(r.id);
    out.push({ id: r.id, slug: r.slug, business_name: r.business_name, owner_email: r.owner_email });
  }
  return out;
}

// Stamps today so the same occasion is not nudged on every cron run. Only the
// rows actually listed are stamped, so nothing is silently swallowed.
export async function markOccasionsReminded(ids, day = new Date()) {
  if (!ids.length) return;
  await query(
    'UPDATE customer_occasions SET reminded_on = $2::date WHERE id = ANY($1::uuid[])',
    [ids, istDay(day)],
  );
}
