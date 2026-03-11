# 20 — Troubleshooting

> Diagnostic guide for common issues organized by category, with debug tools and error reference.

---

## Overview

This guide covers common issues merchants and developers encounter, organized by subsystem. Each entry includes symptoms, root cause, and resolution steps.

---

## Fynd Integration Issues

### Fynd Connection Test Fails with 401

**Symptoms:** "Fynd Platform OAuth error 401" when testing connection in Settings.

**Causes:**
- Incorrect Client ID or Client Secret
- Wrong Company ID
- Credentials copied with extra whitespace

**Resolution:**
1. Go to **Fynd Partners > Your App > OAuth** and re-copy Client ID and Secret.
2. Verify Company ID matches your Fynd Platform dashboard.
3. Re-paste credentials in **Settings > Integrations** and save.
4. Ensure the Fynd environment (UAT/Prod) matches where your app was created.

---

### Fynd Connection Test Fails with 403

**Symptoms:** "Fynd returned 403 Forbidden" or "Your app may lack required scopes."

**Causes:**
- OAuth app missing `company/orders/read` or `company/orders/write` scopes.
- App not authorized for the specified Company ID.

**Resolution:**
1. In **Fynd Partners > Your App > Scopes**, grant:
   - `company/orders/read`
   - `company/orders/write`
2. Save and re-test the connection.

---

### Fynd OAuth Timeout

**Symptoms:** "Fynd OAuth timed out after 5000ms."

**Causes:**
- Network connectivity issue between your server and Fynd API.
- Fynd API temporarily unavailable.
- Incorrect base URL.

**Resolution:**
1. Verify the Fynd environment setting (UAT vs. Prod).
2. If using a custom base URL, verify it is correct and accessible.
3. Check if Fynd status page reports issues.
4. Retry after a few minutes.

---

### Return Sync Fails (fyndSyncStatus = "failed")

**Symptoms:** Return approved but not appearing in Fynd. `fyndSyncStatus` shows "failed".

**Causes:**
- Order not found in Fynd (affiliate_order_id mismatch).
- Shipment already in return state ("Invalid State Transition").
- Network timeout during sync.

**Resolution:**
1. Check `fyndSyncError` on the return case detail page for the specific error.
2. If "Order not found": Verify the Shopify order has a matching order in Fynd.
3. If "Invalid State Transition": The return already exists on Fynd. Click "Refresh Fynd" to pull the latest data.
4. The retry engine will automatically retry up to 5 times with exponential backoff (2min, 5min, 15min, 1hr, 4hr).
5. Manual retry: Click "Sync to Fynd" on the return detail page.

---

### Fynd Webhook Not Being Received

**Symptoms:** Return status not updating from Fynd shipment changes.

**Causes:**
- Webhook URL not configured in Fynd Platform.
- Wrong webhook URL.
- Fynd webhook delivery failing (network/firewall).

**Resolution:**
1. In **Fynd Platform > Partners > Webhooks**, verify the URL is: `{YOUR_APP_URL}/api/webhooks/fynd`
2. Check **Settings > Webhook Logs** for received events.
3. Send a test webhook from Fynd and check logs.
4. Ensure your server is publicly accessible (not behind VPN/firewall).

---

### Duplicate Webhook Processing

**Symptoms:** Same Fynd event processed multiple times.

**Cause:** Fynd may retry webhook delivery if the initial response is slow.

**Resolution:** The handler includes deduplication logic that checks recent `FyndWebhookLog` entries. Duplicate events are logged with `action: "duplicate_ignored"`. No action needed -- this is handled automatically.

---

## Refund Issues

### Auto-Refund Not Triggering

**Symptoms:** Fynd shows "credit_note_generated" but no Shopify refund is created.

**Causes:**
- `autoRefundEnabled` is `false`.
- `allowedFyndStatusesForRefund` is set and the current Fynd status does not match.
- Cannot find matching Shopify order.

**Resolution:**
1. Enable **Settings > Return Settings > Auto-Refund**.
2. If using `allowedFyndStatusesForRefund`, verify the list includes the relevant status.
3. Check **Webhook Logs** for the event -- the `action` field shows what happened.
4. Look for errors in the log's `error` field.

---

### Refund Fails with "No restock location"

**Symptoms:** Manual or auto refund fails with location-related error.

**Causes:**
- `refundLocationMode` is "auto" but the order has no fulfillment location.
- `refundLocationId` fallback is not configured.

**Resolution:**
1. Go to **Settings > Return Settings > Refund Location**.
2. Set `refundLocationId` to a valid Shopify location GID as fallback.
3. Alternatively, switch to "manual" mode where admin selects location per refund.

---

### Partial Refund Amount Incorrect

**Symptoms:** Refund amount does not match expected value.

**Causes:**
- Return fee deducted from refund amount.
- Only selected items are included in the refund calculation.
- Discount code value already applied.

**Resolution:**
1. Check if `returnFeeAmount` is configured (deducted from refund).
2. Verify only the returned items' prices are summed.
3. Check the `refundJson` field on the return case for the full refund breakdown.

---

## Portal Issues

### Portal Shows "No results found"

**Symptoms:** Customer enters order number but sees no results.

**Causes:**
- Order number format mismatch (with/without `#` prefix).
- Customer email does not match Shopify order email.
- Order is outside the return window.
- `portalAllowedFulfillmentStatuses` blocks the order's current status.

**Resolution:**
1. Try both formats: `#1001` and `1001`.
2. Verify the customer email matches the Shopify order.
3. Check `returnWindowDays` setting.
4. Check `portalAllowedFulfillmentStatuses` in settings.

---

### Portal Return Submission Fails

**Symptoms:** "Failed to submit" error on the portal.

**Causes:**
- Customer blocked by blocklist.
- Product restricted by tags.
- Region restricted.
- Order in no-return period.
- Server error.

**Resolution:**
1. Check if the customer is on the **blocklist** (Settings > Blocklist).
2. Check `restrictedProductTagsJson` and `restrictedRegionsJson` settings.
3. Check `noReturnPeriodEnabled` and date range.
4. Check server logs for the specific error.

---

### OTP Email Not Received

**Symptoms:** Customer requests OTP but never receives the email.

**Causes:**
- SMTP not configured.
- Email going to spam.
- Incorrect customer email.

**Resolution:**
1. Verify SMTP is configured in **Settings > Notifications**.
2. Test SMTP connection using the "Test Connection" button.
3. Check **Notification Log** for send status.
4. Ask customer to check spam/junk folder.

---

### Portal Theme Not Applying

**Symptoms:** Portal shows default colors/fonts instead of customized theme.

**Causes:**
- `portalThemeJson` contains invalid JSON.
- Browser caching old styles.

**Resolution:**
1. Re-save theme settings in **Settings > Widget**.
2. Hard refresh the portal page (Ctrl+Shift+R).
3. Check browser console for JSON parse errors.

---

## Notification Issues

### Emails Not Being Sent

**Symptoms:** No emails received for any return events.

**Causes:**
- SMTP not configured (all fields required: host, user, pass).
- Notification toggles disabled.
- SMTP credentials invalid.

**Resolution:**
1. Configure SMTP in **Settings > Notifications**.
2. Use the "Test Connection" button to verify.
3. Check that notification toggles are enabled for the desired events.
4. Check **Notification Log** for failures and error messages.

---

### SMTP Authentication Error

**Symptoms:** "Authentication failed" or "Invalid login" in notification logs.

**Causes:**
- Wrong username/password.
- Gmail requires App Password (not regular password) when 2FA is enabled.
- Account security blocking "less secure apps".

**Resolution:**
1. For Gmail: Create an App Password at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords).
2. For Outlook: Generate App Password in security settings.
3. For SendGrid: Use `apikey` as username and your API key as password.

---

### WhatsApp Messages Not Delivered

**Symptoms:** WhatsApp notifications configured but not received.

**Causes:**
- `whatsappEnabled` is `false`.
- Invalid API key or Phone Number ID.
- Customer phone number not in E.164 format.
- Meta Cloud API template not approved.

**Resolution:**
1. Verify WhatsApp is enabled with correct provider and API key.
2. Ensure Phone Number ID is correct (Meta Business Manager > Phone Numbers).
3. Verify customer phone is in E.164 format (e.g., `+911234567890`).
4. Check **Notification Log** for specific API error messages.

---

## Database Issues

### "Prisma client not generated"

**Symptoms:** Server fails to start with Prisma client error.

**Resolution:**
```bash
npx prisma generate
```

---

### Migration Fails

**Symptoms:** `prisma db push` fails during deployment.

**Causes:**
- Breaking schema change with existing data.
- Database connection refused.

**Resolution:**
1. Check the error message for the specific constraint violation.
2. Verify `DATABASE_URL` is correct and the database is accessible.
3. For breaking changes, create a migration with data transformation:
   ```bash
   npx prisma migrate dev --name fix_schema
   ```

---

### Slow Queries

**Symptoms:** Dashboard or returns list loads slowly.

**Causes:**
- Missing database indexes.
- Large number of return cases without date filtering.

**Resolution:**
1. Ensure all indexes from `schema.prisma` are applied:
   ```bash
   npx prisma db push
   ```
2. Use date range filters on the dashboard and reports.
3. Consider archiving old data (90+ day webhook logs are auto-cleaned).

---

## Debug Tools

### Webhook Logs

**Location:** Settings > Webhook Logs (`/app/settings/webhook-logs`)

View all incoming Fynd webhooks with:
- Extracted fields (shipment ID, order ID, status)
- Action taken (ignored, status_updated, refund_completed, error)
- Full raw payload (expandable)
- Error messages

### Notification Log

**Location:** Database table `NotificationLog`

Query via Prisma or database client:
```sql
SELECT * FROM "NotificationLog"
WHERE "shopId" = 'your-shop-id'
ORDER BY "createdAt" DESC
LIMIT 50;
```

### Fynd API Test Scripts

```bash
# Test Fynd API connectivity
npm run test:fynd-api

# Test via curl (bash)
npm run test:fynd-api:bash
```

Required environment variables:
```
FYND_CLIENT_ID=your_client_id
FYND_CLIENT_SECRET=your_secret
FYND_COMPANY_ID=2263
FYND_ORDER_ID=FYMP698CC01401C9F4A1
```

### Encryption Key Validation

```bash
npm run validate:key
```

Verifies `ENCRYPTION_KEY` is a valid 64-character hex string.

### Return Case Debug Fields

Each return case has debug fields visible on the detail page:

| Field                | Description                                    |
|----------------------|------------------------------------------------|
| `fyndSyncStatus`     | Current sync state                             |
| `fyndSyncRetries`    | Number of retry attempts                       |
| `fyndSyncError`      | Last sync error message                        |
| `fyndSyncNextRetry`  | Scheduled next retry time                      |
| `fyndCurrentStatus`  | Latest Fynd shipment status from webhook       |
| `lastFyndStatusCheck`| Last time Fynd status was polled               |

---

## Error Reference

### Common Error Codes

| Error                                    | Category | Description                                     |
|------------------------------------------|----------|-------------------------------------------------|
| `Fynd Platform OAuth error 401`          | Fynd     | Invalid credentials                              |
| `Fynd returned 403 Forbidden`            | Fynd     | Missing OAuth scopes                             |
| `Fynd OAuth timed out after 5000ms`      | Fynd     | Network timeout                                  |
| `Fynd API timed out after 5000ms`        | Fynd     | API call timeout                                 |
| `Order not found in Fynd`                | Fynd     | No matching order on Fynd Platform               |
| `Invalid State Transition`               | Fynd     | Shipment already in return state                 |
| `Could not determine Fynd shipment ID`   | Fynd     | No shipment found in Fynd response               |
| `Manual returns cannot be synced to Fynd`| Fynd     | Manual return has no Shopify order               |
| `No access_token in OAuth response`      | Fynd     | Fynd OAuth returned unexpected response          |
| `Could not read stored credentials`      | Encrypt  | Wrong `ENCRYPTION_KEY` or corrupted data         |
| `Fynd credentials are not set`           | Config   | No credentials saved in settings                 |
| `Company ID is required`                 | Config   | Missing `fyndCompanyId`                          |
| `Application ID is missing`              | Config   | Missing `fyndApplicationId`                      |
| `UNAUTHORIZED`                           | API      | Missing or invalid API key                       |
| `FORBIDDEN`                              | API      | API key lacks required permission                |
| `RATE_LIMITED`                           | API      | Too many API requests                            |
| `NOT_FOUND`                              | API      | Resource not found                               |
| `INVALID_STATE`                          | API      | Return in terminal state (cannot change)         |
| `Authentication failed`                  | Email    | SMTP credentials invalid                         |
| `Connection timeout`                     | Email    | SMTP server unreachable                          |
| `Meta Cloud WhatsApp API error`          | WhatsApp | Meta API rejected the request                    |

---

## Support Checklist

When reporting an issue, gather the following information:

1. **Shop domain** (e.g., `mystore.myshopify.com`)
2. **Return case ID** or **Return Request Number** (e.g., `RPM-A1B2C3D4`)
3. **Fynd environment** (UAT or Prod)
4. **Error message** (exact text from UI or logs)
5. **Webhook logs** (for Fynd-related issues)
6. **Notification logs** (for email/WhatsApp issues)
7. **Browser console output** (for portal UI issues)
8. **Server deployment logs** (for startup/crash issues)

---

## Related Files

| File                                    | Purpose                                  |
|-----------------------------------------|------------------------------------------|
| `app/lib/fynd-retry.server.ts`          | Retry engine debug logging               |
| `app/lib/fynd-webhook.server.ts`        | Webhook handler with detailed logging    |
| `app/lib/notification.server.ts`        | Notification error handling              |
| `app/routes/app.settings.webhook-logs.tsx` | Webhook log viewer UI                 |
| `scripts/validate-encryption-key.js`    | Encryption key validator                 |
| `scripts/test-fynd-apis.mjs`           | Fynd API connectivity test               |
