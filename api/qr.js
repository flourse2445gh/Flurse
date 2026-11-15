import { query } from '../lib/db.js';
import { handler, error } from '../lib/http.js';

// GET /api/qr?t=<token> -> the shop's payment QR as an image.
//
// Public on purpose: a payment QR is meant to be shown to customers, and
// WhatsApp fetches the picture from here to deliver it. The token keeps it
// unguessable, so a shop's QR is not reachable by trying ids.
export default handler(async (req, res) => {
  const token = new URL(req.url, 'http://localhost').searchParams.get('t');
  if (!token) {
    error(res, 400, 'token is required');
    return;
  }

  const { rows } = await query(
    'SELECT shop_payment_qr FROM tenants WHERE shop_payment_qr_token = $1',
    [token],
  );
  const dataUrl = rows[0]?.shop_payment_qr;
  const match = dataUrl && dataUrl.match(/^data:(image\/(?:png|jpe?g|webp));base64,(.+)$/);
  if (!match) {
    error(res, 404, 'No payment QR for this shop');
    return;
  }

  res.statusCode = 200;
  res.setHeader('Content-Type', match[1]);
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.end(Buffer.from(match[2], 'base64'));
});
