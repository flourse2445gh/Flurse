// Starter catalog for a brand-new shop. An empty catalog makes the AI deaf:
// it can only order items it can see, so a shop that signs up and connects
// WhatsApp before adding anything answers every customer with "Kaunsa phool?".
// These common items mean the very first message can become a real order.
//
// Prices are in paise and are deliberately ordinary, so they read as a starting
// point. Each row is flagged `is_sample` and the dashboard nudges the owner to
// set their own price; editing an item clears the flag.

export const SAMPLE_PRODUCTS = [
  { name: 'Gulab (Red Rose) — 10 stems', description: 'Fresh red roses', priceCents: 30000 },
  { name: 'Mixed Flower Bouquet', description: 'Seasonal mix', priceCents: 50000 },
  { name: 'Roses — 25 stems', description: 'Bulk red roses', priceCents: 70000 },
  { name: 'Marigold Garland (Genda Mala)', description: 'Pooja garland', priceCents: 15000 },
  { name: 'Lily Bouquet', description: 'White lilies', priceCents: 60000 },
  { name: 'Orchid Basket', description: 'Premium arrangement', priceCents: 120000 },
  { name: 'Rose + Chocolate Combo', description: 'Bouquet with chocolates', priceCents: 80000 },
  { name: 'Gulab (Red Rose) — 20 stems', description: 'Red roses', priceCents: 55000 },
];

// Inserts the starter items for a tenant that has no products yet. Idempotent:
// it does nothing once the shop has any item of its own, so re-running it never
// duplicates a catalog. Returns how many it added.
export async function seedSampleCatalog(client, tenantId) {
  const { rows } = await client.query(
    'SELECT 1 FROM products WHERE tenant_id = $1 LIMIT 1',
    [tenantId],
  );
  if (rows.length) return 0;

  for (const p of SAMPLE_PRODUCTS) {
    await client.query(
      `INSERT INTO products (tenant_id, name, description, price_cents, currency, active, is_sample)
       VALUES ($1, $2, $3, $4, 'INR', true, true)`,
      [tenantId, p.name, p.description, p.priceCents],
    );
  }
  return SAMPLE_PRODUCTS.length;
}
