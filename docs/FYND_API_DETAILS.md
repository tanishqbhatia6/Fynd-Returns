# Fynd Platform Order API — URLs and Endpoints

> **Setup:** Use the in-app **Fynd Setup Guide** (Settings → Fynd Setup Guide) for guided onboarding.

This document lists all URLs used by Return Pro Max for the Fynd integration. **All Fynd operations use Platform Order API only** (OAuth). Storefront and Konnect APIs are not used.

**Reference:** [Fynd Platform Order docs](https://docs.fynd.com/partners/commerce/sdk/latest/platform/company/order)

---

## Base URLs

| Environment | Base URL |
|-------------|----------|
| **UAT** | `https://api.uat.fyndx1.de` |
| **Production** | `https://api.fynd.com` |
| **Custom** | Settings → Integrations → Custom Base URL |

---

## End-to-End Flow

1. **OAuth token** — Get access token (Client ID + Secret)
2. **Test connection** — `GET orders-listing` (validates Platform API access)
3. **Search shipments** — `GET shipments-listing` by `order_id` or `external_order_id`
4. **Get order details** — `GET order-details?order_id=...` (returns order + shipments)
5. **Update shipment status** — `PUT shipment/status-internal` with `return_initiated`

---

## 1. OAuth Token

```
POST {BASE_URL}/service/panel/authentication/v1.0/company/{COMPANY_ID}/oauth/token
```

**Headers:** `Content-Type: application/json`, `Authorization: Basic {base64(client_id:client_secret)}`  
**Body:** `{"grant_type":"client_credentials"}`  
**Response:** `access_token` — use as `Bearer {token}` for all Platform API calls.

---

## 2. Test Connection (orders-listing)

Used when you click **Test Platform** in Settings → Integrations.

```
GET {BASE_URL}/service/platform/order/v1.0/company/{COMPANY_ID}/orders-listing?page_no=1&page_size=1
```

**Headers:** `Authorization: Bearer {token}`  
**Response:** Order list (empty OK). Validates OAuth and scopes.

---

## 3. Search Shipments (shipments-listing)

Resolves order/shipment IDs before creating a return. Use `search_type=order_id` for Fynd order IDs (e.g. FYMP698CC01401C9F4A1), `search_type=external_order_id` for Shopify/affiliate order IDs (e.g. FYNDSHOPIFYX14083).

```
GET {BASE_URL}/service/platform/order/v1.0/company/{COMPANY_ID}/shipments-listing?group_entity=shipments&page_no=1&page_size=50&start_date={ISO}&end_date={ISO}&search_value={ORDER_OR_EXTERNAL_ID}&search_type={order_id|external_order_id}&sort_type=sla_asc
```

**Params:**
- `search_type`: `order_id` (Fynd ID) or `external_order_id` (Shopify/affiliate)
- `search_value`: Order ID or external order ID
- `start_date`, `end_date`: ISO dates (e.g. last 30 days)

**Response:** `items` or `shipments` array with `order_id`, `shipment_id`, etc.

---

## 4. Get Order Details (order-details)

Fetches order and shipments. Use Fynd `order_id` (e.g. FYMP698CC01401C9F4A1).

```
GET {BASE_URL}/service/platform/order/v1.0/company/{COMPANY_ID}/order-details?order_id={ORDER_ID}
```

**Response:** `{ success, order: { fynd_order_id, affiliate_order_id, shipments, ... } }` or `{ shipments: [...] }`

---

## 5. Update Shipment Status (Create Return)

Creates the return on Fynd when admin approves or retries sync.

```
PUT {BASE_URL}/service/platform/order-manage/v1.0/company/{COMPANY_ID}/shipment/status-internal
```

**Request body:**
```json
{
  "statuses": [{
    "shipments": [{
      "identifier": "SHIPMENT_ID",
      "products": [{ "line_number": 1, "quantity": 1, "identifier": "SKU_OR_LINE_ITEM_ID" }],
      "reasons": {
        "products": [{
          "filters": [{ "identifier": "SKU_OR_LINE_ITEM_ID", "line_number": 1, "quantity": 1 }],
          "data": { "reason_id": 122, "reason_text": "Other" }
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

**Response:** `{ statuses: [{ shipments: [{ status: 200, final_state: { return_initiated: "return_initiated", shipment_id: "..." } } }] } }`

---

## 6. Fynd Shipment Update Webhook (Incoming)

Return Pro Max listens for Fynd shipment/refund status updates to automatically update refund status and trigger Shopify refunds.

**Webhook URL:** `https://YOUR_APP_URL/api/webhooks/fynd`

Configure this URL in Fynd Platform (Partners → Webhooks) for shipment status events. When Fynd sends updates:

- **refund_initiated / refund_pending / UNDER PROCESS** → `refundStatus` = `in_progress`
- **refund_done / refunded** → Calls Shopify Refund API, sets `refundStatus` = `refunded`

See `docs/FYND_WEBHOOK.md` for payload format and setup.

---

## API Summary

| Operation | Method | Path |
|-----------|--------|------|
| OAuth | POST | `/service/panel/authentication/v1.0/company/{companyId}/oauth/token` |
| List orders | GET | `/service/platform/order/v1.0/company/{companyId}/orders-listing` |
| List shipments | GET | `/service/platform/order/v1.0/company/{companyId}/shipments-listing` |
| Order details | GET | `/service/platform/order/v1.0/company/{companyId}/order-details?order_id=...` |
| Update status | PUT | `/service/platform/order-manage/v1.0/company/{companyId}/shipment/status-internal` |
| **Webhook (incoming)** | POST | `/api/webhooks/fynd` |

---

## 403 Forbidden Checklist

1. **Scopes** — In Fynd Partners → your extension, enable:
   - `company/orders/read`
   - `company/orders/write`
   - `company/settings` (may be required for webhook registration via Platform Webhook API)

2. **Environment** — UAT credentials → `https://api.uat.fyndx1.de`. Prod credentials → `https://api.fynd.com`.

3. **Company ID** — Must match your Fynd company exactly.

4. **Test first** — Settings → Integrations → **Test Platform**. If that passes, sync should work.
