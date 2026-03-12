-- AlterTable: Add Fynd return initiation status gate to ShopSettings
ALTER TABLE "ShopSettings" ADD COLUMN "allowedFyndStatusesForReturn" TEXT;

-- AlterTable: Add CRM/admin return fields to ReturnCase
ALTER TABLE "ReturnCase" ADD COLUMN "createdByChannel" TEXT;
ALTER TABLE "ReturnCase" ADD COLUMN "createdByStaff" TEXT;
ALTER TABLE "ReturnCase" ADD COLUMN "crmTicketId" TEXT;
ALTER TABLE "ReturnCase" ADD COLUMN "crmNotes" TEXT;
