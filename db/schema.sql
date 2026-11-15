-- BudsBox multi-tenant schema.
-- Every tenant-scoped table carries tenant_id so row access can be filtered
-- per tenant without cross-tenant joins.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Tenants
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tenants (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              TEXT NOT NULL UNIQUE,
  business_name     TEXT NOT NULL,
  owner_email       TEXT NOT NULL,
  owner_phone       TEXT,
  -- Lifecycle: trialing -> active, or trialing -> suspended
  status            TEXT NOT NULL DEFAULT 'trialing'
                    CHECK (status IN ('trialing', 'active', 'suspended', 'cancelled')),
  trial_started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  trial_ends_at     TIMESTAMPTZ NOT NULL,
  -- WhatsApp Cloud API wiring, per tenant
  wa_phone_number_id TEXT UNIQUE,
  wa_access_token   TEXT,
  wa_verify_token   TEXT,
  -- Shop profile the AI speaks in. It is what makes a reply sound like the
  -- shop owner rather than a bot, so it is part of the tenant, not a setting.
  shop_address      TEXT,
  shop_hours        TEXT,
  shop_delivery     TEXT,
  shop_tone         TEXT,
  shop_instructions TEXT,
  -- Set when the trial-expiry cron disconnects the tenant
  disconnected_at   TIMESTAMPTZ,
  disconnect_reason TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tenants_status_idx ON tenants (status);
CREATE INDEX IF NOT EXISTS tenants_trial_ends_idx ON tenants (trial_ends_at)
  WHERE status = 'trialing';
CREATE INDEX IF NOT EXISTS tenants_wa_phone_idx ON tenants (wa_phone_number_id);

-- ---------------------------------------------------------------------------
-- Users (dashboard logins), scoped to a tenant
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  email          TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  role           TEXT NOT NULL DEFAULT 'owner'
                 CHECK (role IN ('owner', 'staff')),
  last_login_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, email)
);

CREATE INDEX IF NOT EXISTS users_tenant_idx ON users (tenant_id);

-- ---------------------------------------------------------------------------
-- Dashboard sessions
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_token_idx ON sessions (token_hash);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions (expires_at);

-- ---------------------------------------------------------------------------
-- Customers
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  wa_id        TEXT NOT NULL,
  display_name TEXT,
  phone        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, wa_id)
);

CREATE INDEX IF NOT EXISTS customers_tenant_idx ON customers (tenant_id);

-- ---------------------------------------------------------------------------
-- Products (catalog)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  sku         TEXT,
  name        TEXT NOT NULL,
  description TEXT,
  -- Minor units (cents) so money never touches floating point
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  currency    TEXT NOT NULL DEFAULT 'INR',
  active      BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, sku)
);

CREATE INDEX IF NOT EXISTS products_tenant_active_idx ON products (tenant_id, active);

-- ---------------------------------------------------------------------------
-- Orders
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  customer_id   UUID REFERENCES customers (id) ON DELETE SET NULL,
  -- WhatsApp message id, so webhook retries stay idempotent
  wa_message_id TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending', 'confirmed', 'fulfilled', 'cancelled')),
  total_cents   INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  currency      TEXT NOT NULL DEFAULT 'INR',
  notes         TEXT,
  raw_message   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_tenant_created_idx ON orders (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_customer_idx ON orders (customer_id);
-- NULLs are distinct in a unique index, so orders without a WhatsApp id
-- coexist while repeated webhook deliveries stay deduplicated.
CREATE UNIQUE INDEX IF NOT EXISTS orders_wa_message_uniq
  ON orders (tenant_id, wa_message_id);

-- ---------------------------------------------------------------------------
-- Order line items
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  order_id    UUID NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id  UUID REFERENCES products (id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  quantity    INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);
CREATE INDEX IF NOT EXISTS order_items_tenant_idx ON order_items (tenant_id);

-- ---------------------------------------------------------------------------
-- Inbound webhook audit log
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhook_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID REFERENCES tenants (id) ON DELETE SET NULL,
  wa_message_id TEXT,
  event_type    TEXT NOT NULL,
  payload       JSONB NOT NULL,
  processed     BOOLEAN NOT NULL DEFAULT false,
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_events_tenant_idx ON webhook_events (tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_events_msg_uniq
  ON webhook_events (wa_message_id);

-- ---------------------------------------------------------------------------
-- Outbound + inbound message history
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  customer_id   UUID REFERENCES customers (id) ON DELETE SET NULL,
  order_id      UUID REFERENCES orders (id) ON DELETE SET NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  body          TEXT NOT NULL,
  wa_message_id TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_tenant_created_idx ON messages (tenant_id, created_at DESC);

-- Inbound messages are claimed by WhatsApp id, so a webhook retry cannot
-- create a second order or a second reply. Outbound rows carry no id, and
-- NULLs are distinct in a unique index, so they are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS messages_wa_message_uniq
  ON messages (tenant_id, wa_message_id);

-- ---------------------------------------------------------------------------
-- keep updated_at fresh
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tenants_touch ON tenants;
CREATE TRIGGER tenants_touch BEFORE UPDATE ON tenants
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

DROP TRIGGER IF EXISTS orders_touch ON orders;
CREATE TRIGGER orders_touch BEFORE UPDATE ON orders
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
-- Additive migrations. CREATE TABLE IF NOT EXISTS above never adds a column to
-- a table that already exists, so new tenant columns are added here.
-- ---------------------------------------------------------------------------
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS shop_address      TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS shop_hours        TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS shop_delivery     TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS shop_tone         TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS shop_instructions TEXT;

-- Delivery details on an order. The AI fills these from the thread as the
-- customer talks ("kal shaam 6 baje, 12 Gandhi Road"), so a florist can act on
-- an order without asking the customer anything again.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfilment      TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_at     TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_note   TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS recipient_name  TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS recipient_phone TEXT;

-- Payment. A florist takes the money before the flowers leave, so an order is
-- not done until it is paid. `unpaid` is the only non-terminal state; the shop
-- owner marks `paid` or `refunded` by hand after seeing the transfer land.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT NOT NULL DEFAULT 'unpaid';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_method TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at        TIMESTAMPTZ;

-- The shop's own UPI id, so the AI can share it without the owner retyping it
-- on every order.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS shop_upi_id TEXT;

-- The shop's own payment QR, stored as a data URL so no file host is needed.
-- The token is what the public image URL uses; without it the QR is not
-- reachable by guessing ids.
-- The name that shows up in the UPI app after scanning the shop's QR. Sent to
-- the customer with the QR so they can check the money reaches the right shop
-- and not somewhere else.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS shop_payment_name TEXT;

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS shop_payment_qr TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS shop_payment_qr_token TEXT;
CREATE INDEX IF NOT EXISTS tenants_qr_token_idx ON tenants (shop_payment_qr_token)
  WHERE shop_payment_qr_token IS NOT NULL;

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check
  CHECK (payment_status IN ('unpaid', 'paid', 'refunded'));

-- ---------------------------------------------------------------------------
-- Razorpay subscriptions
-- ---------------------------------------------------------------------------
-- When the current paid period ends. Null while the shop is only trialing.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS paid_until TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plan TEXT;

-- One row per checkout attempt. The webhook is the source of truth for money
-- arriving; a row is only marked paid when Razorpay says so, never when the
-- browser says so.
CREATE TABLE IF NOT EXISTS payments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  plan              TEXT NOT NULL,
  amount_cents      INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'INR',
  razorpay_order_id TEXT UNIQUE,
  razorpay_payment_id TEXT,
  status            TEXT NOT NULL DEFAULT 'created'
                    CHECK (status IN ('created', 'paid', 'failed')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS payments_tenant_idx ON payments (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS payments_order_idx ON payments (razorpay_order_id);
