-- Add syncRefundToFynd toggle to ShopSettings (default false)
ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "syncRefundToFynd" BOOLEAN NOT NULL DEFAULT false;
