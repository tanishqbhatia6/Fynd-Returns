-- Add Fynd Order ID and Shipment ID to ReturnCase for end-to-end visibility
ALTER TABLE "ReturnCase" ADD COLUMN IF NOT EXISTS "fyndOrderId" TEXT;
ALTER TABLE "ReturnCase" ADD COLUMN IF NOT EXISTS "fyndShipmentId" TEXT;
