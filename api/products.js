import { query } from '../lib/db.js';
import { requireSession, assertTenantWritable } from '../lib/auth.js';
import { handler, readJson, json, requireMethod, HttpError } from '../lib/http.js';

// GET    /api/products         -> the shop's catalog
// POST   /api/products         -> create (no id) or update (with id) an item
// DELETE /api/products?id=...  -> remove an item
//
// Prices arrive as rupees and are stored in paise so money never touches a
// float in the database.
export default handler(async (req, res) => {
  const session = await requireSession(req);

  if (req.method === 'GET') {
    const { rows } = await query(
      `SELECT id, sku, name, description, price_cents, currency, active, is_sample
         FROM products
        WHERE tenant_id = $1
        ORDER BY active DESC, name ASC`,
      [session.tenant_id],
    );
    json(res, 200, { products: rows });
    return;
  }

  assertTenantWritable({ status: session.status });

  if (req.method === 'DELETE') {
    const id = new URL(req.url, 'http://localhost').searchParams.get('id');
    if (!id) throw new HttpError(400, 'id is required');
    const { rowCount } = await query(
      'DELETE FROM products WHERE id = $1 AND tenant_id = $2',
      [id, session.tenant_id],
    );
    json(res, 200, { deleted: rowCount });
    return;
  }

  if (!requireMethod(req, res, ['POST'])) return;

  const body = await readJson(req);
  const name = String(body.name ?? '').trim();
  const priceRupees = Number(body.price);
  if (!name) throw new HttpError(400, 'name is required');
  if (!Number.isFinite(priceRupees) || priceRupees < 0) {
    throw new HttpError(400, 'price must be a positive number');
  }
  const priceCents = Math.round(priceRupees * 100);
  const active = body.active === undefined ? true : Boolean(body.active);
  const description = body.description ? String(body.description).trim() : null;

  if (body.id) {
    const { rows } = await query(
      `UPDATE products
          SET name = $3, price_cents = $4, description = $5, active = $6, is_sample = false
        WHERE id = $1 AND tenant_id = $2
        RETURNING id, name, description, price_cents, currency, active, is_sample`,
      [body.id, session.tenant_id, name, priceCents, description, active],
    );
    if (!rows.length) throw new HttpError(404, 'Product not found');
    json(res, 200, { product: rows[0] });
    return;
  }

  const { rows } = await query(
    `INSERT INTO products (tenant_id, name, description, price_cents, currency, active, is_sample)
     VALUES ($1, $2, $3, $4, 'INR', $5, false)
     RETURNING id, name, description, price_cents, currency, active, is_sample`,
    [session.tenant_id, name, description, priceCents, active],
  );
  json(res, 201, { product: rows[0] });
});
