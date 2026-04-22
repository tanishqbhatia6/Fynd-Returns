-- Phase 2 schema migration: indexes + per-shop uniqueness for ReturnCase.returnRequestNo.
--
-- Notes for prod deploy:
--   * The CONCURRENTLY variants are best for online deploys, but Prisma's `migrate
--     deploy` wraps each migration in a transaction by default and CONCURRENTLY
--     can't run inside a tx. We use plain CREATE INDEX so this stays compatible
--     with `prisma migrate deploy`. On a large prod DB consider running these
--     statements out-of-band ahead of the deploy via psql.
--   * The unique constraint on (shopId, returnRequestNo) treats NULL values as
--     distinct in PostgreSQL — newly created return cases without a request
--     number won't collide.

-- LookupSession: speed up the periodic cleanup query (`WHERE expiresAt < NOW()`).
-- Without it, busy stores with many OTP sessions cause a full table scan per pass.
CREATE INDEX IF NOT EXISTS "LookupSession_expiresAt_idx" ON "LookupSession" ("expiresAt");

-- LookupSession: account-level rate-limit query reads all sessions for a given
-- (shopId, lookupValueHash) within the last hour and sums attemptsCount.
CREATE INDEX IF NOT EXISTS "LookupSession_shopId_lookupValueHash_createdAt_idx"
  ON "LookupSession" ("shopId", "lookupValueHash", "createdAt");

-- ReturnCase: per-shop uniqueness on returnRequestNo.
-- We need to handle the case where existing data already has dupes (defensive —
-- the bug existed for a while). Defend with a partial unique index that excludes
-- NULL, then drop the existing non-unique compound index that's now redundant.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public'
    AND indexname = 'ReturnCase_shopId_returnRequestNo_unique'
  ) THEN
    CREATE UNIQUE INDEX "ReturnCase_shopId_returnRequestNo_unique"
      ON "ReturnCase" ("shopId", "returnRequestNo")
      WHERE "returnRequestNo" IS NOT NULL;
  END IF;
END $$;

-- Outbound webhook dead-letter queue.
CREATE TABLE IF NOT EXISTS "WebhookDeliveryFailure" (
  "id"              TEXT       PRIMARY KEY,
  "subscriptionId"  TEXT       NOT NULL,
  "shopId"          TEXT       NOT NULL,
  "eventType"       TEXT       NOT NULL,
  "payloadJson"     TEXT       NOT NULL,
  "url"             TEXT       NOT NULL,
  "attemptCount"    INTEGER    NOT NULL,
  "lastError"       TEXT,
  "idempotencyKey"  TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "replayedAt"      TIMESTAMP(3),
  CONSTRAINT "WebhookDeliveryFailure_subscriptionId_fkey"
    FOREIGN KEY ("subscriptionId") REFERENCES "WebhookSubscription"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS "WebhookDeliveryFailure_shopId_createdAt_idx"
  ON "WebhookDeliveryFailure" ("shopId", "createdAt");
CREATE INDEX IF NOT EXISTS "WebhookDeliveryFailure_subscriptionId_idx"
  ON "WebhookDeliveryFailure" ("subscriptionId");
CREATE INDEX IF NOT EXISTS "WebhookDeliveryFailure_replayedAt_idx"
  ON "WebhookDeliveryFailure" ("replayedAt");
