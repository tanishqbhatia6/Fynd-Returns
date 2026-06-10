ALTER TABLE "ShopSettings"
  ADD COLUMN IF NOT EXISTS "billingPlanSelection" TEXT,
  ADD COLUMN IF NOT EXISTS "billingPlanSelectionAt" TIMESTAMP(3);
