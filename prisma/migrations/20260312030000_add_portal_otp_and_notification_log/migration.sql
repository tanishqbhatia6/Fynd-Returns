-- Add portal OTP settings to ShopSettings
ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "portalOtpEmailEnabled" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "ShopSettings" ADD COLUMN IF NOT EXISTS "portalOtpSmsEnabled" BOOLEAN NOT NULL DEFAULT FALSE;

-- Create NotificationLog table
CREATE TABLE IF NOT EXISTS "NotificationLog" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "returnCaseId" TEXT,
    "channel" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "subject" TEXT,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotificationLog_pkey" PRIMARY KEY ("id")
);

-- Create indexes for NotificationLog
CREATE INDEX IF NOT EXISTS "NotificationLog_shopId_createdAt_idx" ON "NotificationLog"("shopId", "createdAt");
CREATE INDEX IF NOT EXISTS "NotificationLog_returnCaseId_idx" ON "NotificationLog"("returnCaseId");
