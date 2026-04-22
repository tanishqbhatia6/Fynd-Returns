# 08 — Fynd Platform Integration

> Deep integration with Fynd Commerce for order lookup, return creation, shipment tracking, auto-refund, and webhook-driven status synchronization.

---

## Overview

ReturnProMax integrates with **Fynd Platform** (Fynd Commerce) to:

1. Look up orders and shipments by external order ID (Shopify order name).
2. Create returns on Fynd by transitioning shipment status to `return_initiated`.
3. Receive webhook updates for shipment/return status changes and refund events.
4. Auto-trigger Shopify refunds when Fynd reports `credit_note_generated`.
5. Consolidate multiple return cases into batched Fynd returns.
6. Retry failed syncs with exponential backoff.

All Fynd operations use the **Platform API** (OAuth `client_credentials` flow). The Storefront API is not used for return operations.

---

## Credentials Setup

### Required Credentials

| Field                | Source                              | Storage                        |
|----------------------|-------------------------------------|--------------------------------|
| **Company ID**       | Fynd Platform dashboard             | `ShopSettings.fyndCompanyId`   |
| **Application ID**   | Fynd Platform > Sales Channel       | `ShopSettings.fyndApplicationId` |
| **Client ID**        | Fynd Partners > OAuth App           | Encrypted in `fyndCredentials` |
| **Client Secret**    | Fynd Partners > OAuth App           | Encrypted in `fyndCredentials` |
| **Environment**      | `"uat"` or `"prod"`                 | `ShopSettings.fyndEnvironment` |
| **Custom Base URL**  | Optional override                   | `ShopSettings.fyndCustomBaseUrl` |

### Environment Base URLs

| Environment | Base URL                          |
|-------------|-----------------------------------|
| `uat`       | `https://api.fynd.com` (UAT)     |
| `prod`      | `https://api.fynd.com`           |
| Custom      | Any valid HTTPS URL               |

The base URL is resolved by `getFyndBaseUrl()` in `fynd-config.server.ts`.

### Required OAuth Scopes

The Fynd OAuth app must have these scopes granted in Fynd Partners:

- `company/orders/read`
- `company/orders/write`

Without write scope, return creation will fail with HTTP 403.

---

## Credential Encryption

Fynd credentials are stored encrypted in the database using AES encryption.

```
Plaintext JSON → encrypt(JSON.stringify(credentials)) → stored in fyndCredentials column
```

The `ENCRYPTION_KEY` environment variable (64 hex characters) is required. Decryption happens at runtime via `decrypt()` from `encryption.server.ts`.

### Credential Format (Normalized)

```typescript
type NormalizedFyndCreds = {
  platform?: { clientId: string; clientSecret: string };
  storefront?: { applicationToken: string };
};
```

The system accepts multiple legacy formats (flat `clientId`/`clientSecret`, nested `platform` object, snake_case variants) and normalizes them via `normalizeCredentials()`.

---

## Connection Testing

### Test Platform Connection

`testPlatformConnectionRaw()` validates credentials by:

1. Requesting an OAuth token via `POST /service/panel/authentication/v1.0/company/{companyId}/oauth/token`.
2. Making a lightweight `GET /service/platform/order/v1.0/company/{companyId}/orders-listing?page_no=1&page_size=1` call.
3. Returning `{ ok: true }` on success or `{ ok: false, error: "..." }` with actionable hints.

### Error Hints

| HTTP Status | Hint                                                                      |
|-------------|---------------------------------------------------------------------------|
| 401         | "Check Company ID, Client ID & Secret."                                   |
| 403         | "Your OAuth app needs company/orders/read and company/orders/write scopes."|
| 5xx         | "Fynd server error. Try again later."                                     |
| Network     | "Could not reach Fynd OAuth. Check base URL and internet connection."     |

---

## OAuth Token Management

### Token Acquisition

```
POST {baseUrl}/service/panel/authentication/v1.0/company/{companyId}/oauth/token
Authorization: Basic base64(clientId:clientSecret)
Body: { "grant_type": "client_credentials" }
```

### Token Caching

- Tokens are cached in memory with a TTL of min(`expires_in`, 50 minutes).
- Cache key: `{baseUrl}:{companyId}:{clientId}`.
- Maximum cache size: 50 entries. LRU eviction when exceeded.
- OAuth request timeout: 5 seconds.

---

## Fynd API Calls

### Client Architecture

Two client classes exist; only `FyndPlatformClient` is used for return operations:

| Client                 | Auth Method          | Used For                              |
|------------------------|----------------------|---------------------------------------|
| `FyndPlatformClient`   | Bearer token (OAuth) | Orders, returns, file signing         |
| `FyndStorefrontClient`  | Basic auth           | Languages, bag reasons (not for returns) |

### Platform API Endpoints Used

| Method | Path Pattern                                                      | Purpose                         |
|--------|-------------------------------------------------------------------|---------------------------------|
| GET    | `/service/platform/order/v1.0/company/{cid}/orders-listing`      | Connection test                 |
| GET    | `/service/platform/order/v1.0/company/{cid}/order-details`       | Get shipments for an order      |
| GET    | `/service/platform/order/v1.0/company/{cid}/shipments-listing`   | Search shipments by external ID |
| PUT    | `/service/platform/order-manage/v1.0/company/{cid}/shipment/status-internal` | Create return (status transition) |
| POST   | `/service/platform/assets/v1.0/company/{cid}/sign-urls/`         | Sign private Fynd asset URLs    |

All requests have a 5-second timeout with `AbortController`.

---

## Return Sync Flow

When a return is approved, the system syncs it to Fynd via `createReturnOnFynd()`:

### Step-by-Step Flow

```
1. Validate: Reject manual returns (shopifyOrderId starts with "manual:")
2. Resolve Order ID:
   a. Use affiliateOrderId from Shopify order customAttributes (preferred)
   b. Fall back to stored fyndOrderId
   c. Fall back to shopifyOrderName (stripped of "#" prefix)
3. Search Fynd: searchShipmentsByExternalOrderId() to resolve the Fynd internal order/shipment IDs
4. Get Shipments: getShipments(fyndOrderId) to fetch full shipment details
5. Build Payload:
   a. Map return items to Fynd products (SKU-based line items)
   b. Map return reasons to Fynd reason format (reason_id + reason_text)
   c. Include delivery_address from customer pickup address if available
6. Create Return: updateShipmentStatus() with status = "return_initiated"
7. Handle Response:
   a. Success (200): Extract fyndReturnId, fyndReturnNo from response
   b. Already exists: If "Invalid State Transition", treat as success with alreadyExists flag
   c. Failure: Return error message
```

### Fynd Return Payload Format

```json
{
  "statuses": [{
    "shipments": [{
      "identifier": "FYMP...",
      "products": [
        { "line_number": 1, "quantity": 1, "identifier": "SKU-001" }
      ],
      "reasons": {
        "products": [{
          "filters": [{ "identifier": "SKU-001", "line_number": 1, "quantity": 1 }],
          "data": { "reason_id": 122, "reason_text": "Wrong size" }
        }]
      }
    }],
    "status": "return_initiated"
  }],
  "task": false,
  "force_transition": false,
  "lock_after_transition": false,
  "unlock_before_transition": false
}
```

### Sync Status Tracking

Each return case tracks its Fynd sync state:

| Field              | Type       | Description                                      |
|--------------------|------------|--------------------------------------------------|
| `fyndSyncStatus`   | `String?`  | `pending`, `synced`, `failed`, `retry_scheduled`, `processing`, `pending_consolidation` |
| `fyndSyncRetries`  | `Int`      | Number of retry attempts (max 5)                 |
| `fyndSyncError`    | `String?`  | Last error message (up to 2000 chars)            |
| `fyndSyncNextRetry`| `DateTime?`| When to attempt next retry                       |

---

## Retry Engine

Failed Fynd syncs are retried automatically with exponential backoff.

### Configuration

| Parameter           | Value                          |
|---------------------|--------------------------------|
| **Max Retries**     | 5                              |
| **Backoff Schedule**| 2min, 5min, 15min, 1hr, 4hr   |
| **Batch Size**      | 10 per run                     |
| **Throttle**        | 5 minutes between runs         |
| **Trigger**         | Dashboard page load            |

### Retry Flow

```
1. Query: Find returns where fyndSyncStatus IN ["failed", "retry_scheduled"]
   AND fyndSyncRetries < 5 AND fyndSyncNextRetry <= NOW()
2. For each return:
   a. Create Fynd client from shop settings
   b. Call createReturnOnFynd()
   c. On success: Set fyndSyncStatus = "synced", log fynd_sync_retry_success event
   d. On failure:
      - If retries < MAX: Set fyndSyncStatus = "retry_scheduled", schedule next retry
      - If retries >= MAX: Set fyndSyncStatus = "failed", log fynd_sync_retries_exhausted event
```

### Event Types Logged

| Event Type                    | When                                          |
|-------------------------------|-----------------------------------------------|
| `fynd_sync_retry_success`     | Retry succeeded                               |
| `fynd_sync_retries_exhausted` | All 5 retry attempts failed                   |

Implementation: `app/lib/fynd-retry.server.ts`.

---

## Consolidation Batching

When `fyndConsolidateReturns` is enabled, multiple return cases can be batched into a single Fynd return.

| Setting                        | Type      | Default | Description                                    |
|--------------------------------|-----------|---------|------------------------------------------------|
| `fyndConsolidateReturns`       | `Boolean` | `false` | Enable consolidation batching                  |
| `fyndConsolidateWindowHours`   | `Int`     | `4`     | Hours to wait before sending batch (1, 4, 8, 24) |

When enabled, approved returns are set to `fyndSyncStatus = "pending_consolidation"` and held for the configured window before being sent as a group.

---

## Webhook Receiver

ReturnProMax exposes two Fynd webhook endpoints:

```
POST /api/webhooks/fynd/<SHOP_ID>   ← preferred (per-shop secret)
POST /api/webhooks/fynd              ← legacy (global FYND_WEBHOOK_SECRET)
```

Per-shop secrets are generated from **Settings → Integrations → Fynd Webhook
(per-shop secret)** and configured per merchant in Fynd Partner Dashboard.
See `docs/FYND_WEBHOOK.md` for the full setup walkthrough.

### Webhook Payload Extraction

The handler extracts key fields from Fynd's variable payload structure:

| Field              | Extraction Sources (priority order)                                            |
|--------------------|--------------------------------------------------------------------------------|
| **Shipment ID**    | `shipment_id`, `shipmentId`, `shipment_status.shipment_id`, `id`, nested `shipments[0]` |
| **Order ID**       | `order_id`, `orderId`, `meta.order_id`, `meta.fynd_order_id`, `order.fynd_order_id` |
| **Affiliate Order ID** | `affiliate_order_id`, `affiliateOrderId`, `affiliate_details.affiliate_order_id`, `external_order_id`, `channel_order_id` |
| **Refund Status**  | `refund_status`, `refund_status_flag`, `status`, nested `shipments[0].refund_status` |
| **AWB Number**     | `awb_no`, `dp_details.awb_no`                                                  |
| **Tracking URL**   | `tracking_url`, `track_url`, `dp_details.tracking_url`                         |
| **Shop Domain**    | `_shop_domain`, `meta.shop_domain`, `meta.channel_domain`                      |

### Return Case Matching

The webhook handler uses a multi-strategy lookup to match the incoming event to a return case:

1. Match by `fyndShipmentId`
2. Match by `fyndOrderId`
3. Match by `shopifyOrderName` (using affiliate order ID variants)
4. Match via `FyndOrderMapping` table

---

## Status Mapping

### Fynd Journey Statuses (Tracked)

These Fynd statuses update `fyndCurrentStatus` on the return case:

**Forward Journey:**
`bag_confirmed`, `bag_invoiced`, `dp_assigned`, `bag_packed`, `bag_picked`, `out_for_delivery`, `delivery_done`, `handed_over_to_customer`

**Return Journey:**
`return_initiated`, `return_dp_assigned`, `return_bag_in_transit`, `return_bag_delivered`, `return_accepted`, `return_completed`

**RTO Journey:**
`rto_initiated`, `rto_dp_assigned`, `rto_bag_in_transit`, `rto_bag_delivered`, `rto_bag_accepted`

**Edge Cases:**
`bag_not_picked`, `out_for_pickup`, `dp_out_for_pickup`, `deadstock`, `deadstock_defective`, `return_bag_lost`

### Refund Status Mapping

| Fynd Status                        | ReturnProMax Action                     |
|------------------------------------|-----------------------------------------|
| `refund_initiated`, `refund_pending`, `under process`, `in_progress`, `processing` | Set `refundStatus = "in_progress"` |
| `refund_done`, `refunded`, `completed` | Call Shopify Refund API, set `refundStatus = "refunded"` |
| `credit_note_generated`, `credit_note` | Trigger auto-refund (if `autoRefundEnabled`) |

---

## Auto-Refund

When `autoRefundEnabled` is `true` and a Fynd webhook reports `credit_note_generated`:

1. Look up the Shopify order by affiliate order ID or order name.
2. Calculate refund amount from the return case items.
3. Call Shopify Refund API via `createRefund()`.
4. Update `refundStatus = "refunded"` and store refund details in `refundJson`.
5. Send refund notification email (and WhatsApp if configured).

### Allowed Fynd Statuses for Refund

The `allowedFyndStatusesForRefund` setting can restrict which Fynd statuses allow refund creation:

```json
["delivery_done", "handed_over_to_customer"]
```

When set, refunds are only processed if the return case's `fyndCurrentStatus` matches one of the allowed values.

---

## Fynd Private URL Signing

Fynd stores labels, invoices, and other assets behind private URLs that expire. ReturnProMax detects and signs these automatically.

### Detection

A URL is considered private if it matches:
- `storage.googleapis.com/fynd*assets*private`
- `cdn.fynd.com/*private`
- `fynd*-assets-private`

### Signing

```typescript
const signed = await signFyndUrl(settings, privateUrl);
// signed.signedUrl — temporary signed URL
// signed.expiry — expiration timestamp
```

Uses the Platform FileStorage API: `POST /service/platform/assets/v1.0/company/{cid}/sign-urls/`.

---

## Webhook Logging

All incoming Fynd webhooks are logged to the `FyndWebhookLog` table:

| Field              | Type       | Description                                       |
|--------------------|------------|---------------------------------------------------|
| `shipmentId`       | `String?`  | Extracted shipment ID                             |
| `orderId`          | `String?`  | Extracted Fynd order ID                           |
| `affiliateOrderId` | `String?`  | Extracted affiliate/external order ID             |
| `refundStatus`     | `String?`  | Extracted refund status                           |
| `fyndStatus`       | `String?`  | Extracted Fynd shipment status                    |
| `eventType`        | `String?`  | Webhook event type                                |
| `action`           | `String?`  | Action taken: `ignored`, `refund_in_progress`, `refund_completed`, `status_updated`, `error`, `duplicate_ignored` |
| `returnCaseId`     | `String?`  | Matched return case (if any)                      |
| `carrier`          | `String?`  | Delivery partner name                             |
| `awbNumber`        | `String?`  | AWB/tracking number                               |
| `trackingUrl`      | `String?`  | Tracking URL                                      |
| `rawPayload`       | `String?`  | Full webhook payload (JSON)                       |
| `error`            | `String?`  | Error message if processing failed                |

Logs are automatically cleaned up after 90 days by the dashboard background task.

View logs at: **Settings > Webhook Logs** (`/app/settings/webhook-logs`).

---

## Order ID Mapping

The `FyndOrderMapping` table caches the relationship between Shopify order names and Fynd internal IDs:

```
shopifyOrderName → fyndOrderId + fyndShipmentId
```

This avoids repeated search API calls for the same order and speeds up webhook matching.

---

## Related Files

| File                              | Purpose                                       |
|-----------------------------------|-----------------------------------------------|
| `app/lib/fynd.server.ts`         | OAuth, client classes, connection testing      |
| `app/lib/fynd-returns.server.ts` | Return creation on Fynd                        |
| `app/lib/fynd-retry.server.ts`   | Exponential backoff retry engine               |
| `app/lib/fynd-webhook.server.ts` | Inbound webhook handler                        |
| `app/lib/fynd-config.server.ts`  | Base URL resolution                            |
| `app/lib/fynd-fdk.server.ts`     | FDK client wrappers (alternative auth)         |
| `app/lib/fynd-payload.server.ts` | Payload parsing utilities                      |
| `app/lib/fynd-status-poll.server.ts` | Background status polling for stale returns |
| `app/lib/encryption.server.ts`   | AES credential encryption/decryption           |
