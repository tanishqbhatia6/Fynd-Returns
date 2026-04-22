# 16 — Webhook Reference

> Inbound webhooks from Shopify and Fynd, plus outbound webhook subscriptions for external integrations.

---

## Overview

ReturnProMax processes webhooks in three directions:

1. **Shopify Inbound** -- Order lifecycle events from Shopify
2. **Fynd Inbound** -- Shipment status updates from Fynd Platform
3. **Outbound** -- Return lifecycle events dispatched to registered subscriber URLs

---

## Shopify Inbound Webhooks

These webhooks are automatically registered when the app is installed via the Shopify App Bridge.

### Registered Topics

| Topic                     | Route                              | Purpose                                |
|---------------------------|------------------------------------|----------------------------------------|
| `APP_UNINSTALLED`         | `/webhooks/app/uninstalled`        | Clean up on app uninstall              |
| `ORDERS_CREATE`           | `/webhooks/orders/create`          | Track new orders for return eligibility|
| `ORDERS_UPDATED`          | `/webhooks/orders/updated`         | Update order details, fulfillment status|
| `ORDERS_FULFILLED`        | `/webhooks/orders/fulfilled`       | Mark orders as fulfilled for return window tracking |

### Required Scopes

The app requests these Shopify scopes (configured in `render.yaml`):

```
read_orders, write_orders, read_products, read_customers,
read_fulfillments, write_fulfillments, write_returns
```

### HMAC Verification

Shopify webhooks are verified automatically by the `@shopify/shopify-app-react-router` middleware using the `SHOPIFY_API_SECRET`.

---

## Fynd Inbound Webhook

ReturnProMax supports two webhook modes:

### Per-shop endpoint (recommended)

```
POST /api/webhooks/fynd/<SHOP_ID>
```

Each Shopify store gets a unique URL **and** its own HMAC signing secret.
Generate both from **Settings → Integrations → Fynd Webhook (per-shop secret)**.
Configure them in the Fynd Partner Dashboard webhook for that shop. A leak of
one shop's secret never affects any other shop.

### Global endpoint (legacy)

```
POST /api/webhooks/fynd
```

Single URL + a single shared `FYND_WEBHOOK_SECRET` env var. Retained for
backwards compatibility. Returns `503` in production if the env var is unset
(fail-closed).

### Payload Structure

Fynd webhooks have a variable structure. The handler extracts fields from multiple possible locations:

```json
{
  "shipment_id": "17283946507210",
  "order_id": "FYMP698CC01401C9F4A1",
  "affiliate_order_id": "1001",
  "status": "return_bag_in_transit",
  "refund_status": null,
  "awb_no": "AWB123456",
  "tracking_url": "https://track.example.com/AWB123456",
  "dp_details": {
    "name": "BlueDart",
    "awb_no": "AWB123456",
    "tracking_url": "https://track.example.com/AWB123456"
  },
  "delivery_address": {
    "first_name": "John",
    "last_name": "Doe",
    "email": "john@example.com",
    "phone": "+911234567890",
    "city": "Mumbai",
    "country": "India"
  },
  "meta": {
    "shop_domain": "mystore.myshopify.com",
    "affiliate_order_id": "1001"
  },
  "affiliate_details": {
    "affiliate_order_id": "1001"
  },
  "shipments": [
    {
      "shipment_id": "17283946507210",
      "status": "return_bag_in_transit",
      "order": {
        "affiliate_order_id": "1001",
        "fynd_order_id": "FYMP698CC01401C9F4A1"
      }
    }
  ]
}
```

### Field Extraction Priority

The handler tries multiple field paths for each piece of data:

**Shipment ID:**
1. `shipment_id`
2. `shipmentId`
3. `shipment_status.shipment_id`
4. `id`
5. `shipments[0].shipment_id`
6. `order.shipments[0].shipment_id`

**Affiliate Order ID:**
1. `affiliate_order_id`
2. `affiliateOrderId`
3. `affiliate_details.affiliate_order_id`
4. `bags[0].affiliate_bag_details.affiliate_order_id`
5. `external_order_id`
6. `channel_order_id`
7. `meta.affiliate_order_id`
8. `order.affiliate_order_id`

**Refund Status:**
1. `refund_status`
2. `refund_status_flag`
3. `status`
4. `shipments[0].refund_status`

### Status Mapping

#### Tracked Journey Statuses

These Fynd statuses update `ReturnCase.fyndCurrentStatus`:

| Category   | Statuses                                                                       |
|------------|--------------------------------------------------------------------------------|
| Forward    | `bag_confirmed`, `bag_invoiced`, `dp_assigned`, `bag_packed`, `bag_picked`, `out_for_delivery`, `delivery_done`, `handed_over_to_customer` |
| Return     | `return_initiated`, `return_dp_assigned`, `return_bag_in_transit`, `return_bag_delivered`, `return_accepted`, `return_completed` |
| RTO        | `rto_initiated`, `rto_dp_assigned`, `rto_bag_in_transit`, `rto_bag_delivered`, `rto_bag_accepted` |
| Edge Cases | `bag_not_picked`, `out_for_pickup`, `dp_out_for_pickup`, `deadstock`, `deadstock_defective`, `return_bag_lost` |

#### Refund Status Triggers

| Fynd Status                                                             | Action                          |
|-------------------------------------------------------------------------|---------------------------------|
| `refund_initiated`, `refund_pending`, `under process`, `in_progress`, `processing` | Set `refundStatus = "in_progress"` |
| `refund_done`, `refunded`, `completed`                                  | Trigger Shopify refund, set `refundStatus = "refunded"` |
| `credit_note_generated`, `credit_note`                                  | Trigger auto-refund (if enabled)|

### Webhook Actions Logged

| Action                | Description                                            |
|-----------------------|--------------------------------------------------------|
| `ignored`             | Status not recognized or no matching return case       |
| `status_updated`      | `fyndCurrentStatus` updated on return case             |
| `refund_in_progress`  | Refund status set to "in_progress"                     |
| `refund_completed`    | Shopify refund created successfully                    |
| `error`               | Processing error (logged with details)                 |
| `duplicate_ignored`   | Duplicate webhook payload already processed            |

### HMAC Verification

Fynd webhook HMAC verification is optional. When the `X-Fynd-Signature` header is present, it can be validated against the stored Fynd credentials. Currently, the handler processes all incoming payloads (defense in depth via return case matching).

### Deduplication

The handler checks `FyndWebhookLog` for recent entries with the same `shipmentId` + `fyndStatus` combination to avoid processing duplicate webhook deliveries.

### Response

The handler **always** returns HTTP 200:

```json
{ "ok": true }
```

This prevents Fynd from retrying failed deliveries. Errors are captured in the `FyndWebhookLog.error` field.

---

## Outbound Webhook Subscriptions

ReturnProMax can dispatch return lifecycle events to external systems via registered webhook URLs.

### Supported Events

| Event                   | Description                              |
|-------------------------|------------------------------------------|
| `return.created`        | New return request submitted             |
| `return.approved`       | Return approved by admin or automation   |
| `return.rejected`       | Return rejected by admin                 |
| `return.refunded`       | Refund processed on Shopify              |
| `return.status_changed` | Any status change on the return case     |

### Payload Format

```json
{
  "event": "return.approved",
  "data": {
    "id": "clxyz123",
    "returnRequestNo": "RPM-A1B2C3D4",
    "shopifyOrderName": "#1001",
    "status": "approved",
    "resolutionType": "refund",
    "customerEmail": "john@example.com",
    "items": [...]
  },
  "timestamp": "2026-03-10T15:00:00Z"
}
```

### Headers

| Header            | Value                                    |
|-------------------|------------------------------------------|
| `Content-Type`    | `application/json`                       |
| `X-RPM-Signature` | `sha256={hmac_hex}`                     |
| `X-RPM-Event`    | Event type (e.g., `return.approved`)     |

### HMAC Signature Verification

Outbound webhooks are signed with HMAC-SHA256 using the subscription's secret:

```python
# Verification example (Python)
import hmac, hashlib

expected = "sha256=" + hmac.new(
    secret.encode(), body.encode(), hashlib.sha256
).hexdigest()

assert hmac.compare_digest(expected, request.headers["X-RPM-Signature"])
```

```javascript
// Verification example (Node.js)
const crypto = require("crypto");
const expected = "sha256=" + crypto
  .createHmac("sha256", secret)
  .update(body)
  .digest("hex");

if (expected !== req.headers["x-rpm-signature"]) {
  throw new Error("Invalid signature");
}
```

### Delivery & Retry

| Parameter          | Value                             |
|--------------------|-----------------------------------|
| Timeout            | 10 seconds per attempt            |
| Max attempts       | 3 (initial + 2 retries)           |
| Retry delays       | 30 seconds, then 2 minutes        |
| Failure behavior   | Silently dropped after all retries|

Delivery is **fire-and-forget**: the dispatching function returns immediately and deliveries happen in the background. Each subscription URL receives its own independent retry cycle.

### Managing Subscriptions

Subscriptions are managed via:
- **Admin UI**: Settings page
- **External API**: `GET/POST/DELETE /api/v1/external/webhooks` (requires `manage_webhooks` permission)

The HMAC secret is generated on creation and returned only once in the API response.

---

## Webhook Log Table

All Fynd webhook events are logged in `FyndWebhookLog`:

| Field              | Type       | Indexed | Description                     |
|--------------------|------------|---------|---------------------------------|
| `shipmentId`       | `String?`  | Yes     | Fynd shipment ID                |
| `orderId`          | `String?`  | Yes     | Fynd order ID                   |
| `affiliateOrderId` | `String?`  | Yes     | Affiliate/external order ID     |
| `returnCaseId`     | `String?`  | Yes     | Matched return case             |
| `fyndStatus`       | `String?`  | No      | Fynd shipment status            |
| `refundStatus`     | `String?`  | No      | Fynd refund status              |
| `action`           | `String?`  | No      | Action taken by handler         |
| `rawPayload`       | `Text?`    | No      | Full webhook JSON               |
| `createdAt`        | `DateTime` | Yes     | Received timestamp              |

Logs older than 90 days are automatically purged by the dashboard background task.

---

## Related Files

| File                                     | Purpose                                  |
|------------------------------------------|------------------------------------------|
| `app/lib/fynd-webhook.server.ts`         | Fynd inbound webhook handler             |
| `app/lib/webhook-dispatch.server.ts`     | Outbound webhook dispatch                |
| `app/routes/webhooks.app.uninstalled.tsx`| Shopify uninstall webhook                |
| `app/routes/webhooks.orders.create.tsx`  | Shopify order create webhook             |
| `app/routes/webhooks.orders.updated.tsx` | Shopify order update webhook             |
| `app/routes/webhooks.orders.fulfilled.tsx`| Shopify order fulfilled webhook         |
| `app/routes/api.v1.external.webhooks.ts` | External webhook subscription CRUD       |
| `prisma/schema.prisma`                   | FyndWebhookLog, WebhookSubscription      |
