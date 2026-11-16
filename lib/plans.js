// What a shop buys, in one place: the checkout, the dashboard and the fair-use
// counter all read from here, so a price or an allowance changes once.
//
// Prices are paise, like every other amount in the app. `aiReplies` is the
// monthly fair-use allowance of AI-written replies; past it a shop still
// answers every customer, but from the keyword matcher, which costs nothing.
// That is what keeps the worst-case cost of a shop bounded and known.

export const PLANS = {
  starter: {
    name: 'Pro Monthly',
    priceCents: 99900,
    currency: 'INR',
    days: 30,
    aiReplies: 2000,
    recurring: true,
  },
  yearly: {
    name: 'Pro Yearly',
    priceCents: 999900,
    currency: 'INR',
    days: 365,
    aiReplies: 2000,
    recurring: false,
  },
};

export function getPlan(id) {
  return PLANS[id] ?? null;
}

export function planList() {
  return Object.entries(PLANS).map(([id, p]) => ({ id, ...p }));
}
