# Fynd Shipment Update Webhook

> **Setup:** Use the in-app **Fynd Setup Guide** (Settings → Fynd Setup Guide) for step-by-step configuration. The app can register the webhook automatically via the [Fynd Platform Webhook API](https://docs.fynd.com/partners/commerce/sdk/latest/platform/company/webhook).

Fynd Returns listens for Fynd shipment/refund status updates to automatically:

1. **Mark refund in progress** — When Fynd reports `refund_initiated`, `refund_pending`, or `UNDER PROCESS`
2. **Process refund in Shopify** — When Fynd reports `refund_done` or `refunded`, the app calls the Shopify Refund API and marks the return as completed

---

## Webhook URL — two modes

ReturnProMax supports two webhook modes. **Per-shop is preferred** for new
deployments; the global mode is retained for backwards compatibility.

### A. Per-shop webhook (recommended) — one secret per Shopify store

Each store has its own URL **and** its own signing secret. A leak of one
store's secret never affects any other store, and merchants can rotate their
own secret without operator coordination.

```
POST https://YOUR_APP_URL/api/webhooks/fynd/<SHOP_ID>
```

Generate the URL + secret from the app:

1. Open **Settings → Integrations → Fynd Webhook (per-shop secret)**
2. Click **Generate webhook secret**
3. Copy the displayed secret (shown ONCE — store it immediately) and the URL
4. Paste both into the Fynd Partner Dashboard webhook config for this shop

To rotate, click the same panel's **Rotate webhook secret** button. The old
secret stops working immediately, so update Fynd's side at the same time.

### B. Global webhook (legacy)

A single URL + a single env-var secret shared across every store. Kept for
backwards compatibility — switch to per-shop when convenient.

```
POST https://YOUR_APP_URL/api/webhooks/fynd
```

The signing secret comes from the `FYND_WEBHOOK_SECRET` env var.

---

## Configuration

### Option A: Automatic registration (recommended)

1. Go to **Settings** → **Fynd Setup Guide** → Step 3 (Webhook setup)
2. Click **Register webhook via Fynd API**
3. The app calls the [Fynd Platform Webhook API](https://docs.fynd.com/partners/commerce/sdk/latest/platform/company/webhook) to subscribe to refund and shipment events

### Option B: Manual registration

1. **Fynd Platform** — In Fynd Partners dashboard, go to Webhooks and add the URL above for shipment/refund status events.
2. Subscribe to: `refund/refund_initiated`, `refund/refund_pending`, `refund/refund_done`, `refund/refund_failed`, `shipment/update`, `shipment/data_update`

### Permissions

Your Fynd OAuth app needs `company/orders/read`, `company/orders/write`, and `company/settings` (for API registration). If registration fails with 403, add `company/settings` in Fynd Partners.

### Signature verification

The receiver verifies HMAC-SHA256 against the raw request body. The signature
is read from `X-Fynd-Signature` (preferred) or `X-Webhook-Signature`. Both
`<hex>` and `sha256=<hex>` formats are accepted.

| Mode      | Secret source                              | Failure mode                  |
| --------- | ------------------------------------------ | ----------------------------- |
| Per-shop  | `ShopSettings.fyndWebhookSecret` (encrypted) | Generic `401`                 |
| Global    | `FYND_WEBHOOK_SECRET` env var              | `503` if env var is unset in production; `401` on bad signature |

In production the global endpoint **fails closed** when the env var is not
set — the legacy endpoint will return `503` until either the env var is
configured OR the merchant migrates to a per-shop URL.

---

## Expected Payload

The handler accepts flexible payload structures. It extracts:

| Field | Aliases | Purpose |
|-------|---------|---------|
| `shipment_id` | `shipmentId`, `id`, `shipments[].shipment_id` | Find return case by `fyndShipmentId` |
| `affiliate_order_id` | `affiliateOrderId`, `external_order_id`, `order.affiliate_order_id` | Fallback lookup by `fyndOrderId` |
| `refund_status` | `refund_status_flag`, `status`, `shipments[].refund_status` | Determine action (in_progress vs refund) |

**Example payloads:**

```json
{
  "shipment_id": "17718404850311580665",
  "refund_status": "UNDER PROCESS"
}
```

```json
{
  "shipments": [{
    "shipment_id": "17718404850311580665",
    "refund_status": "refund_done"
  }],
  "order": {
    "affiliate_order_id": "FYNDSHOPIFYX14083"
  }
}
```

---

## Status Mapping

| Fynd status | App action |
|-------------|------------|
| `refund_initiated`, `refund_pending`, `UNDER PROCESS`, `in_progress`, `processing` | Set `refundStatus` = `in_progress` |
| `refund_done`, `refunded`, `REFUNDED`, `completed` | Call Shopify Refund API, set `refundStatus` = `refunded`, `status` = `completed` |

---

## Response

- **200** — `{ "ok": true, "action": "refund_in_progress" | "refund_completed" | "ignored", "returnCaseId": "..." }`
- **400** — Invalid JSON or missing identifiers
- **500** — Processing error (e.g. no matching return, Shopify API failure)

---

## Requirements

- Return case must have `fyndShipmentId` or `fyndOrderId` set (from Fynd sync)
- Shop must have an offline session (app installed)
- Return must be in `approved` or `completed` status before refund can be processed
