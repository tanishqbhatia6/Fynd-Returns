-- Add composite performance indexes for common query patterns
-- These indexes speed up: returns list filters, dashboard date-range queries,
-- reports aggregations, and customer page groupBy operations.

-- ReturnCase: (shopId, status) — status-filtered counts on dashboard, returns list
CREATE INDEX IF NOT EXISTS "ReturnCase_shopId_status_idx" ON "ReturnCase"("shopId", "status");

-- ReturnCase: (shopId, createdAt) — date-range queries used on all pages
CREATE INDEX IF NOT EXISTS "ReturnCase_shopId_createdAt_idx" ON "ReturnCase"("shopId", "createdAt");

-- ReturnCase: (shopId, resolutionType) — resolution filter on returns list + retained revenue query
CREATE INDEX IF NOT EXISTS "ReturnCase_shopId_resolutionType_idx" ON "ReturnCase"("shopId", "resolutionType");

-- ReturnCase: (shopId, status, createdAt) — composite for common combined filters
CREATE INDEX IF NOT EXISTS "ReturnCase_shopId_status_createdAt_idx" ON "ReturnCase"("shopId", "status", "createdAt");

-- ReturnItem: (returnCaseId, reasonCode) — reason aggregation groupBy on dashboard/reports
CREATE INDEX IF NOT EXISTS "ReturnItem_returnCaseId_reasonCode_idx" ON "ReturnItem"("returnCaseId", "reasonCode");
