-- Phase 3 Enterprise: Per-item return condition for fraud prevention and warehouse receiving
ALTER TABLE "ReturnItem" ADD COLUMN IF NOT EXISTS "condition" TEXT;
-- Allowed values: "unused" | "used_good" | "used_damaged" | "defective"
