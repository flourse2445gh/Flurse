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
];

export function detectLanguage(text) {
  const t = String(text || '');
  if (/[\u0900-\u097F]/.test(t)) return 'hi';
  const words = t.toLowerCase().match(/[a-z']+/g) || [];
  if (!words.length) return 'en';
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

export async function parseOrder(text, products) {
  if (!text || !products.length) return { items: [], source: 'empty' };
  if (!availableProviders().length) return fallbackParse(text, products);

  const catalog = products.map((p) => ({
    id: p.id,
    name: p.name,
    price_cents: p.price_cents,
  }));

  const result = await askJson(
    [
      {
        role: 'system',
        content:
          'Extract a customer order from a WhatsApp message. ' +
          'Only use products from the catalog. Reply as JSON: ' +
          '{"items":[{"id":"<catalog id>","quantity":<int>}]}. ' +
          'If nothing matches, return {"items":[]}.',
      },
      { role: 'user', content: `Catalog: ${JSON.stringify(catalog)}\n\nMessage: ${text}` },
    ],
    { temperature: 0 },
  );

  if (!result.parsed) return fallbackParse(text, products);

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
  return { items, source: `llm:${result.provider}` };
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

function buildReplySystemPrompt({ tenant, products, language, hasItems, parseFailed }) {
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
    '- Keep it very short: between 1 and 10 words. One line only.',
    '- Put exactly one emoji at the very end of the reply, as the last character.',
    '- No bullet lists, no headings, no long paragraphs.',
    '- Never say you are a bot, an AI, an assistant, or "Meta AI".',
    '- Never invent items, prices, or offers that are not in the catalog.',
    '- If the customer only chats or asks a question, just answer warmly and helpfully.',
    '- Write the rupee sign as ₹, never "Rs".',
  ];

  if (language === 'en') {
    lines.push('- Use plain English words only. Do not use Hindi or Hinglish words like "bhai", "hai", "milta".');
  }

  if (tenant.shop_instructions) {
    lines.push(`- Extra instructions from the shop owner: ${tenant.shop_instructions}`);
  }
  if (hasItems) {
    lines.push(
      '- The customer is placing an order. In 1-10 words, confirm what you understood and ask for',
      '  anything still missing (delivery address, date and time, or a name), plus one emoji.',
    );
  }
  if (parseFailed) {
    lines.push(
      '- You could not find their item in the catalog. In 1-10 words, warmly ask which item they mean, plus one emoji.',
    );
  }
  lines.push('', 'Return JSON only: {"reply":"<your message>"}');
  return lines.join('\n');
}

function buildReplyUserPrompt({ messageText, items, history, language }) {
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
  parts.push('', `Reply in ${LANG_LABEL[language]}.`);
  return parts.join('\n');
}

function totalCents(items) {
  return items.reduce((sum, i) => sum + i.unitPriceCents * i.quantity, 0);
}

// A plain-text, non-AI reply. Used when every provider is unavailable so the
// shop still answers, just in the simpler template voice.
export function templateReply(language, items) {
  const symbol = '₹';
  if (!items.length) {
    return language === 'en'
      ? 'Which flower would you like? 😊'
      : 'Kaunsa phool chahiye? 😊';
  }
  const total = `${symbol}${(totalCents(items) / 100).toFixed(2)}`;
  return language === 'en'
    ? `Total ${total}, CONFIRM to order 🌸`
    : `Total ${total}, order ke liye CONFIRM likhein 🌸`;
}

export async function draftReply({ tenant, products, messageText, items, history }) {
  const language = detectLanguage(messageText);

  // Only the opening hello of a conversation gets the fixed short greeting:
  // no provider call, nothing to invent, and it always matches the owner's
  // asked-for shape. history includes the message just stored, so a length of
  // one means this is the customer's first message.
  if (isGreeting(messageText) && (history?.length ?? 0) <= 1) {
    return { reply: greetingReply(language), source: 'greeting', language, errors: [] };
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
      }),
    },
    { role: 'user', content: buildReplyUserPrompt({ messageText, items, history, language }) },
  ]);

  const reply = result.parsed?.reply;
  if (typeof reply === 'string' && reply.trim()) {
    return {
      reply: ensureTrailingEmoji(reply),
      source: `llm:${result.provider}`,
      language,
      errors: result.errors,
    };
  }
  return {
    reply: ensureTrailingEmoji(templateReply(language, items)),
    source: 'template',
    language,
    errors: result.errors,
  };
}
