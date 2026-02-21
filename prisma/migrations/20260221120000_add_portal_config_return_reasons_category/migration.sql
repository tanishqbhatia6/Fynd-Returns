-- Add portal config (which pages/tabs to show) and return reasons by category
ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "portalConfigJson" TEXT;
ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "returnReasonsByCategoryJson" TEXT;
