-- Phase 3 Enterprise: WhatsApp/SMS notification settings
ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "whatsappEnabled" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "whatsappProvider" TEXT;
ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "whatsappApiKey" TEXT;
ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "whatsappPhoneNumberId" TEXT;
ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "whatsappFromNumber" TEXT;
