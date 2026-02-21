-- Store full Fynd shipment/order payload for invoice, AWB, DP, logistics partner, etc.
ALTER TABLE "ReturnCase" ADD COLUMN IF NOT EXISTS "fyndPayloadJson" TEXT;
