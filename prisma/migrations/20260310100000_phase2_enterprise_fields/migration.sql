-- Phase 2 Enterprise Fields Migration
-- ShopSettings: portal exchange, configurable allowed statuses, Fynd consolidation
ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "portalExchangeEnabled" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "portalAllowedFulfillmentStatuses" TEXT;
ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "fyndConsolidateReturns" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "fyndConsolidateWindowHours" INTEGER NOT NULL DEFAULT 4;

-- ReturnCase: customer exchange preference from portal
ALTER TABLE "ReturnCase" ADD COLUMN IF NOT EXISTS "exchangePreference" TEXT;
