-- Shopify Managed Pricing — per-shop billing override + cached subscription status.
--
-- Columns are nullable so existing ShopSettings rows migrate in-place; the
-- billing gate in app/lib/billing.server.ts falls back to the APP_BILLING_MODE
-- env var when billingPlanOverride is null.
--
-- See SHOPIFY_APP_STORE_READINESS.md §4 for the billing architecture.

ALTER TABLE "ShopSettings"
  ADD COLUMN IF NOT EXISTS "billingPlanOverride"       TEXT,
  ADD COLUMN IF NOT EXISTS "billingPlanOverrideReason" TEXT,
  ADD COLUMN IF NOT EXISTS "billingPlanOverrideBy"     TEXT,
  ADD COLUMN IF NOT EXISTS "billingPlanOverrideAt"     TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "subscriptionStatus"        TEXT,
  ADD COLUMN IF NOT EXISTS "subscriptionName"          TEXT,
  ADD COLUMN IF NOT EXISTS "subscriptionCheckedAt"     TIMESTAMP(3);
