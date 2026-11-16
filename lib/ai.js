// The shop's brain: understands a customer message, drafts a reply in the
// customer's own language, and keeps a short summary of a chat in progress.
//
// Providers are tried in order and the first one that answers wins, so a
// provider running out of credit does not stop the shop from replying. If no
// provider is configured (or all fail) the deterministic keyword match takes
// over, which keeps local development and tests working with no network.

const TIMEOUT_MS = 15000;

// Order matters: free tiers first, then paid. `kind` picks the request and
// response shape, because Gemini and OpenAI do not speak the same dialect.
// Each base URL can be overridden by env, which lets a self-hosted gateway or
// a test server stand in for the provider.
function base(envName, fallback) {
  return (process.env[envName] || fallback).replace(/\/$/, '');
}

const PROVIDERS = [
  {
    name: 'gemini',
    kind: 'gemini',
    keyEnv: 'GEMINI_API_KEY',
    model: () => process.env.GEMINI_MODEL || 'gemini-flash-latest',
    url: (model) =>
      `${base('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta')}/models/${model}:generateContent`,
  },
  {
    name: 'groq',
    kind: 'openai',
    keyEnv: 'GROQ_API_KEY',
    model: () => process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
    url: () => `${base('GROQ_BASE_URL', 'https://api.groq.com/openai/v1')}/chat/completions`,
  },
  {
    name: 'cerebras',
    kind: 'openai',
    keyEnv: 'CEREBRAS_API_KEY',
    model: () => process.env.CEREBRAS_MODEL || 'llama-3.3-70b',
    url: () => `${base('CEREBRAS_BASE_URL', 'https://api.cerebras.ai/v1')}/chat/completions`,
  },
  {
    name: 'openrouter',
    kind: 'openai',
    keyEnv: 'OPENROUTER_API_KEY',
    model: () => process.env.OPENROUTER_MODEL || 'google/gemma-4-31b-it:free',
    url: () => `${base('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1')}/chat/completions`,
  },
  {
    name: 'openai',
    kind: 'openai',
    keyEnv: 'OPENAI_API_KEY',
    model: () => process.env.OPENAI_MODEL || 'gpt-5-mini',
    url: () => `${base('OPENAI_BASE_URL', 'https://api.openai.com/v1')}/chat/completions`,
  },
];

// Cheap, dependency-free language check. WhatsApp messages are short, so
// looking at the script and a handful of Hinglish words is reliable enough.
const HINGLISH_WORDS = [
  'hai', 'hain', 'kya', 'kaise', 'kaisa', 'kitna', 'kitne', 'chahiye', 'karo',
  'karna', 'mujhe', 'tum', 'aap', 'bhai', 'bhaiya', 'didi', 'nahi', 'haan',
  'mil', 'milega', 'kal', 'aaj', 'abhi', 'dena', 'bhejo', 'bhej', 'gulab',
  'phool', 'paise', 'paisa', 'kab', 'kahan', 'kaun', 'jaldi', 'chaiye',
  'karte', 'karta', 'kro', 'dedo', 'batao', 'bata', 'kuch', 'aur', 'bhi',
  'mera', 'meri', 'hum', 'raha', 'rahe', 'rahi', 'gaya', 'gayi', 'liye',
  'kripya', 'shukriya', 'dhanyavaad', 'theek', 'thik', 'ho', 'hun',
];

// Words no English message ever uses, so one of them alone is enough to call
// the message Hinglish. Without this, "rose chahiye" reads as English.
const STRONG_HINGLISH = new Set([
  'chahiye', 'chaiye', 'chaahiye', 'gulab', 'phool', 'kitna', 'kitne', 'mujhe',
  'bhai', 'bhaiya', 'didi', 'nahi', 'haan', 'kaise', 'kaisa', 'kab', 'kahan',
  'kaun', 'milega', 'bhejo', 'karo', 'kro', 'karte', 'karta', 'dedo', 'batao',
  'paisa', 'paise', 'aap', 'tum', 'mera', 'meri', 'kripya', 'shukriya',
  'dhanyavaad', 'theek', 'thik', 'hun', 'raha', 'rahe', 'rahi',
]);

export function detectLanguage(text) {
  const t = String(text || '');
  if (/[\u0900-\u097F]/.test(t)) return 'hi';
  const words = t.toLowerCase().match(/[a-z']+/g) || [];
  if (!words.length) return 'en';
  if (words.some((w) => STRONG_HINGLISH.has(w))) return 'hinglish';
  const hinglish = words.filter((w) => HINGLISH_WORDS.includes(w)).length;
  return hinglish >= 2 ? 'hinglish' : 'en';
}

const LANG_LABEL = {
  hi: 'Hindi in Devanagari script',
  hinglish: 'Hinglish — Hindi written in Roman/English letters, the way Indians type on WhatsApp',
  en: 'English',
};

// A first message that is only a greeting (no item named). Built from greeting
// words so "Namaste ji!" or "hello hello" still count, while "Hi, do you have
// roses?" goes through the normal reply path because "roses" is not a greeting.
const GREETING_WORD = [
  'hi+', 'hey+', 'hello+', 'hlo+', 'yo', 'hola', 'start', 'gm',
  'namaste', 'namaskar', 'salaam', 'assalam(?:u\\s*alaikum)?', 'adaab',
  'ram\\s+ram', 'radhe\\s+radhe', 'jai\\s+shri\\s+krishna',
  'good\\s+(?:morning|afternoon|evening|day)',
  'kya\\s+haal(?:\\s+hai)?', 'kaise\\s+ho(?:\\s+ho)?', 'ji',
  // Devanagari greetings, which the customer may type directly.
  'नमस्ते', 'नमस्कार', 'हेलो', 'हाय', 'राम\\s+राम', 'सलाम',
  'अस्सलाम(?:ु\\s*अलैकुम)?', 'क्या\\s+हाल(?:\\s+है)?', 'कैसे\\s+हो', 'जी',
].join('|');
const GREETING_RE = new RegExp(`^(?:(?:${GREETING_WORD})[\\s!.?,]*)+$`, 'i');

export function isGreeting(text) {
  return GREETING_RE.test(String(text || '').trim());
}

// The exact first-reply shape the shop owner asked for: a short "Hi" plus a
// nudge for what the customer wants. The greeting never uses "Namaste"; only
// the question part follows the customer's language.
function greetingReply(language) {
  if (language === 'hi') return 'Hi! क्या चाहिए आपको? 😊';
  return 'Hi! Kya chahiye aapko? 😊';
}

// A single emoji, including the common surrogate pairs and variation
// selectors. Used only to nudge an emoji to the end of a reply.
const EMOJI_RE = /(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)/gu;

// The owner wants the emoji at the very end of the text. A model sometimes
// drops it mid-sentence, so pull the first one out and re-attach it at the end.
export function ensureTrailingEmoji(reply) {
  const text = String(reply || '').trim();
  const match = text.match(EMOJI_RE);
  if (!match) return text;
  const emoji = match[0];
  const without = text.replace(emoji, '').replace(/\s+/g, ' ').trim();
  if (!without) return emoji;
  return `${without} ${emoji}`;
}

// The owner's standing rule: a reply never carries more words than the
// customer's own message. Emoji are free, so they do not count against it.
export function wordBudget(text) {
  const withoutEmoji = String(text || '').replace(EMOJI_RE, ' ');
  const words = withoutEmoji.trim().match(/\S+/g) || [];
  return Math.max(words.length, 1);
}

// Words that leave a sentence dangling when they land at the cut, so a
// truncated reply does not end on "we have a lovely". Dropped only from the
// tail, and never down to nothing.
const DANGLING_TAIL = new Set([
  'a', 'an', 'the', 'is', 'are', 'am', 'was', 'were', 'be', 'been', 'for', 'of',
  'to', 'and', 'or', 'but', 'with', 'in', 'on', 'at', 'by', 'from', 'this',
  'that', 'these', 'those', 'it', 'we', 'i', 'you', 'our', 'your', 'my', 'me',
  'do', 'does', 'did', 'can', 'could', 'will', 'would', 'please', 'kindly',
  'ka', 'ki', 'ke', 'hai', 'hain', 'ho', 'me', 'mein', 'se', 'par', 'aur',
  'ya', 'kya', 'ko', 'hum', 'aap', 'mai', 'bhi', 'toh', 'na', 'ji', 'kar',
  'karke', 'liye', 'raha', 'rahe',
  'का', 'की', 'के', 'है', 'हैं', 'हो', 'में', 'से', 'पर', 'और', 'या', 'क्या',
  'को', 'हम', 'आप', 'भी', 'तो', 'ना', 'जी', 'कर',
]);

// Hard guarantee for the word rule: the model is told the budget, and this
// trims anything that still overshoots. The emoji is pulled out first so it
// never eats into the budget.
export function fitReply(reply, budget) {
  const text = String(reply || '').trim();
  const emoji = text.match(EMOJI_RE)?.[0] ?? '';
  const body = (emoji ? text.replace(emoji, ' ') : text).replace(/\s+/g, ' ').trim();
  let words = body ? body.split(' ') : [];
  if (words.length > budget) {
    words = words.slice(0, budget);
    while (
      words.length > 1
      && DANGLING_TAIL.has(words[words.length - 1].replace(/[.,!?;:।]+$/, '').toLowerCase())
    ) {
      words.pop();
    }
  }
  const trimmed = words.join(' ');
  const out = trimmed ? (emoji ? `${trimmed} ${emoji}` : trimmed) : (emoji || text);
  return ensureTrailingEmoji(out);
}

// -- catalog matching (the no-AI fallback) ---------------------------------

function matchCatalog(text, products) {
  const haystack = text.toLowerCase();
  const lines = [];
  // Longest names first so "Cold Brew" wins over a bare "Brew".
  const ordered = [...products].sort((a, b) => b.name.length - a.name.length);
  const claimed = new Set();

  for (const p of ordered) {
    if (claimed.has(p.id)) continue;
    const name = p.name.toLowerCase();
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Optional trailing "s" so "2 lattes" matches a "Latte" product.
    const re = new RegExp(`(\\d+)\\s*(?:x\\s*)?${escaped}s?\\b|\\b${escaped}s?\\b`, 'i');
    const m = haystack.match(re);
    if (m) {
      const qty = m[1] ? parseInt(m[1], 10) : 1;
      lines.push({
        productId: p.id,
        name: p.name,
        quantity: Math.min(Math.max(qty, 1), 99),
        unitPriceCents: p.price_cents,
      });
      claimed.add(p.id);
    }
  }
  return lines;
}

function fallbackParse(text, products) {
  return { items: matchCatalog(text, products), source: 'fallback' };
}

// -- provider plumbing -----------------------------------------------------

// Provider keys are pasted into a dashboard by hand, so they routinely arrive
// with a trailing newline or wrapped in quotes. Normalise before use.
function keyFor(provider) {
  const raw = process.env[provider.keyEnv];
  if (!raw) return '';
  return raw.trim().replace(/^["']|["']$/g, '');
}

export function availableProviders() {
  return PROVIDERS.filter((p) => keyFor(p));
}

function buildRequest(provider, messages, temperature) {
  const model = provider.model();
  const headers = { 'Content-Type': 'application/json' };

  if (provider.kind === 'gemini') {
    return {
      url: `${provider.url(model)}?key=${encodeURIComponent(keyFor(provider))}`,
      headers,
      body: {
        systemInstruction: { parts: [{ text: messages[0].content }] },
        contents: messages.slice(1).map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        generationConfig: { temperature, responseMimeType: 'application/json' },
      },
    };
  }

  headers.Authorization = `Bearer ${keyFor(provider)}`;
  if (provider.name === 'openrouter') {
    // OpenRouter asks callers to identify themselves.
    headers['HTTP-Referer'] = 'https://budsbox.app';
    headers['X-Title'] = 'BudsBox';
  }
  return {
    url: provider.url(model),
    headers,
    body: {
      model,
      temperature,
      response_format: { type: 'json_object' },
      messages,
    },
  };
}

function extractText(provider, data) {
  if (provider.kind === 'gemini') {
    return data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') ?? '';
  }
  return data?.choices?.[0]?.message?.content ?? '';
}

function parseJsonLoose(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Models sometimes wrap JSON in prose or a code fence.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

// Walks the provider chain and returns the first usable JSON object, or null
// when every provider is missing, rate limited, or failing. Failures are
// collected so a shop owner can see why the AI went quiet.
async function askJson(messages, { temperature = 0.4 } = {}) {
  const errors = [];
  for (const provider of availableProviders()) {
    const { url, headers, body } = buildRequest(provider, messages, temperature);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        console.error(`AI provider ${provider.name} failed: HTTP ${res.status}`);
        errors.push({ provider: provider.name, status: res.status, message: maskSecrets(detail) });
        continue;
      }
      const parsed = parseJsonLoose(extractText(provider, await res.json()));
      if (parsed) return { parsed, provider: provider.name, errors };
      console.error(`AI provider ${provider.name} returned unparseable output`);
      errors.push({ provider: provider.name, status: 200, message: 'unparseable output' });
    } catch (err) {
      console.error(`AI provider ${provider.name} error:`, err.message);
      errors.push({ provider: provider.name, status: 0, message: maskSecrets(err.message) });
    }
  }
  return { parsed: null, provider: null, errors };
}

// Provider error bodies are useful to show, but must never leak a key.
function maskSecrets(text) {
  return String(text || '')
    .replace(/[A-Za-z0-9_-]{20,}/g, '<redacted>')
    .slice(0, 200);
}

// -- order parsing ---------------------------------------------------------

// Delivery details that a florist needs before the flowers can actually go
// out. Every field is optional, because the customer usually gives them across
// several messages rather than one.
const DETAIL_KEYS = ['fulfilment', 'address', 'at', 'note', 'name', 'phone'];

function cleanText(value) {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  if (!t || /^(null|none|n\/a|unknown|-)$/i.test(t)) return null;
  return t.slice(0, 500);
}

// "kal shaam 6 baje" and friends, resolved without the model, so a wrong day
// can never reach the kitchen. Returns an ISO string or null.
export function guessDeliveryAt(text, now = new Date()) {
  const t = String(text || '').toLowerCase();
  if (!/\d/.test(t)) return null;
  const time = t.match(/(\d{1,2})(?::(\d{2}))?\s*(baje|bje|o'?clock|am|pm)?/);
  if (!time) return null;
  let hour = parseInt(time[1], 10);
  const minute = parseInt(time[2] ?? '0', 10);
  if (!Number.isFinite(hour) || hour > 23 || minute > 59) return null;
  if (hour <= 12 && /shaam|evening|raat|night/.test(t) && hour < 12) hour += 12;

  const ist = new Date(now.getTime() + 5.5 * 3600 * 1000);
  const day = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
  if (/parso|parson/.test(t)) day.setUTCDate(day.getUTCDate() + 2);
  else if (/kal|tomorrow/.test(t)) day.setUTCDate(day.getUTCDate() + 1);
  day.setUTCHours(hour - 5, minute - 30, 0, 0);
  return day.toISOString();
}

function normalizeDetails(raw) {
  const details = {};
  if (!raw || typeof raw !== 'object') return details;
  const fulfilment = cleanText(raw.fulfilment)?.toLowerCase();
  if (fulfilment === 'delivery' || fulfilment === 'pickup' || fulfilment === 'pick-up') {
    details.fulfilment = fulfilment === 'pick-up' ? 'pickup' : fulfilment;
  }
  details.address = cleanText(raw.address);
  details.note = cleanText(raw.note);
  details.name = cleanText(raw.name);
  details.phone = cleanText(raw.phone);
  const at = cleanText(raw.at);
  if (at) {
    const parsed = new Date(at);
    if (!Number.isNaN(parsed.getTime()) && parsed.getFullYear() >= 2000 && parsed.getFullYear() <= 2100) {
      details.at = parsed.toISOString();
    }
  }
  for (const key of DETAIL_KEYS) if (!details[key]) delete details[key];
  return details;
}

export async function parseOrder(text, products, { aiAllowed = true } = {}) {
  if (!text || !products.length) return { items: [], details: {}, source: 'empty' };
  if (!aiAllowed || !availableProviders().length) {
    return { ...fallbackParse(text, products), details: {} };
  }

  const catalog = products.map((p) => ({
    id: p.id,
    name: p.name,
    price_cents: p.price_cents,
  }));

  const today = new Date().toISOString().slice(0, 10);
  const result = await askJson(
    [
      {
        role: 'system',
        content:
          'Extract a customer order from a WhatsApp message from an Indian flower shop. ' +
          'Only use products from the catalog. Reply as JSON: ' +
          '{"items":[{"id":"<catalog id>","quantity":<int>}],' +
          '"details":{"fulfilment":"delivery"|"pickup"|null,' +
          '"address":"<full delivery address or null>",' +
          '"at":"<ISO 8601 date-time with +05:30 offset, or null>",' +
          '"note":"<card message such as Happy Birthday, or null>",' +
          '"name":"<recipient or customer name, or null>",' +
          '"phone":"<alternate contact phone, or null>"}}. ' +
          `Today is ${today} in India (IST, +05:30). Resolve relative times against it ` +
          '("kal shaam 6 baje", "aaj", "parso", "tomorrow"). ' +
          'Fill a detail only when the message clearly states it. Never guess an address ' +
          'or a time. If nothing matches the catalog, return {"items":[]}.',
      },
      { role: 'user', content: `Catalog: ${JSON.stringify(catalog)}\n\nMessage: ${text}` },
    ],
    { temperature: 0 },
  );

  if (!result.parsed) return { ...fallbackParse(text, products), details: {} };

  const byId = new Map(products.map((p) => [p.id, p]));
  const items = [];
  for (const item of result.parsed.items ?? []) {
    const product = byId.get(item.id);
    if (!product) continue;
    items.push({
      productId: product.id,
      name: product.name,
      quantity: Math.min(Math.max(parseInt(item.quantity, 10) || 1, 1), 99),
      unitPriceCents: product.price_cents,
    });
  }

  const details = normalizeDetails(result.parsed.details);
  if (!details.at) {
    const guessed = guessDeliveryAt(text);
    if (guessed) details.at = guessed;
  }
  return { items, details, source: `llm:${result.provider}` };
}

// -- reply drafting --------------------------------------------------------

function formatCatalog(products) {
  if (!products.length) return '(the shop has not added any items yet)';
  return products
    .map((p) => `- ${p.name} — ₹${(p.price_cents / 100).toFixed(2)}${p.active === false ? ' (unavailable)' : ''}`)
    .join('\n');
}

function formatShopProfile(tenant) {
  const bits = [`Name: ${tenant.business_name ?? 'the shop'}`];
  if (tenant.shop_address) bits.push(`Address: ${tenant.shop_address}`);
  if (tenant.shop_hours) bits.push(`Open hours: ${tenant.shop_hours}`);
  if (tenant.shop_delivery) bits.push(`Delivery: ${tenant.shop_delivery}`);
  if (tenant.shop_tone) {
    bits.push(`Voice for tone and length only, never for language: ${tenant.shop_tone}`);
  }
  return bits.join('\n');
}

// What a florist still needs before the flowers can go out. Pickup needs no
// address, so it is only asked for a delivery order.
function missingDetails(order) {
  if (!order) return [];
  const missing = [];
  if (!order.fulfilment) missing.push('whether it is delivery or pickup');
  if (order.fulfilment !== 'pickup' && !order.delivery_address) missing.push('the delivery address');
  if (!order.delivery_at) missing.push('the date and time');
  if (!order.recipient_name) missing.push('the name to put on it');
  return missing;
}

function buildReplySystemPrompt({
  tenant, products, language, hasItems, parseFailed, budget, order,
}) {
  const wordWord = budget === 1 ? 'word' : 'words';
  const lines = [
    'You are the owner of a small flower/plant shop, replying on WhatsApp.',
    '',
    `MOST IMPORTANT RULE: write the whole reply in ${LANG_LABEL[language]}.`,
    'This is decided by the customer\'s own message and never changes because of the',
    'shop\'s voice settings below — those only affect warmth and length, not language.',
    '',
    'Shop details:',
    formatShopProfile(tenant),
    '',
    'Catalog (prices in Indian rupees):',
    formatCatalog(products),
    '',
    'How to write:',
    '- Sound like a real person typing on WhatsApp, not a call centre.',
    `- LENGTH RULE, this one is strict: the customer wrote ${budget} ${wordWord}, so your`,
    `  reply must be ${budget} ${wordWord} or fewer. Never use more words than the customer`,
    '  did. Short customer message, short reply.',
    '- One line only. No bullet lists, no headings, no long paragraphs.',
    '- Do NOT put an emoji in every reply. A real shopkeeper only drops one in',
    '  now and then, so most replies should have no emoji at all. When you do use',
    '  one, make it a single emoji and put it at the very end of the message.',
    '  The emoji never counts as a word.',
    '- Never say you are a bot, an AI, an assistant, or "Meta AI".',
    '- Never invent items, prices, or offers that are not in the catalog.',
    '- If the customer only chats or asks a question, just answer warmly and helpfully.',
    '- Write the rupee sign as ₹, never "Rs".',
    '- Never claim the order is confirmed, booked, or ready. You cannot confirm or',
    '  take payment, so do not promise it.',
  ];

  if (language === 'en') {
    lines.push('- Use plain English words only. Do not use Hindi or Hinglish words like "bhai", "hai", "milta".');
  }

  if (tenant.shop_instructions) {
    lines.push(`- Extra instructions from the shop owner: ${tenant.shop_instructions}`);
  }
  if (hasItems) {
    const missing = missingDetails(order);
    lines.push(
      '- The customer is placing an order. Within the same word limit, confirm what you',
      '  understood and ask for the single most important missing detail, in this order:',
      '  delivery or pickup, then address, then date and time, then the name. Ask for one',
      '  thing at a time, never a list. If nothing is missing, just confirm the order warmly.',
    );
    if (missing.length) {
      lines.push(`  Still missing right now: ${missing.join('; ')}.`);
    }
    // Money before flowers. Once the details are settled, the reply moves the
    // customer to pay, and only mentions the shop's own UPI id.
    if (order && order.payment_status !== 'paid') {
      if (tenant.shop_upi_id) {
        lines.push(
          `- The order is not paid yet. Within the same word limit, ask the customer to pay`,
          `  ₹${(order.total_cents / 100).toFixed(0)} to this UPI id: ${tenant.shop_upi_id}`,
          tenant.shop_payment_name ? `  (payee name: ${tenant.shop_payment_name}).` : '.',
          '  Say it once, plainly, and never ask for card numbers, CVV, OTPs or bank details.',
        );
      } else {
        lines.push(
          '- The order is not paid yet. Within the same word limit, ask the customer to pay',
          '  by UPI, without inventing an id or a link.',
        );
      }
    }
  }
  if (parseFailed) {
    lines.push(
      '- You could not find their item in the catalog. Within the same word limit, warmly',
      '  ask which item they mean. Skip the emoji unless it genuinely fits.',
    );
  }
  lines.push('', 'Return JSON only: {"reply":"<your message>"}');
  return lines.join('\n');
}

function buildReplyUserPrompt({ messageText, items, history, language, budget }) {
  const parts = [];
  if (history?.length) {
    parts.push(
      'Recent conversation (oldest first):',
      ...history.map((m) => `${m.direction === 'inbound' ? 'Customer' : 'Shop'}: ${m.body}`),
      '',
    );
  }
  parts.push(`Latest customer message: ${messageText}`);
  if (items?.length) {
    parts.push(
      '',
      'Items understood so far:',
      ...items.map((i) => `- ${i.quantity} × ${i.name}`),
    );
  }
  // Restated last, because the newest instruction carries the most weight.
  parts.push(
    '',
    `Reply in ${LANG_LABEL[language]}, in ${budget} ${budget === 1 ? 'word' : 'words'} or fewer.`,
  );
  return parts.join('\n');
}

function totalCents(items) {
  return items.reduce((sum, i) => sum + i.unitPriceCents * i.quantity, 0);
}

// A plain-text, non-AI reply. Used when every provider is unavailable so the
// shop still answers, just in the simpler template voice. Deliberately short,
// and no "reply CONFIRM" promise, because nothing reads that keyword.
export function templateReply(language, items) {
  if (!items.length) {
    return language === 'en' ? 'Which flower? 😊' : 'Kaunsa phool? 😊';
  }
  const total = `₹${(totalCents(items) / 100).toFixed(2)}`;
  return `Total ${total} 🌸`;
}

export async function draftReply({ tenant, products, messageText, items, history, order, aiAllowed = true }) {
  const language = detectLanguage(messageText);
  const budget = wordBudget(messageText);

  // Only the opening hello of a conversation gets the fixed short greeting:
  // no provider call, nothing to invent, and it always matches the owner's
  // asked-for shape. history includes the message just stored, so a length of
  // one means this is the customer's first message.
  if (isGreeting(messageText) && (history?.length ?? 0) <= 1) {
    return { reply: greetingReply(language), source: 'greeting', language, errors: [] };
  }

  // Over the monthly allowance: answer from the template, which costs nothing,
  // so the shop keeps serving instead of going silent.
  if (!aiAllowed) {
    return {
      reply: fitReply(templateReply(language, items), budget),
      source: 'template',
      language,
      errors: [],
    };
  }

  const parseFailed = !items.length && Boolean(String(messageText || '').trim());

  const result = await askJson([
    {
      role: 'system',
      content: buildReplySystemPrompt({
        tenant,
        products,
        language,
        hasItems: items.length > 0,
        parseFailed,
        budget,
        order,
      }),
    },
    { role: 'user', content: buildReplyUserPrompt({ messageText, items, history, language, budget }) },
  ]);

  const reply = result.parsed?.reply;
  if (typeof reply === 'string' && reply.trim()) {
    return {
      reply: fitReply(reply, budget),
      source: `llm:${result.provider}`,
      language,
      errors: result.errors,
    };
  }
  return {
    reply: fitReply(templateReply(language, items), budget),
    source: 'template',
    language,
    errors: result.errors,
  };
}
