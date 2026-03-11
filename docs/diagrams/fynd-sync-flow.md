# Fynd Return Sync Flow

## Return Creation on Fynd (Approval → Sync)

```
Admin/API                     App Server                      Fynd Platform
   │                              │                                │
   │  Approve return              │                                │
   │ ──────────────────────────► │                                │
   │                              │  1. Get OAuth token             │
   │                              │ ──────────────────────────────►│
   │                              │  { access_token: "..." }       │
   │                              │ ◄──────────────────────────────│
   │                              │                                │
   │                              │  2. Search shipments by        │
   │                              │     affiliate_order_id         │
   │                              │ ──────────────────────────────►│
   │                              │  { items: [{ shipment_id,     │
   │                              │     order_id }] }              │
   │                              │ ◄──────────────────────────────│
   │                              │                                │
   │                              │  3. Get order details          │
   │                              │     (bags, SKUs, shipments)    │
   │                              │ ──────────────────────────────►│
   │                              │  { shipments: [...] }          │
   │                              │ ◄──────────────────────────────│
   │                              │                                │
   │                              │  4. Update shipment status     │
   │                              │     status: return_initiated   │
   │                              │     + bag IDs + reason         │
   │                              │ ──────────────────────────────►│
   │                              │  { return_id: "FY123",        │
   │                              │    return_no: "R-001" }        │
   │                              │ ◄──────────────────────────────│
   │                              │                                │
   │                              │  5. Store fyndReturnId,        │
   │                              │     fyndShipmentId on          │
   │                              │     ReturnCase                 │
   │                              │                                │
   │  { status: "approved",       │                                │
   │    fyndReturnId: "FY123" }   │                                │
   │ ◄──────────────────────────  │                                │
```

## Retry Engine (On Sync Failure)

```
Attempt 1 (immediate)
    │ FAIL
    ▼
Attempt 2 (after 2 minutes)
    │ FAIL
    ▼
Attempt 3 (after 5 minutes)
    │ FAIL
    ▼
Attempt 4 (after 15 minutes)
    │ FAIL
    ▼
Attempt 5 (after 60 minutes)
    │ FAIL
    ▼
Max retries exhausted
fyndSyncStatus = "failed"
fyndSyncError = "..." (last error message)
Admin can manually retry from Return detail page
```

**Retry state fields on ReturnCase:**
- `fyndSyncStatus`: "pending" | "synced" | "failed" | "retry_scheduled" | "processing"
- `fyndSyncRetries`: 0-5
- `fyndSyncError`: last error message
- `fyndSyncNextRetry`: next retry timestamp

## Webhook Cycle (Fynd → App)

```
Fynd Platform                  App Server                     Shopify
     │                              │                              │
     │  POST /api/webhooks/fynd     │                              │
     │  { shipment_id, status,      │                              │
     │    refund_status, bags }      │                              │
     │ ──────────────────────────► │                              │
     │                              │  1. Verify HMAC signature     │
     │                              │  2. Check replay (5min)       │
     │                              │  3. Check idempotency         │
     │                              │  4. Find ReturnCase by        │
     │                              │     fyndShipmentId            │
     │                              │  5. Map status                │
     │                              │                              │
     │                              │  IF status = refund_done      │
     │                              │  OR credit_note_generated     │
     │                              │  AND autoRefundEnabled:       │
     │                              │                              │
     │                              │  Create Shopify Refund        │
     │                              │ ────────────────────────────►│
     │                              │  { refundId }                │
     │                              │ ◄────────────────────────────│
     │                              │                              │
     │                              │  Update ReturnCase:           │
     │                              │  - refundStatus = "refunded"  │
     │                              │  - status = "completed"       │
     │                              │  - Store refundJson           │
     │                              │                              │
     │                              │  Send refund notification     │
     │                              │  to customer                  │
     │                              │                              │
     │  200 OK                      │                              │
     │ ◄──────────────────────────  │                              │
```

## Fynd Status Mapping

| Fynd Status | App Action |
|-------------|------------|
| `return_initiated` | Update fyndCurrentStatus |
| `return_bag_picked` | Update fyndCurrentStatus, extract AWB |
| `return_bag_in_transit` | Update fyndCurrentStatus |
| `return_bag_delivered` | Update fyndCurrentStatus |
| `return_bag_not_received` | Update fyndCurrentStatus |
| `refund_initiated` | Update fyndCurrentStatus |
| `refund_done` | Auto-refund if enabled, mark completed |
| `credit_note_generated` | Auto-refund if enabled, mark completed |
| `return_request_cancelled` | Cancel return |
| `handed_over_to_customer` | Update fyndCurrentStatus |
| `delivery_done` | Update fyndCurrentStatus |

## Consolidation (Batch Returns)

When `fyndConsolidateReturns = true`:
```
Return 1 approved → fyndSyncStatus = "pending_consolidation"
Return 2 approved → fyndSyncStatus = "pending_consolidation"
  ...wait fyndConsolidateWindowHours (default: 4)...
Cron runs → Batch all pending_consolidation for same order
  → Single Fynd API call with all bags
  → All returns marked "synced"
```
