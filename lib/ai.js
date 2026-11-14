// Turns a free-text WhatsApp message into structured order lines.
//
// When OPENAI_API_KEY is set we ask the model to map the message onto the
// tenant's catalog. Otherwise we fall back to a deterministic keyword match so
// local development and tests work with no external dependency.

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

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
    // Matches "2 x latte", "3 lattes", or a bare "latte".
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

async function llmParse(text, products) {
  const catalog = products.map((p) => ({
    id: p.id,
    name: p.name,
    price_cents: p.price_cents,
  }));

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'Extract a customer order from a WhatsApp message. ' +
            'Only use products from the catalog. Reply as JSON: ' +
            '{"items":[{"id":"<catalog id>","quantity":<int>}]}. ' +
            'If nothing matches, return {"items":[]}.',
        },
        {
          role: 'user',
          content: `Catalog: ${JSON.stringify(catalog)}\n\nMessage: ${text}`,
        },
      ],
    }),
  });

  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const data = await res.json();
  const parsed = JSON.parse(data.choices[0].message.content);

  const byId = new Map(products.map((p) => [p.id, p]));
  const items = [];
  for (const item of parsed.items ?? []) {
    const product = byId.get(item.id);
    if (!product) continue;
    items.push({
      productId: product.id,
      name: product.name,
      quantity: Math.min(Math.max(parseInt(item.quantity, 10) || 1, 1), 99),
      unitPriceCents: product.price_cents,
    });
  }
  return { items, source: 'llm' };
}

export async function parseOrder(text, products) {
  if (!text || !products.length) return { items: [], source: 'empty' };
  if (!process.env.OPENAI_API_KEY) return fallbackParse(text, products);

  try {
    return await llmParse(text, products);
  } catch (err) {
    // A model outage must not drop a customer order; degrade to keyword match.
    console.error('LLM parse failed, using fallback:', err.message);
    return fallbackParse(text, products);
  }
}

export function formatOrderConfirmation(order, items, currency = 'INR') {
  const symbol = currency === 'INR' ? '₹' : '';
  const lines = items
    .map((i) => `• ${i.quantity} × ${i.name} — ${symbol}${(i.unitPriceCents * i.quantity / 100).toFixed(2)}`)
    .join('\n');
  const total = `${symbol}${(order.total_cents / 100).toFixed(2)}`;
  return `Got it! Here's your order:\n${lines}\n\nTotal: ${total}\nReply CONFIRM to place it.`;
}
