-- AlterTable
ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "fyndEnvironment" TEXT;
ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "fyndCustomBaseUrl" TEXT;
ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "appMode" TEXT;
