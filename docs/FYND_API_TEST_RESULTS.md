# Fynd Platform Order API – Test Results

**Date:** 2026-02-23  
**Environment:** UAT (https://api.uat.fyndx1.de)  
**Company ID:** 2263  
**Application ID:** 67a09b70c8ea7c9123f00fab  

**Test Order IDs:**
- Fynd Order ID: `FYMP698CC01401C9F4A1`
- External Order ID (Shopify): `FYNDSHOPIFYX14083`

---

## Summary

| # | Step | Endpoint | Status | Notes |
|---|------|----------|--------|------|
| 1 | OAuth Token | `POST .../oauth/token` | ✅ OK | Token obtained |
| 2 | Test Connection | `GET .../orders-listing?page_no=1&page_size=1` | ✅ OK | Platform Order API |
| 3 | Search Shipments | `GET .../shipments-listing?search_type=order_id` | ✅ OK | Returns items with order_id, shipment_id |
| 3b | Search by External ID | `GET .../shipments-listing?search_type=external_order_id` | ✅ OK | Resolves FYNDSHOPIFYX14083 → FYMP698CC01401C9F4A1 |
| 4 | Get Order Details | `GET .../order-details?order_id=...` | ✅ OK | Returns order + shipments |
| 5 | Update Shipment Status | `PUT .../shipment/status-internal` | ✅ OK | Creates return on Fynd |

---

## Detailed Results

### 1. OAuth Token ✅
- **Status:** OK
- **Response:** `access_token` received

### 2. Test Connection (orders-listing) ✅
- **Status:** OK (HTTP 200)
- **Endpoint:** `GET /service/platform/order/v1.0/company/2263/orders-listing?page_no=1&page_size=1`
- **Purpose:** Validates Platform API access (same as "Test Platform" in Settings)

### 3. Search Shipments ✅
- **Status:** OK (HTTP 200)
- **Endpoint:** `GET /service/platform/order/v1.0/company/2263/shipments-listing`
- **Params:** `search_type=order_id`, `search_value=FYMP698CC01401C9F4A1`
- **Response:** 1 item found
  - `order_id`: FYMP698CC01401C9F4A1
  - `shipment_id`: 17708318940301766054

### 3b. Search by External Order ID ✅
- **Status:** OK (HTTP 200)
- **Params:** `search_type=external_order_id`, `search_value=FYNDSHOPIFYX14083`
- **Response:** 1 item found, `order_id`: FYMP698CC01401C9F4A1
- **Purpose:** When customer enters Shopify order #, app resolves to Fynd order ID

### 4. Get Order Details ✅
- **Status:** OK (HTTP 200)
- **Endpoint:** `GET /service/platform/order/v1.0/company/2263/order-details?order_id=FYMP698CC01401C9F4A1`
- **Response:** `success: true`, `order` with `fynd_order_id`, `affiliate_order_id`, shipments
- **Shipments in response:** 1
- **Resolved shipment ID:** 17708318940301766054

### 5. Update Shipment Status (return_initiated) ✅
- **Status:** OK (HTTP 200)
- **Endpoint:** `PUT /service/platform/order-manage/v1.0/company/2263/shipment/status-internal`
- **Payload:** `statuses[0].status: "return_initiated"`, `identifier: "17708318940301766054"`
- **Response:**
  ```json
  {
    "statuses": [{
      "shipments": [{
        "status": 200,
        "final_state": {"return_initiated": "return_initiated", "shipment_id": "17718404850311580665"},
        "identifier": "17708318940301766054"
      }]
    }]
  }
  ```
- **Result:** Return created on Fynd successfully

---

## APIs Used (Platform Order only)

| Operation | Method | Path |
|-----------|--------|------|
| List orders | GET | `/service/platform/order/v1.0/company/{companyId}/orders-listing` |
| List shipments | GET | `/service/platform/order/v1.0/company/{companyId}/shipments-listing` |
| Get order details | GET | `/service/platform/order/v1.0/company/{companyId}/order-details?order_id=...` |
| Update shipment status | PUT | `/service/platform/order-manage/v1.0/company/{companyId}/shipment/status-internal` |

---

## How to Re-run Tests

```bash
FYND_CLIENT_ID=your_client_id \
FYND_CLIENT_SECRET=your_client_secret \
FYND_ORDER_ID=FYMP698CC01401C9F4A1 \
npm run test:fynd-api
```

**Full flow (including update – creates actual return):**
```bash
FYND_CLIENT_ID=xxx FYND_CLIENT_SECRET=xxx FYND_ORDER_ID=FYMP698CC01401C9F4A1 FYND_TEST_UPDATE=1 npm run test:fynd-api
```

**Test search by external order ID:**
```bash
FYND_ORDER_ID=FYNDSHOPIFYX14083 npm run test:fynd-api
```
(Note: Script auto-detects search_type: `order_id` for FY-prefixed IDs, `external_order_id` otherwise)
