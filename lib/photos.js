// Photos, stored and served without a file host.
//
// A florist's catalogue is a picture: a customer who cannot see the bouquet
// does not buy it. Two kinds of picture matter, and both are stored as a data
// URL on the row they belong to (a product, or an order), then served from a
// public URL under an unguessable token so WhatsApp can fetch it when the shop
// sends it. No S3, no bucket, no per-image cost.
//
// Nothing here calls a model. A photo is fetched and sent by the same
// deterministic path as the payment QR.

import crypto from 'node:crypto';
import { query } from './db.js';
import { publicBaseUrl, sendWhatsAppImage } from './whatsapp.js';

// A bouquet photo is a phone picture. 600 KB of base64 is generous for a
// WhatsApp-quality image and keeps one upload from bloating the row.
export const PHOTO_MAX_CHARS = 600_000;
export const PHOTO_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

// Validates an uploaded data URL and returns the normalised pieces, or throws a
// plain Error with a message the dashboard can show. Kept separate from the
// storage so the same rule guards both a product and an order photo.
export function parsePhoto(dataUrl) {
  const value = String(dataUrl ?? '').trim();
  if (!value) return null;
  const match = value.match(/^data:(image\/[a-z+.-]+);base64,/i);
  if (!match || !PHOTO_TYPES.includes(match[1].toLowerCase())) {
    throw new Error('Upload a PNG, JPEG or WebP image');
  }
  if (value.length > PHOTO_MAX_CHARS) {
    throw new Error('That image is too large — keep it under 400 KB');
  }
  return value;
}

function token() {
  return crypto.randomBytes(16).toString('hex');
}

// Public URL WhatsApp fetches. Served from api/shop.js beside the payment QR
// (the Hobby plan allows only twelve serverless functions, so images share the
// file that already serves a public token-gated picture). Null when the shop
// has no photo or no reachable base URL, which is what the caller checks before
// sending an image.
export function photoUrl(kind, imageToken) {
  const base = publicBaseUrl();
  if (!imageToken || !base) return null;
  return `${base}/api/shop?${kind}=${imageToken}`;
}

// -- product photos --------------------------------------------------------

export async function setProductPhoto(tenantId, productId, dataUrl) {
  const clean = parsePhoto(dataUrl);
  if (!clean) {
    const { rows } = await query(
      `UPDATE products SET image_data = NULL, image_token = NULL
        WHERE id = $1 AND tenant_id = $2
        RETURNING id`,
      [productId, tenantId],
    );
    return rows[0] ? { id: rows[0].id, imageUrl: null } : null;
  }
  const t = token();
  const { rows } = await query(
    `UPDATE products SET image_data = $3, image_token = $4
      WHERE id = $1 AND tenant_id = $2
      RETURNING id, image_token`,
    [productId, tenantId, clean, t],
  );
  if (!rows[0]) return null;
  return { id: rows[0].id, imageUrl: photoUrl('product', rows[0].image_token) };
}

export async function getProductPhotoByToken(imageToken) {
  const { rows } = await query(
    'SELECT image_data FROM products WHERE image_token = $1',
    [imageToken],
  );
  return rows[0]?.image_data ?? null;
}

// The photo URL for one product, by id. Used to ride a price answer with the
// picture the customer asked about.
export async function productPhotoUrl(tenantId, productId) {
  if (!productId) return null;
  const { rows } = await query(
    'SELECT image_token FROM products WHERE id = $1 AND tenant_id = $2',
    [productId, tenantId],
  );
  return rows[0]?.image_token ? photoUrl('product', rows[0].image_token) : null;
}

// The photos for the products a customer is asking about, so a price answer can
// carry the picture. `names` are catalog names; only products that actually
// have a photo come back, keyed by name.
export async function productPhotosByNames(tenantId, names) {
  if (!names.length) return new Map();
  const { rows } = await query(
    `SELECT name, image_token
       FROM products
      WHERE tenant_id = $1 AND image_token IS NOT NULL
        AND name = ANY($2::text[])`,
    [tenantId, names],
  );
  const map = new Map();
  for (const r of rows) map.set(r.name, photoUrl('product', r.image_token));
  return map;
}

// -- delivery photos -------------------------------------------------------

// Stored against the order, so the customer's picture is the one that actually
// went out and not a stock photo of the catalogue item.
export async function setDeliveryPhoto(tenantId, orderId, dataUrl) {
  const clean = parsePhoto(dataUrl);
  const { rows } = await query(
    `UPDATE orders SET delivery_photo_data = $3, delivery_photo_token = $4
      WHERE id = $1 AND tenant_id = $2
      RETURNING id`,
    [orderId, tenantId, clean, clean ? token() : null],
  );
  if (!rows[0]) return null;
  return { id: rows[0].id };
}

export async function getDeliveryPhotoByToken(imageToken) {
  const { rows } = await query(
    'SELECT delivery_photo_data FROM orders WHERE delivery_photo_token = $1',
    [imageToken],
  );
  return rows[0]?.delivery_photo_data ?? null;
}

// The delivery photo to send for an order, if one was uploaded and not yet
// sent. The token check keeps the same picture from going out twice.
export async function deliveryPhotoToSend(tenantId, orderId) {
  const { rows } = await query(
    `SELECT delivery_photo_token
       FROM orders
      WHERE id = $1 AND tenant_id = $2
        AND delivery_photo_token IS NOT NULL
        AND delivery_photo_sent_at IS NULL`,
    [orderId, tenantId],
  );
  const t = rows[0]?.delivery_photo_token;
  return t ? { token: t, url: photoUrl('delivery', t) } : null;
}

export async function markDeliveryPhotoSent(orderId) {
  await query('UPDATE orders SET delivery_photo_sent_at = now() WHERE id = $1', [orderId]);
}

// Sends the delivered photo to the customer with a thank-you, once. It is the
// proof the shop did the work, and the reason the customer comes back. Called
// when the owner marks an order fulfilled; the `sent_at` stamp keeps a second
// fulfilment click from sending the picture twice. Never throws: a failed photo
// must not undo the order status the owner just set.
export async function sendDeliveryPhoto({ tenant, order, customerWaId }) {
  if (!tenant.wa_access_token || !tenant.wa_phone_number_id || !customerWaId) {
    return { sent: false, reason: 'not_connected' };
  }
  const photo = await deliveryPhotoToSend(tenant.id, order.id);
  if (!photo?.url) return { sent: false, reason: 'no_photo' };

  const name = order.recipient_name ? `${order.recipient_name} ji, ` : '';
  const body = `${name}flowers pahunch gaye 🌸 Umeed hai pasand aaye. `
    + 'Agla order 5 minute me — bas message kar dijiye. Dhanyavaad! 🙏';
  try {
    await sendWhatsAppImage({
      phoneNumberId: tenant.wa_phone_number_id,
      accessToken: tenant.wa_access_token,
      to: customerWaId,
      link: photo.url,
      caption: body,
    });
    await markDeliveryPhotoSent(order.id);
    return { sent: true, body };
  } catch (err) {
    console.error('Failed to send delivery photo', err.message);
    return { sent: false, reason: 'send_failed' };
  }
}

// Serves either kind of image by token. Public on purpose: WhatsApp fetches the
// picture from here with no cookie. The token is what keeps it unguessable.
export async function serveImage(kind, imageToken) {
  const data = kind === 'delivery'
    ? await getDeliveryPhotoByToken(imageToken)
    : await getProductPhotoByToken(imageToken);
  const match = data?.match(/^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/);
  if (!match) return null;
  return { contentType: match[1], buffer: Buffer.from(match[2], 'base64') };
}
