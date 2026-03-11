# 15 — API Reference

> Complete reference for all ReturnProMax API endpoints: Portal APIs, Admin APIs, Fynd APIs, and External APIs.

---

## Authentication Methods

ReturnProMax exposes several API surfaces, each with its own authentication:

| API Surface      | Auth Method                          | Header / Mechanism            |
|------------------|--------------------------------------|-------------------------------|
| Portal APIs      | JWT token (portal session)           | `Authorization: Bearer {jwt}` or `X-Portal-Token: {jwt}` |
| Admin APIs       | Shopify session (embedded app auth)  | Shopify App Bridge session    |
| Fynd APIs        | HMAC signature or open               | `X-Fynd-Signature` or none   |
| External APIs    | API key (Bearer token)               | `Authorization: Bearer rpm_{key}` |

---

## Rate Limits

| API Surface      | Rate Limit                    | Window    | Response on Exceed       |
|------------------|-------------------------------|-----------|--------------------------|
| Portal APIs      | 60 requests                   | 1 minute  | `429 Too Many Requests`  |
| External APIs    | 120 requests                  | 1 minute  | `429 RATE_LIMITED`       |
| Fynd Webhook     | No limit (inbound)            | --        | --                       |
| Admin APIs       | Shopify rate limits apply     | --        | --                       |

---

## Portal APIs

These endpoints power the customer-facing return portal. All are prefixed with `/api/portal/`.

### POST `/api/portal/lookup`

Look up orders or returns by email, phone, order number, return ID, or AWB.

**Auth:** None (public) or JWT for verified sessions.

**Request Body:**
```json
{
  "shopDomain": "mystore.myshopify.com",
  "type": "email",
  "value": "customer@example.com"
}
```

**Lookup Types:** `email`, `phone`, `order`, `return_id`, `return_no`, `forward_awb`, `return_awb`

**Response:**
```json
{
  "orders": [...],
  "returns": [...],
  "requiresOtp": false
}
```

---

### POST `/api/portal/otp`

Send or verify a one-time password for portal access.

**Request Body (send):**
```json
{
  "shopDomain": "mystore.myshopify.com",
  "action": "send",
  "sessionId": "cls...",
  "channel": "email"
}
```

**Request Body (verify):**
```json
{
  "shopDomain": "mystore.myshopify.com",
  "action": "verify",
  "sessionId": "cls...",
  "otp": "123456"
}
```

**Response:**
```json
{
  "verified": true,
  "token": "eyJhbG..."
}
```

---

### POST `/api/portal/order`

Fetch order details from Shopify for the return creation flow.

**Request Body:**
```json
{
  "shopDomain": "mystore.myshopify.com",
  "orderName": "#1001"
}
```

**Response:**
```json
{
  "order": {
    "id": "gid://shopify/Order/12345",
    "name": "#1001",
    "lineItems": [...],
    "fulfillmentStatus": "FULFILLED",
    "processedAt": "2026-03-01T10:00:00Z"
  },
  "settings": {
    "returnWindowDays": 30,
    "returnReasons": ["Wrong size", "Defective"],
    "photoRequired": false
  }
}
```

---

### POST `/api/portal/create-return`

Submit a new return request from the customer portal.

**Request Body:**
```json
{
  "shopDomain": "mystore.myshopify.com",
  "orderName": "#1001",
  "shopifyOrderId": "gid://shopify/Order/12345",
  "customerEmail": "customer@example.com",
  "customerPhone": "+911234567890",
  "items": [
    {
      "shopifyLineItemId": "gid://shopify/LineItem/999",
      "title": "Blue T-Shirt",
      "variantTitle": "Medium",
      "sku": "BTS-M-001",
      "price": "29.99",
      "qty": 1,
      "reasonCode": "wrong_size"
    }
  ],
  "notes": "Size was too small",
  "resolutionType": "refund",
  "media": []
}
```

**Response:**
```json
{
  "returnId": "cls...",
  "returnRequestNo": "RPM-A1B2C3D4",
  "status": "pending",
  "message": "Return request submitted successfully"
}
```

---

### GET `/api/portal/returns`

Fetch return details for the tracking view.

**Query Parameters:**
- `shopDomain` (required)
- `returnId` or `token` (JWT from verified session)

**Response:**
```json
{
  "return": {
    "id": "cls...",
    "returnRequestNo": "RPM-A1B2C3D4",
    "status": "approved",
    "items": [...],
    "events": [...],
    "returnLabelUrl": "https://...",
    "fyndCurrentStatus": "return_dp_assigned"
  }
}
```

---

### GET `/api/portal/track`

Track order/shipment status from Fynd for the order tracking view.

**Query Parameters:**
- `shopDomain` (required)
- `orderName` (required)

**Response:**
```json
{
  "shipments": [...],
  "orderStatus": "delivered",
  "trackingEvents": [...]
}
```

---

## Admin APIs

These endpoints are called from the embedded Shopify admin UI. Authentication is handled by Shopify App Bridge session tokens.

### POST `/api/returns/{id}/actions`

Perform actions on a return case (approve, reject, refund, cancel, sync to Fynd, add note).

**Request Body:**
```json
{
  "action": "approve",
  "note": "Looks good, approving.",
  "resolutionType": "refund"
}
```

**Supported Actions:**

| Action              | Description                                    | Required Fields          |
|---------------------|------------------------------------------------|--------------------------|
| `approve`           | Approve a pending return                       | --                       |
| `reject`            | Reject a return                                | `rejectionReason`        |
| `refund`            | Process Shopify refund                         | --                       |
| `cancel`            | Cancel a return                                | --                       |
| `sync_fynd`         | Sync/resync to Fynd Platform                   | --                       |
| `add_note`          | Add admin or customer-visible note             | `note`, `noteType`       |
| `refresh_fynd`      | Refresh Fynd shipment details                  | --                       |

---

### POST `/api/returns/bulk`

Perform bulk actions on multiple returns.

**Request Body:**
```json
{
  "action": "approve",
  "returnIds": ["cls1...", "cls2...", "cls3..."],
  "note": "Bulk approved by admin"
}
```

**Supported Bulk Actions:** `approve`, `reject`, `refund`, `sync_fynd`

---

### GET `/api/returns/export`

Export return data as CSV.

**Query Parameters:**
- `status` -- Filter by status
- `from` / `to` -- Date range
- `format` -- `csv` (default)

**Response:** CSV file download with return case data.

---

## Fynd APIs

### POST `/api/webhooks/fynd`

Receive Fynd shipment status update webhooks.

**Headers:**
- `Content-Type: application/json`
- `X-Fynd-Signature` (optional HMAC verification)

**Payload:** Variable structure from Fynd Platform. See [16-webhook-reference.md](./16-webhook-reference.md) for full payload documentation.

**Response:**
```json
{ "ok": true }
```

The handler always returns 200 to prevent Fynd from retrying. Errors are logged to `FyndWebhookLog`.

---

### POST `/api/fynd/consolidation`

Trigger consolidated return batch processing (when `fyndConsolidateReturns` is enabled).

**Auth:** Internal (admin session).

**Response:**
```json
{
  "processed": 5,
  "succeeded": 4,
  "failed": 1
}
```

---

## External APIs

REST APIs for third-party integrations (ERP, warehouse, custom dashboards). All endpoints require an API key.

**Base Path:** `/api/v1/external/`

**Authentication:**
```
Authorization: Bearer rpm_a1b2c3d4...
```

API keys are created in **Settings > API Keys** and have granular permissions.

### Permissions

| Permission         | Grants Access To                          |
|--------------------|-------------------------------------------|
| `read_returns`     | List returns, get return detail            |
| `write_returns`    | Approve, reject, refund returns            |
| `read_settings`    | Get shop settings                          |
| `manage_webhooks`  | List, create, delete webhook subscriptions |

---

### GET `/api/v1/external/returns`

List returns with filtering and pagination.

**Permission:** `read_returns`

**Query Parameters:**

| Parameter       | Type     | Default | Description                                       |
|-----------------|----------|---------|---------------------------------------------------|
| `page`          | Integer  | `1`     | Page number                                        |
| `pageSize`      | Integer  | `25`    | Items per page (max 100)                           |
| `status`        | String   | --      | Filter: `pending`, `approved`, `rejected`, `completed`, `cancelled`, `processing` |
| `createdAfter`  | ISO 8601 | --      | Returns created after this date                    |
| `createdBefore` | ISO 8601 | --      | Returns created before this date                   |
| `orderName`     | String   | --      | Filter by order name (partial, case-insensitive)   |
| `customerEmail` | String   | --      | Filter by customer email (partial)                 |

**Response:**
```json
{
  "data": [
    {
      "id": "clxyz123",
      "returnRequestNo": "RPM-A1B2C3D4",
      "shopifyOrderId": "gid://shopify/Order/12345",
      "shopifyOrderName": "#1001",
      "status": "pending",
      "resolutionType": "refund",
      "customerName": "John Doe",
      "customerEmail": "john@example.com",
      "currency": "USD",
      "itemCount": 2,
      "createdAt": "2026-03-10T14:30:00Z",
      "updatedAt": "2026-03-10T15:00:00Z"
    }
  ],
  "meta": {
    "page": 1,
    "pageSize": 25,
    "totalCount": 42,
    "totalPages": 2,
    "hasNextPage": true
  },
  "errors": []
}
```

**Error Codes:**

| Status | Code           | When                                 |
|--------|----------------|--------------------------------------|
| 401    | `UNAUTHORIZED` | Missing or invalid API key           |
| 403    | `FORBIDDEN`    | Key lacks `read_returns` permission  |
| 429    | `RATE_LIMITED` | Too many requests                    |

---

### GET `/api/v1/external/returns/:id`

Get full return detail including line items and event history.

**Permission:** `read_returns`

**Response:**
```json
{
  "data": {
    "id": "clxyz123",
    "returnRequestNo": "RPM-A1B2C3D4",
    "shopifyOrderId": "gid://shopify/Order/12345",
    "shopifyOrderName": "#1001",
    "status": "approved",
    "refundStatus": null,
    "resolutionType": "refund",
    "customerName": "John Doe",
    "customerEmail": "john@example.com",
    "currency": "USD",
    "items": [
      {
        "id": "clitem123",
        "shopifyLineItemId": "gid://shopify/LineItem/999",
        "title": "Blue T-Shirt",
        "variantTitle": "Medium",
        "sku": "BTS-M-001",
        "price": "29.99",
        "qty": 1,
        "reasonCode": "wrong_size",
        "condition": "unused"
      }
    ],
    "events": [
      {
        "id": "clevt123",
        "source": "admin",
        "eventType": "approved",
        "happenedAt": "2026-03-10T15:00:00Z"
      }
    ],
    "createdAt": "2026-03-10T14:30:00Z",
    "updatedAt": "2026-03-10T15:00:00Z"
  }
}
```

**Error Codes:**

| Status | Code         | When                                      |
|--------|--------------|-------------------------------------------|
| 401    | `UNAUTHORIZED` | Missing or invalid API key              |
| 404    | `NOT_FOUND`  | Return not found or belongs to different shop |

---

### POST `/api/v1/external/returns/:id/approve`

Approve a pending return.

**Permission:** `write_returns`

**Request Body (optional):**
```json
{
  "note": "Approved by ERP system",
  "resolutionType": "refund"
}
```

**Response:**
```json
{
  "data": {
    "id": "clxyz123",
    "status": "approved",
    "message": "Return approved successfully"
  }
}
```

**Error Codes:**

| Status | Code            | When                                  |
|--------|-----------------|---------------------------------------|
| 400    | `INVALID_STATE` | Return is already in a terminal state |
| 404    | `NOT_FOUND`     | Return not found                      |

---

### POST `/api/v1/external/returns/:id/reject`

Reject a pending return.

**Permission:** `write_returns`

**Request Body:**
```json
{
  "rejectionReason": "Item is outside return window",
  "note": "Rejected by automation"
}
```

**Response:**
```json
{
  "data": {
    "id": "clxyz123",
    "status": "rejected",
    "message": "Return rejected successfully"
  }
}
```

**Error Codes:**

| Status | Code            | When                                      |
|--------|-----------------|-------------------------------------------|
| 400    | `BAD_REQUEST`   | Missing `rejectionReason`                 |
| 400    | `INVALID_STATE` | Return is already in a terminal state     |
| 404    | `NOT_FOUND`     | Return not found                          |

---

### POST `/api/v1/external/returns/:id/refund`

Process a refund for an approved return.

**Permission:** `write_returns`

**Request Body (optional):**
```json
{
  "refundMethod": "original",
  "note": "Refund processed by ERP"
}
```

**Response:**
```json
{
  "data": {
    "id": "clxyz123",
    "refundStatus": "refunded",
    "refundDetails": {
      "amount": "29.99",
      "currency": "USD",
      "method": "original"
    },
    "message": "Refund processed successfully"
  }
}
```

**Error Codes:**

| Status | Code            | When                                       |
|--------|-----------------|--------------------------------------------|
| 400    | `INVALID_STATE` | Return not approved or already refunded    |
| 400    | `BAD_REQUEST`   | Invalid refund parameters                  |
| 404    | `NOT_FOUND`     | Return not found                           |

---

### GET `/api/v1/external/settings`

Get non-sensitive shop return settings.

**Permission:** `read_settings`

**Response:**
```json
{
  "data": {
    "returnWindowDays": 30,
    "autoApproveEnabled": false,
    "autoRefundEnabled": false,
    "photoRequired": true,
    "refundPaymentMethod": "original",
    "returnFeeAmount": "5.00",
    "returnFeeCurrency": "USD",
    "bonusCreditEnabled": false,
    "greenReturnsEnabled": false,
    "shopCurrency": "USD",
    "shopTimezone": "America/New_York"
  }
}
```

---

### GET `/api/v1/external/webhooks`

List active webhook subscriptions.

**Permission:** `manage_webhooks`

**Response:**
```json
{
  "data": [
    {
      "id": "clwh123",
      "url": "https://erp.example.com/webhooks/returns",
      "events": ["return.created", "return.approved"],
      "isActive": true,
      "createdAt": "2026-03-12T10:00:00Z"
    }
  ]
}
```

---

### POST `/api/v1/external/webhooks`

Register a new webhook subscription. The HMAC secret is returned only once on creation.

**Permission:** `manage_webhooks`

**Request Body:**
```json
{
  "url": "https://erp.example.com/webhooks/returns",
  "events": ["return.created", "return.approved", "return.rejected", "return.refunded"]
}
```

**Response:**
```json
{
  "data": {
    "id": "clwh123",
    "url": "https://erp.example.com/webhooks/returns",
    "events": ["return.created", "return.approved", "return.rejected", "return.refunded"],
    "secret": "whsec_a1b2c3d4e5f6...",
    "isActive": true,
    "createdAt": "2026-03-12T10:00:00Z"
  }
}
```

**Error Codes:**

| Status | Code          | When                                    |
|--------|---------------|-----------------------------------------|
| 400    | `BAD_REQUEST` | Invalid URL or empty events array       |

---

### DELETE `/api/v1/external/webhooks/:id`

Remove a webhook subscription.

**Permission:** `manage_webhooks`

**Response:**
```json
{
  "data": {
    "id": "clwh123",
    "message": "Webhook subscription removed"
  }
}
```

**Error Codes:**

| Status | Code        | When                              |
|--------|-------------|-----------------------------------|
| 404    | `NOT_FOUND` | Webhook subscription not found    |

---

## Postman Collection

A Postman collection can be generated from the admin **API Docs** page (`/app/docs`). The collection includes all external API endpoints with example requests and authentication headers pre-configured.

---

## Related Files

| File                                    | Purpose                                     |
|-----------------------------------------|---------------------------------------------|
| `app/lib/api-docs-data.ts`             | External API endpoint definitions            |
| `app/routes/api.portal.*.ts`           | Portal API route handlers                    |
| `app/routes/api.returns.*.ts`          | Admin API route handlers                     |
| `app/routes/api.v1.external.*.ts`      | External API route handlers                  |
| `app/routes/api.webhooks.fynd.ts`      | Fynd webhook receiver (if separate route)    |
| `app/lib/webhook-dispatch.server.ts`   | Outbound webhook dispatch                    |
| `app/lib/external-api-helpers.server.ts`| API key validation and permission checks    |
