// What a shop buys, in one place: the checkout, the dashboard and the fair-use
// counter all read from here, so a price or an allowance changes once.
//
// Prices are paise, like every other amount in the app. `aiReplies` is the
// monthly fair-use allowance of AI-written replies; past it a shop still
// answers every customer, but from the keyword matcher, which costs nothing.
// That is what keeps the worst-case cost of a shop bounded and known.

export const PLANS = {
  starter_monthly: {
    name: 'Starter Monthly',
    tier: 'Starter',
    billing: 'monthly',
    priceCents: 99900,
    currency: 'INR',
    days: 30,
    aiReplies: 2000,
    recurring: true,
  },
  pro_monthly: {
    name: 'Pro Monthly',
    tier: 'Pro',
    billing: 'monthly',
    priceCents: 199900,
    currency: 'INR',
    days: 30,
    aiReplies: 10000,
    recurring: true,
  },
  starter_yearly: {
    name: 'Starter Yearly',
    tier: 'Starter',
    billing: 'yearly',
    priceCents: 999900,
    currency: 'INR',
    days: 365,
    aiReplies: 2000,
    recurring: false,
  },
  pro_yearly: {
    name: 'Pro Yearly',
    tier: 'Pro',
    billing: 'yearly',
    priceCents: 1999900,
    currency: 'INR',
    days: 365,
    aiReplies: 10000,
    recurring: false,
  },
};

// A shop that has not chosen yet is counted against the cheapest plan, so a
// brand-new trial is never handed a bigger allowance than it paid for.
export const DEFAULT_PLAN = 'starter_monthly';

export function getPlan(id) {
  return PLANS[id] ?? null;
}

export function planList() {
  return Object.entries(PLANS).map(([id, p]) => ({ id, ...p }));
}
