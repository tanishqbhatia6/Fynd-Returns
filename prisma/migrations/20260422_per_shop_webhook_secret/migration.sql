-- Per-shop Fynd webhook signing secret. Encrypted at rest (AES-256-GCM via
-- encryption.server.ts), used by the new per-shop webhook route
-- /api/webhooks/fynd/:shopId to verify X-Fynd-Signature.
--
-- Existing shops will have NULL until the merchant generates one from
-- Settings → Integrations. The legacy /api/webhooks/fynd endpoint with the
-- global FYND_WEBHOOK_SECRET keeps working unchanged so no merchant breaks
-- on the day this ships.
ALTER TABLE "ShopSettings"
  ADD COLUMN IF NOT EXISTS "fyndWebhookSecret" TEXT;
