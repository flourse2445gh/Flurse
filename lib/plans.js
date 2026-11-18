// What a shop buys, in one place: the checkout, the dashboard and the fair-use
// counter all read from here, so a price or an allowance changes once.
//
// Prices are paise, like every other amount in the app. Three tiers, each
// billed monthly or yearly (yearly is ten months' price, so two months free).
//
// `aiReplies` is the monthly fair-use allowance of model-written replies. Past
// it a shop still answers every customer from the keyword matcher, which costs
// nothing, so the number never goes quiet and the worst-case cost of a shop is
// bounded and known. At the measured cost of ~₹0.016 a reply, even the top
// tier's full allowance is a small slice of its price.
//
// Only the monthly plans are recurring: they are the ones Razorpay can charge
// again on its own.

export const PLANS = {
  starter_monthly: {
    name: 'Starter',
    tier: 'Starter',
    billing: 'monthly',
    priceCents: 99900,
    currency: 'INR',
    days: 30,
    aiReplies: 1500,
    recurring: true,
  },
  growth_monthly: {
    name: 'Growth',
    tier: 'Growth',
    billing: 'monthly',
    priceCents: 199900,
    currency: 'INR',
    days: 30,
    aiReplies: 4000,
    recurring: true,
  },
  pro_monthly: {
    name: 'Pro',
    tier: 'Pro',
    billing: 'monthly',
    priceCents: 399900,
    currency: 'INR',
    days: 30,
    aiReplies: 10000,
    recurring: true,
  },
  starter_yearly: {
    name: 'Starter',
    tier: 'Starter',
    billing: 'yearly',
    priceCents: 999000,
    currency: 'INR',
    days: 365,
    aiReplies: 1500,
    recurring: false,
  },
  growth_yearly: {
    name: 'Growth',
    tier: 'Growth',
    billing: 'yearly',
    priceCents: 1999000,
    currency: 'INR',
    days: 365,
    aiReplies: 4000,
    recurring: false,
  },
  pro_yearly: {
    name: 'Pro',
    tier: 'Pro',
    billing: 'yearly',
    priceCents: 3999000,
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
