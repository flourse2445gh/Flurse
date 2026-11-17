// Free replies: answers the shop can give from its own profile and catalog,
// with no model call. The payment-QR answer was the first of these; this
// generalises it, because the questions a florist actually gets all day
// ("kitna?", "kahan ho?", "kab khulta hai?", "delivery karte ho?") repeat, and
// none of them need a model. Every free answer is a call the shop does not pay
// for, and it leaves the model free for the messages that truly need one.
//
// A free answer is only given when the message is clearly a question about
// something the shop has written down. Anything else falls through to the
// normal path, so the shop never answers the wrong thing to save a paisa.

import { detectLanguage } from './ai.js';

const rupees = (cents) => `₹${(cents / 100).toFixed(0)}`;

// A question, in any of the three languages the shops write in. Used to keep a
// passing mention ("delivery kal kar dena") from being read as a question about
// delivery.
function isQuestion(text) {
  const t = String(text || '').toLowerCase();
  return /\?/.test(t)
    || /\b(?:kya|kyaa|kaise|kaisa|kaun|kab|kahan|kaha|kitna|kitne|kitni|hai kya|hain kya|do you|are you|is there|can you|where|when|how much|what is|open|timing|address)\b/.test(t)
    || /क्या|कैसे|कौन|कब|कहाँ|कहां|कितना|कितने|कितनी|कहा/.test(t);
}

// Checked in this order: a service question ("delivery kitna?") is answered by
// the service intent, and price is the fallback so it never steals a delivery
// or timing question. If the matching intent has nothing written down (no
// address on file, say), the free reply returns null and the model takes over.
const INTENT = {
  payment: /\b(?:pay|payment|upi|qr|scan|gpay|google ?pay|phonepe|paytm)\b|पैसा|पैसे|भुगतान|यूपीआई|क्यूआर/i,
  status: /\b(?:status|kab aayega|kab aayegi|kab pahunchega|kab pahunchegi|ready|taiyar|tayyar|confirm)\b|स्टेटस|कब आएगा|कब पहुंचेगा|तैयार/i,
  location: /\b(?:address|kahan|kaha|location|dukan|dukaan|store|jagah|where)\b|कहाँ|कहां|पता|दुकान|स्थान|एड्रेस/i,
  hours: /\b(?:timing|timings|khul|open|close|band|hours|samay|time)\b|समय|कब खुल|कब बंद|खुलता|बंद होता|टाइमिंग/i,
  delivery: /\b(?:deliver|delivery|pahunch|pahucha|pahuncha|courier)\b|डिलीवरी|पहुंच|कूरियर/i,
  price: /\b(?:price|rate|cost|daam|dam|kitna|kitne|kitni|charges?|how much|mrp)\b|कितना|कितने|कीमत|दाम|रेट|मूल्य/i,
};

// Intents that are unambiguous on their own, with or without a question mark:
// a customer who types "price?" or "kitna" is asking, not telling.
const SELF_EVIDENT = new Set(['price', 'payment', 'status']);

// A customer saying they have already paid must not be told to pay again. The
// free payment answer only fires when the money is still owed.
const ALREADY_PAID = /\b(?:kar diya|kar di|kar diye|bhej diya|bhej diye|paid|done|ho gaya|transfer(?:red)?)\b|कर दिया|भेज दिया|हो गया/i;

function pickIntent(text) {
  const t = String(text || '');
  const question = isQuestion(t);
  for (const [name, re] of Object.entries(INTENT)) {
    if (re.test(t) && (question || SELF_EVIDENT.has(name))) return name;
  }
  return null;
}

// Whether answering this message needs the customer's open order. Only the
// payment and status answers do, so the reply path can skip that query for the
// common case.
export function needsOpenOrder(text) {
  const intent = pickIntent(text);
  return intent === 'payment' || intent === 'status';
}

// The intent this message is clearly asking about, or null. Exported so the
// caller can decide to answer without a model before it ever parses the order.
export function freeIntent(text) {
  return pickIntent(text);
}

// A message that asks for something ("2 roses bhej do", "ek bouquet chahiye")
// is an order, not a question, even if it also mentions a price or a place. Such
// a message must go through the normal parse so the items and delivery details
// are not lost, so it is never answered from the free path alone.
const ORDER_VERB = /\b(?:bhej(?:o|do|dijiye|de|na)?|chahiye|chaiye|chaahiye|dedo|de do|send|lao|kar ?do|kardo)\b|चाहिए|भेज/i;

export function looksLikeOrder(text) {
  return ORDER_VERB.test(String(text || ''));
}

// The catalog, cheapest few, as a line a shopkeeper would actually type.
function priceList(products) {
  const live = products.filter((p) => p.active !== false);
  if (!live.length) return null;
  return live
    .slice(0, 6)
    .map((p) => `${p.name} ${rupees(p.price_cents)}`)
    .join(', ');
}

function lineItems(items) {
  return items.map((i) => `${i.quantity} × ${i.name} ${rupees(i.unitPriceCents * i.quantity)}`).join(', ');
}

const OPEN_STATUS = {
  pending: 'abhi confirm hona baaki hai',
  confirmed: 'confirm ho gaya hai',
  fulfilled: 'deliver ho gaya hai',
  cancelled: 'cancel ho gaya hai',
};

// Builds the free reply, or null when this message is not one the shop can
// answer from what it already knows.
export function freeReply({ tenant, products, messageText, items = [], openOrder = null }) {
  const intent = pickIntent(messageText);
  if (!intent) return null;
  const en = detectLanguage(messageText) === 'en';

  if (intent === 'price') {
    if (items.length) {
      const total = items.reduce((s, i) => s + i.unitPriceCents * i.quantity, 0);
      return `${lineItems(items)} = ${rupees(total)} 🌸`;
    }
    const list = priceList(products);
    return list ? `${list} 🌸` : null;
  }

  if (intent === 'payment') {
    if (!tenant.shop_upi_id) return null;
    // Money already sent needs the owner to check, not a second nudge to pay.
    if (ALREADY_PAID.test(messageText)) {
      return en ? 'Thank you! 🙏' : 'Dhanyavaad! 🙏';
    }
    const owed = openOrder && openOrder.payment_status !== 'paid' && openOrder.total_cents
      ? rupees(openOrder.total_cents)
      : null;
    const name = tenant.shop_payment_name ? ` (${tenant.shop_payment_name})` : '';
    if (en) {
      return owed
        ? `Pay ${owed} to UPI ${tenant.shop_upi_id}${name} 🙏`
        : `Pay to UPI ${tenant.shop_upi_id}${name} 🙏`;
    }
    return owed
      ? `${owed} is UPI par bhej dijiye: ${tenant.shop_upi_id}${name} 🙏`
      : `UPI ${tenant.shop_upi_id}${name} par payment kar dijiye 🙏`;
  }

  if (intent === 'location') {
    return tenant.shop_address ? `📍 ${tenant.shop_address}` : null;
  }

  if (intent === 'hours') {
    return tenant.shop_hours ? `🕒 ${tenant.shop_hours}` : null;
  }

  if (intent === 'delivery') {
    return tenant.shop_delivery ? `🚚 ${tenant.shop_delivery}` : null;
  }

  if (intent === 'status') {
    if (!openOrder) {
      return en ? 'No open order found for this number 🌸' : 'Is number par koi khula order nahi mila 🌸';
    }
    const state = OPEN_STATUS[openOrder.status] || openOrder.status;
    const paid = openOrder.payment_status === 'paid'
      ? (en ? 'Payment received.' : 'Payment mil gaya hai.')
      : (en ? 'Payment is still pending.' : 'Payment abhi baaki hai.');
    return en ? `Your order is ${state}. ${paid} 🌸` : `Aapka order ${state}. ${paid} 🌸`;
  }

  return null;
}
