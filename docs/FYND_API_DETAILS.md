# Fynd API — URLs and CURL (End-to-End)

This document lists all URLs and CURL commands used by Return Pro Max for the Fynd integration. Use it to debug 403 Forbidden and other API issues.

---

## Base URLs

| Environment | Base URL |
|-------------|----------|
| **UAT** | `https://api.uat.fyndx1.de` |
| **Production** | `https://api.fynd.com` |
| **Custom** | Whatever you set in Settings → Integrations → Custom Base URL |

When **Fynd Environment** is set to **Dev/UAT**, the app uses `https://api.uat.fyndx1.de`.

---

## End-to-End Flow

1. **OAuth token** — Get access token using Client ID + Client Secret
2. **Test Platform** — `GET` return reasons (used by "Test Platform")
3. **Search shipments** — Find order by external_order_id (Shopify order name)
4. **Get shipments** — Fetch shipments for an order
5. **Update shipment status** — Create return (`return_initiated`)

---

## 1. OAuth Token

**URL:**
```
POST {BASE_URL}/service/panel/authentication/v1.0/company/{COMPANY_ID}/oauth/token
```

**UAT example:**
```
POST https://api.uat.fyndx1.de/service/panel/authentication/v1.0/company/2263/oauth/token
```

**CURL:**
```bash
# Replace: COMPANY_ID, CLIENT_ID, CLIENT_SECRET
# For UAT, BASE_URL = https://api.uat.fyndx1.de

curl -X POST "https://api.uat.fyndx1.de/service/panel/authentication/v1.0/company/YOUR_COMPANY_ID/oauth/token" \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic $(echo -n 'YOUR_CLIENT_ID:YOUR_CLIENT_SECRET' | base64)" \
  -d '{"grant_type":"client_credentials"}'
```

**Response:** JSON with `access_token`. Use this token as `Bearer {access_token}` for all Platform API calls.

---

## 2. Test Platform (Return Reasons)

Used when you click **Test Platform** in Settings → Integrations. The app uses the **FDK method** `platformClient.application(applicationId).order.getPlatformShipmentReasons({ action: "return" })`.

**Correct URL (FDK native):**
```
GET {BASE_URL}/service/platform/order/v1.0/company/{COMPANY_ID}/application/{APPLICATION_ID}/orders/shipments/reasons/return
```

**UAT example:**
```
GET https://api.uat.fyndx1.de/service/platform/order/v1.0/company/2263/application/67a09b70c8ea7c9123f00fab/orders/shipments/reasons/return
```

**CURL:**
```bash
# Replace: COMPANY_ID, APPLICATION_ID, ACCESS_TOKEN
# Get ACCESS_TOKEN from step 1

curl -X GET "https://api.uat.fyndx1.de/service/platform/order/v1.0/company/YOUR_COMPANY_ID/application/YOUR_APPLICATION_ID/orders/shipments/reasons/return" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

**Note:** The old path `orders/returns/reasons` returns 404 — it does not exist. Use `orders/shipments/reasons/return` instead.

**403 here** → Missing `company/orders/read` (and possibly `company/orders/write`) scopes in Fynd Partners.

---

## 3. Search Shipments by External Order ID

Used to resolve Shopify order name (e.g. `#12345`) to Fynd internal order/shipment IDs before creating a return.

**URL:**
```
GET {BASE_URL}/service/portal/order-manage/v1.0/company/{COMPANY_ID}/shipments-listing?group_entity=shipments&page_no=1&page_size=2&start_date={ISO_DATE}&end_date={ISO_DATE}&search_value={EXTERNAL_ORDER_ID}&search_type=external_order_id&fulfillment_type=FULFILLMENT&parent_view_slug=all&child_view_slug=all&sort_type=sla_asc&application_id={APPLICATION_ID}
```

**UAT example (Shopify order #12345):**
```
GET https://api.uat.fyndx1.de/service/portal/order-manage/v1.0/company/2263/shipments-listing?group_entity=shipments&page_no=1&page_size=2&start_date=2025-01-23T00:00:00.000Z&end_date=2025-02-23T23:59:59.999Z&search_value=12345&search_type=external_order_id&fulfillment_type=FULFILLMENT&parent_view_slug=all&child_view_slug=all&sort_type=sla_asc&application_id=67a09b70c8ea7c9123f00fab
```

**CURL:**
```bash
# Replace: COMPANY_ID, APPLICATION_ID, ACCESS_TOKEN, EXTERNAL_ORDER_ID (e.g. 12345 without #)
# start_date = 1 month ago, end_date = now (ISO format)

curl -X GET "https://api.uat.fyndx1.de/service/portal/order-manage/v1.0/company/YOUR_COMPANY_ID/shipments-listing?group_entity=shipments&page_no=1&page_size=2&start_date=2025-01-23T00:00:00.000Z&end_date=2025-02-23T23:59:59.999Z&search_value=YOUR_EXTERNAL_ORDER_ID&search_type=external_order_id&fulfillment_type=FULFILLMENT&parent_view_slug=all&child_view_slug=all&sort_type=sla_asc&application_id=YOUR_APPLICATION_ID" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

---

## 4. Get Shipments for Order

**URL:**
```
GET {BASE_URL}/service/platform/order/v1.0/company/{COMPANY_ID}/application/{APPLICATION_ID}/orders/{ORDER_ID}/shipments
```

**UAT example:**
```
GET https://api.uat.fyndx1.de/service/platform/order/v1.0/company/2263/application/67a09b70c8ea7c9123f00fab/orders/123456/shipments
```

**CURL:**
```bash
# Replace: COMPANY_ID, APPLICATION_ID, ORDER_ID (Fynd internal order ID, often numeric), ACCESS_TOKEN

curl -X GET "https://api.uat.fyndx1.de/service/platform/order/v1.0/company/YOUR_COMPANY_ID/application/YOUR_APPLICATION_ID/orders/YOUR_ORDER_ID/shipments" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN"
```

---

## 5. Update Shipment Status (Create Return)

This is the call that creates the return on Fynd when you approve a return or click **Retry Fynd sync**.

**URL:**
```
PUT {BASE_URL}/service/platform/order/v1.0/company/{COMPANY_ID}/application/{APPLICATION_ID}/orders/{ORDER_ID}/shipments/status
```

**UAT example:**
```
PUT https://api.uat.fyndx1.de/service/platform/order/v1.0/company/2263/application/67a09b70c8ea7c9123f00fab/orders/123456/shipments/status
```

**Request body:**
```json
{
  "statuses": [
    {
      "shipments": [
        {
          "identifier": "SHIPMENT_ID",
          "products": [
            { "line_number": 1, "quantity": 1, "identifier": "SKU_OR_LINE_ITEM_ID" }
          ],
          "reasons": {
            "products": [
              {
                "filters": [{ "identifier": "SKU_OR_LINE_ITEM_ID", "line_number": 1, "quantity": 1 }],
                "data": { "reason_id": 122, "reason_text": "Other" }
              }
            ]
          }
        }
      ],
      "status": "return_initiated"
    }
  ],
  "task": false,
  "force_transition": false,
  "lock_after_transition": false,
  "unlock_before_transition": false
}
```

**CURL:**
```bash
# Replace: COMPANY_ID, APPLICATION_ID, ORDER_ID, SHIPMENT_ID, ACCESS_TOKEN
# Adjust products/reasons to match your return items

curl -X PUT "https://api.uat.fyndx1.de/service/platform/order/v1.0/company/YOUR_COMPANY_ID/application/YOUR_APPLICATION_ID/orders/YOUR_ORDER_ID/shipments/status" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_ACCESS_TOKEN" \
  -d '{
    "statuses": [{
      "shipments": [{
        "identifier": "YOUR_SHIPMENT_ID",
        "products": [{"line_number": 1, "quantity": 1, "identifier": "SKU_OR_LINE_ITEM_ID"}],
        "reasons": {
          "products": [{
            "filters": [{"identifier": "SKU_OR_LINE_ITEM_ID", "line_number": 1, "quantity": 1}],
            "data": {"reason_id": 122, "reason_text": "Other"}
          }]
        }
      }],
      "status": "return_initiated"
    }],
    "task": false,
    "force_transition": false,
    "lock_after_transition": false,
    "unlock_before_transition": false
  }'
```

**403 here** → Missing `company/orders/write` scope in Fynd Partners.

---

## 403 Forbidden Checklist

1. **Scopes** — In Fynd Partners → your extension/app, enable:
   - `company/orders/read`
   - `company/orders/write`

2. **Environment** — UAT credentials only work with UAT base URL (`https://api.uat.fyndx1.de`). Production credentials only work with Prod (`https://api.fynd.com`). Ensure Settings → Integrations → Fynd Environment matches your credentials.

3. **Company ID & Application ID** — Must match your Fynd Commerce company and application exactly (no extra spaces).

4. **Test first** — Go to Settings → Integrations, click **Test Platform**. If that fails, fix credentials there before retrying sync.

---

## Quick Debug: Run Step 1 + 2

```bash
# 1. Get token (replace placeholders)
TOKEN=$(curl -s -X POST "https://api.uat.fyndx1.de/service/panel/authentication/v1.0/company/YOUR_COMPANY_ID/oauth/token" \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic $(echo -n 'YOUR_CLIENT_ID:YOUR_CLIENT_SECRET' | base64)" \
  -d '{"grant_type":"client_credentials"}' | jq -r '.access_token')

# 2. Test return reasons (correct path: orders/shipments/reasons/return)
curl -s -X GET "https://api.uat.fyndx1.de/service/platform/order/v1.0/company/YOUR_COMPANY_ID/application/YOUR_APPLICATION_ID/orders/shipments/reasons/return" \
  -H "Authorization: Bearer $TOKEN" | jq .
```

If step 2 returns 403, the OAuth app is missing the required scopes. If step 2 returns 404, double-check Company ID and Application ID.

---

## References

- [Fynd access scopes docs](https://docs.fynd.com/partners/commerce/references/access-scopes)
- [Fynd Platform](https://platform.fynd.com)
