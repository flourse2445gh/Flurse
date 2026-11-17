import crypto from 'node:crypto';
import { withTransaction } from '../lib/db.js';
import { hashPassword, createSession, sessionCookie } from '../lib/auth.js';
import { trialEndDate, slugify, daysLeft } from '../lib/trial.js';
import { handler, readJson, json, requireMethod, HttpError } from '../lib/http.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /api/onboard
// Creates a tenant + owner user, starts the 14-day trial, and logs the owner in.
export default handler(async (req, res) => {
  if (!requireMethod(req, res, ['POST'])) return;

  const body = await readJson(req);
  const businessName = String(body.business_name ?? '').trim();
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  const phone = body.phone ? String(body.phone).trim() : null;
  const waPhoneNumberId = body.wa_phone_number_id ? String(body.wa_phone_number_id).trim() : null;

  if (!businessName) throw new HttpError(400, 'business_name is required');
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'A valid email is required');

  const slug = slugify(businessName) || `shop-${Date.now().toString(36)}`;
  const trialEndsAt = trialEndDate();

  const result = await withTransaction(async (client) => {
    const { rows: existing } = await client.query(
      'SELECT 1 FROM tenants WHERE slug = $1',
      [slug],
    );
    if (existing.length) throw new HttpError(409, 'That business name is taken');

    const { rows: tenantRows } = await client.query(
      `INSERT INTO tenants
         (slug, business_name, owner_email, owner_phone, status,
          trial_ends_at, wa_phone_number_id, wa_verify_token)
       VALUES ($1, $2, $3, $4, 'trialing', $5, $6, $7)
       RETURNING id, slug, business_name, status, trial_ends_at`,
      [
        slug,
        businessName,
        email,
        phone,
        trialEndsAt,
        waPhoneNumberId,
        crypto.randomUUID(),
      ],
    );
    const tenant = tenantRows[0];

    const { rows: userRows } = await client.query(
      `INSERT INTO users (tenant_id, email, password_hash, role)
       VALUES ($1, $2, $3, 'owner')
       RETURNING id`,
      [tenant.id, email, hashPassword(password)],
    );

    return { tenant, userId: userRows[0].id };
  });

  const { token, expiresAt } = await createSession(result.userId, result.tenant.id);
  res.setHeader('Set-Cookie', sessionCookie(token, expiresAt));

  json(res, 201, {
    tenant: {
      slug: result.tenant.slug,
      businessName: result.tenant.business_name,
      status: result.tenant.status,
      trialEndsAt: result.tenant.trial_ends_at,
      daysLeft: daysLeft(result.tenant.trial_ends_at),
    },
  });
});
