-- Phase 3 Enterprise: Full customer address fields for return pickup
ALTER TABLE "ReturnCase" ADD COLUMN IF NOT EXISTS "customerAddress1" TEXT;
ALTER TABLE "ReturnCase" ADD COLUMN IF NOT EXISTS "customerAddress2" TEXT;
ALTER TABLE "ReturnCase" ADD COLUMN IF NOT EXISTS "customerProvince" TEXT;
ALTER TABLE "ReturnCase" ADD COLUMN IF NOT EXISTS "customerZip" TEXT;
ALTER TABLE "ReturnCase" ADD COLUMN IF NOT EXISTS "customerLandmark" TEXT;
