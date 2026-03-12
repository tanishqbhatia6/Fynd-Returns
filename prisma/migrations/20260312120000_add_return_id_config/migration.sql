-- AlterTable: Add return ID pattern configuration fields to ShopSettings
ALTER TABLE "ShopSettings" ADD COLUMN "returnIdConfigJson" TEXT;
ALTER TABLE "ShopSettings" ADD COLUMN "returnIdCounter" INTEGER NOT NULL DEFAULT 0;
