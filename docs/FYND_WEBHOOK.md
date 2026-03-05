# Fynd Shipment Update Webhook

> **Setup:** Use the in-app **Fynd Setup Guide** (Settings → Fynd Setup Guide) for step-by-step configuration. The app can register the webhook automatically via the [Fynd Platform Webhook API](https://docs.fynd.com/partners/commerce/sdk/latest/platform/company/webhook).

Fynd Returns listens for Fynd shipment/refund status updates to automatically:

1. **Mark refund in progress** — When Fynd reports `refund_initiated`, `refund_pending`, or `UNDER PROCESS`
2. **Process refund in Shopify** — When Fynd reports `refund_done` or `refunded`, the app calls the Shopify Refund API and marks the return as completed

---

## Webhook URL

```
POST https://YOUR_APP_URL/api/webhooks/fynd
```

Replace `YOUR_APP_URL` with your deployed app URL (e.g. `https://returnpromax.onrender.com`).

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

### Environment variable (optional)

Set `FYND_WEBHOOK_SECRET` to enable signature verification when Fynd documents their webhook signing format.

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
