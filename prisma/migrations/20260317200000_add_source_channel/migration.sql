-- Add sourceChannel to ReturnCase (nullable — existing rows default to NULL = web/unknown)
ALTER TABLE "ReturnCase" ADD COLUMN IF NOT EXISTS "sourceChannel" TEXT;

-- Add index for channel filtering on returns list
CREATE INDEX IF NOT EXISTS "ReturnCase_shopId_sourceChannel_idx" ON "ReturnCase"("shopId", "sourceChannel");

-- Add channelPoliciesJson to ShopSettings (nullable JSON blob for per-channel policy overrides)
ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "channelPoliciesJson" TEXT;
