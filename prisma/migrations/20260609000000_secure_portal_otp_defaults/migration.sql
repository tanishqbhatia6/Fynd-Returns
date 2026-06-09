ALTER TABLE "ShopSettings"
  ALTER COLUMN "portalOtpEmailEnabled" SET DEFAULT TRUE,
  ALTER COLUMN "portalOtpSmsEnabled" SET DEFAULT TRUE;

UPDATE "ShopSettings"
SET
  "portalOtpEmailEnabled" = TRUE,
  "portalOtpSmsEnabled" = TRUE
WHERE
  "portalOtpEmailEnabled" = FALSE
  OR "portalOtpSmsEnabled" = FALSE;
