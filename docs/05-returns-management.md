# Returns Management

## Overview

Returns management is the core functionality of ReturnProMax. The admin panel provides a complete workflow for viewing, filtering, acting on, and tracking return requests. Each return follows a defined lifecycle from submission through resolution, with integration hooks into Fynd logistics and Shopify refund processing.

---

## Returns List Page

The returns list page (`/app/returns`) is the primary admin interface for managing returns.

### Search and Filtering

The returns list supports multiple search modes:

| Search Field           | Description                                              |
|------------------------|----------------------------------------------------------|
| **Order Name**         | Shopify order number (e.g., `#1001`)                     |
| **Return Request No.** | RPM identifier (e.g., `RPM-A1B2C3D4`)                   |
| **Customer Email**     | Normalized email address                                 |
| **Customer Phone**     | Normalized phone number                                  |
| **AWB Number**         | Forward or return AWB tracking number                    |
| **Fynd Return ID**     | Fynd platform return identifier                          |
| **Fynd Shipment ID**   | Fynd shipment identifier                                 |

### Status Tabs

Returns can be filtered by status using tab navigation:

| Tab           | Statuses Included                                            |
|---------------|--------------------------------------------------------------|
| **All**       | All returns regardless of status                             |
| **Pending**   | `pending` -- Awaiting admin review                           |
| **Processing**| `processing`, `in progress`, `initiated` -- Being worked on  |
| **Approved**  | `approved` -- Approved, awaiting shipment or refund          |
| **Rejected**  | `rejected` -- Declined by admin                              |
| **Completed** | `completed` -- Fully resolved (refund processed)             |
| **Cancelled** | `cancelled` -- Cancelled by admin or system                  |

### Pagination

The returns list supports paginated results. The default page size is configurable. Each page displays:

- Return request number (RPM-XXXXXXXX)
- Order name
- Customer name and email
- Status badge with color coding
- Resolution type (refund, exchange, store credit, replacement)
- Created date
- Fynd sync status indicator

### CSV Export

Returns can be exported to CSV via `POST /api/returns/export`. The export includes:

- Return ID and request number
- Order information (name, ID)
- Customer details (name, email, phone, address)
- Status and resolution type
- Refund information (method, amount, currency)
- Fynd sync details (return ID, shipment ID, current status)
- Line item details (title, SKU, quantity, reason, price)
- Timestamps (created, updated)

### Bulk Actions

The bulk actions endpoint (`POST /api/returns/bulk`) supports performing actions on multiple returns simultaneously:

| Bulk Action       | Description                                         |
|-------------------|-----------------------------------------------------|
| **Bulk Approve**  | Approve multiple pending returns at once             |
| **Bulk Reject**   | Reject multiple returns with a shared reason         |
| **Bulk Export**    | Export selected returns to CSV                       |

---

## Return Detail Page

The return detail page (`/app/returns/:id`) displays comprehensive information about a single return and provides action controls.

### Page Sections

#### Header

- Return request number (e.g., `RPM-A1B2C3D4`)
- Current status badge with color
- Resolution type label
- Created and updated timestamps
- Quick action buttons (approve, reject, process refund)

#### Order Information

- Shopify order name and link
- Shopify order ID (GID)
- Fynd order ID and shipment ID (if integrated)
- Fynd return ID and return number
- Forward AWB and return AWB numbers
- Order processed date (for return window calculation)
- Currency

#### Customer Information

- Customer name
- Email address (normalized)
- Phone number (normalized)
- Shipping address (address1, address2, city, province, zip, country, landmark)

#### Line Items

Each return item displays:

| Field             | Description                                    |
|-------------------|------------------------------------------------|
| **Title**         | Product title                                  |
| **Variant Title** | Variant name (size, color, etc.)               |
| **SKU**           | Stock keeping unit                             |
| **Price**         | Item price                                     |
| **Quantity**      | Number of units being returned                 |
| **Image**         | Product image thumbnail                        |
| **Reason Code**   | Customer-selected return reason                |
| **Condition**     | Item condition (unused, used good, used damaged, defective) |
| **Notes**         | Customer notes for this item                   |

#### Customer Media

Photos and videos uploaded by the customer during the return creation flow. Stored as base64 data URIs in `customerMediaJson`.

#### Fynd Integration Panel

- Fynd sync status (`pending`, `processing`, `synced`, `failed`, `retry_scheduled`, `pending_consolidation`)
- Fynd current shipment status (from webhooks)
- Fynd payload details (carrier, AWB, invoice, DP info)
- Shipping label and tracking information
- Action buttons: Retry Fynd Sync, Refresh Fynd Details

#### Refund Information

- Refund status (`pending`, `refunded`, `failed`)
- Refund method used (original, store credit, discount code, split)
- Refund amount and currency
- Refund ID (Shopify)
- Discount code (if applicable)
- Bonus credit amount (if applicable)
- Green return flag

#### Admin Notes

- Internal admin notes (not visible to customer)
- Published notes for customer (visible in portal)
- Notes history via timeline events

#### Timeline

A chronological event log built from `ReturnEvent` records:

| Event Type                     | Description                                           |
|--------------------------------|-------------------------------------------------------|
| `return_created`               | Return request submitted                              |
| `status_updated`               | Status changed (from -> to)                           |
| `approved`                     | Return approved by admin (with Fynd sync result)      |
| `rejected`                     | Return rejected with reason                           |
| `refund_processed`             | Refund created on Shopify                             |
| `refund_failed`                | Refund attempt failed                                 |
| `note_added`                   | Admin note added                                      |
| `notes_for_customer_published` | Customer-facing note published                        |
| `fynd_sync`                    | Fynd return created or synced                         |
| `fynd_status_update`           | Fynd shipment status changed (via webhook)            |
| `shipping_info_updated`        | Shipping label or tracking info updated               |
| `exchange_created`             | Exchange order created on Shopify                     |
| `cancelled`                    | Return cancelled                                      |

Each event includes a timestamp, source (admin, system, portal, fynd), and a JSON payload with details.

---

## Return Actions

All return actions are dispatched through `POST /api/returns/:id/actions` with an `action` field in the request body. The endpoint authenticates via Shopify admin session and scopes all queries to the authenticated shop.

### Action: `approve`

Approves a pending return and initiates Fynd logistics sync.

**Request Body:**
```json
{
  "action": "approve",
  "note": "Approved per policy",
  "resolutionType": "refund"
}
```

**Behavior:**
1. Validates the return is not already in a terminal status (`approved`, `rejected`, `completed`, `cancelled`).
2. If Fynd consolidation is enabled, queues the return with `fyndSyncStatus: "pending_consolidation"` instead of immediate sync.
3. For green returns, skips Fynd sync entirely (no shipment needed).
4. Otherwise, creates a return on Fynd via Platform API:
   - Resolves the Shopify order to find the Fynd `affiliate_order_id`.
   - Sends customer address for pickup scheduling.
   - Auto-populates shipping info (carrier, AWB, tracking URL) from the Fynd response.
5. Updates the return status to `approved`.
6. Sets `fyndSyncStatus` to `processing` (success) or `failed` (error).
7. Sends an approval email notification to the customer.
8. Creates an `approved` event in the timeline.

**Resolution Types:**

| Type            | Description                                          |
|-----------------|------------------------------------------------------|
| `refund`        | Monetary refund to original payment or store credit   |
| `exchange`      | Replacement with different product(s)                |
| `store_credit`  | Store credit / gift card                             |
| `replacement`   | Same product replacement                             |

### Action: `reject`

Rejects a return with a required reason.

**Request Body:**
```json
{
  "action": "reject",
  "rejectionReason": "Item shows signs of wear beyond acceptable condition",
  "note": "Internal: customer attempted to return worn item"
}
```

**Behavior:**
1. Validates the return is not in a terminal status.
2. Requires a non-empty `rejectionReason` (max 500 characters).
3. Updates status to `rejected` and stores the rejection reason.
4. Sends a rejection email notification to the customer with the reason.
5. Creates a `rejected` event in the timeline.

### Action: `process_refund`

Processes the monetary refund through Shopify.

**Request Body:**
```json
{
  "action": "process_refund",
  "refundMethod": "original",
  "note": "Refund processed"
}
```

**Behavior:**
1. Validates the return is `approved` or `completed`.
2. Checks refund has not already been processed.
3. If Fynd status gating is enabled, verifies `fyndCurrentStatus` is in the allowed list.
4. Resolves line items to valid Shopify GIDs (falls back to SKU matching if needed).
5. Calls the appropriate refund function based on `refundMethod`:
   - `original` -- Shopify Refund API with original payment transactions
   - `store_credit` -- Shopify Refund API with store credit (gift card)
   - `both` -- Split refund between original payment and store credit
   - `discount_code` -- Generates a single-use discount code
6. Applies bonus credit if configured.
7. Updates `refundStatus` to `refunded` and stores refund details in `refundJson`.
8. Updates return status to `completed`.
9. Sends a refund notification email.
10. Creates a `refund_processed` event in the timeline.

**Refund Method Options:**

| Parameter          | Type     | Description                                      |
|--------------------|----------|--------------------------------------------------|
| `refundMethod`     | `string` | `"original"`, `"store_credit"`, `"both"`, `"discount_code"` |
| `storeCreditPct`   | `number` | Percentage for store credit in split mode (0-100) |
| `bonusAmount`      | `number` | Extra bonus credit amount                        |
| `splitMode`        | `string` | `"percentage"` or `"amount"` for split refunds   |
| `splitScAmount`    | `number` | Exact store credit amount (amount-based split)   |
| `splitOrigAmount`  | `number` | Exact original refund amount (amount-based split)|

### Action: `update_status`

Manually changes the return status.

**Request Body:**
```json
{
  "action": "update_status",
  "status": "processing",
  "note": "Moved to processing queue"
}
```

**Valid Statuses:** `pending`, `processing`, `in progress`, `approved`, `rejected`, `completed`, `cancelled`, `initiated`

### Action: `add_note`

Adds an internal admin note.

**Request Body:**
```json
{
  "action": "add_note",
  "note": "Customer called about status update"
}
```

### Action: `save_notes_for_customer`

Publishes a note visible to the customer in the portal.

**Request Body:**
```json
{
  "action": "save_notes_for_customer",
  "notesForCustomer": "Your return has been received. Refund will be processed within 3-5 business days."
}
```

**Behavior:**
- Updates the `notesForCustomer` field on the return.
- Sends an email notification to the customer with the published note.
- Creates a `notes_for_customer_published` event.

### Action: `cancel`

Cancels a return request.

**Request Body:**
```json
{
  "action": "cancel",
  "note": "Cancelled at customer request"
}
```

### Action: `mark_refunded`

Manually marks a return as refunded without processing through Shopify (for returns processed externally).

**Request Body:**
```json
{
  "action": "mark_refunded",
  "note": "Refund processed manually in Fynd"
}
```

### Action: `create_exchange`

Creates an exchange order on Shopify for the customer.

**Request Body:**
```json
{
  "action": "create_exchange",
  "exchangeItems": [
    { "variantId": "gid://shopify/ProductVariant/12345", "quantity": 1 }
  ]
}
```

### Action: `schedule_pickup`

Updates shipping and pickup information.

**Request Body:**
```json
{
  "action": "schedule_pickup",
  "carrier": "FedEx",
  "trackingNumber": "1234567890",
  "labelUrl": "https://example.com/label.pdf",
  "returnInstructions": "Pack items in original packaging"
}
```

### Action: `edit_details`

Updates customer address fields on the return.

**Request Body:**
```json
{
  "action": "edit_details",
  "customerAddress1": "123 Main St",
  "customerCity": "Mumbai",
  "customerProvince": "MH",
  "customerZip": "400001",
  "customerCountry": "IN",
  "customerLandmark": "Near City Mall"
}
```

### Action: `retry_fynd_sync`

Retries a failed Fynd sync for an approved return.

**Behavior:**
1. Validates the return is approved and does not already have a Fynd return ID.
2. Creates a Fynd Platform API client.
3. Calls `createReturnOnFynd` with the return data.
4. Updates Fynd fields on success.
5. Redirects with success or error indicator.

### Action: `refresh_fynd_details`

Fetches the latest shipment details from Fynd and updates the return.

**Behavior:**
1. Searches Fynd for shipments by external order ID.
2. Fetches full shipment details if available.
3. Updates `fyndPayloadJson` with the latest Fynd data.

---

## Status Workflow

Returns follow a state machine with defined transitions:

```
                         ┌──────────────┐
                         │   PENDING    │
                         │  (new return)│
                         └──────┬───────┘
                                │
                   ┌────────────┼────────────┐
                   │            │            │
                   ▼            ▼            ▼
            ┌──────────┐ ┌──────────┐ ┌───────────┐
            │ APPROVED │ │ REJECTED │ │ CANCELLED │
            └────┬─────┘ └──────────┘ └───────────┘
                 │
        ┌────────┼────────┐
        │        │        │
        ▼        ▼        ▼
  ┌──────────┐ ┌─────────────┐ ┌───────────┐
  │PROCESSING│ │  IN PROGRESS│ │ INITIATED │
  └────┬─────┘ └──────┬──────┘ └─────┬─────┘
       │              │              │
       └──────────────┼──────────────┘
                      │
                      ▼
               ┌──────────┐
               │COMPLETED │
               │ (refunded)│
               └──────────┘
```

### Terminal Statuses

The following statuses are considered terminal -- no further state transitions are allowed from these:

- `approved`
- `rejected`
- `completed`
- `cancelled`

> **Note:** While `approved` is technically terminal for the approve/reject actions, it still allows `process_refund`, `cancel`, and other operational actions.

### Status Definitions

| Status         | Description                                                     |
|----------------|-----------------------------------------------------------------|
| `pending`      | Return submitted, awaiting admin review                         |
| `initiated`    | Return acknowledged but not yet fully approved                  |
| `processing`   | Return is being processed (e.g., awaiting Fynd logistics)       |
| `in progress`  | Return shipment is in transit (Fynd status updates)             |
| `approved`     | Return approved, eligible for refund processing                 |
| `rejected`     | Return declined with a reason                                   |
| `completed`    | Return fully resolved (refund processed or marked complete)     |
| `cancelled`    | Return cancelled by admin or system                             |

---

## Return Request Number Format

Each return is assigned a user-friendly identifier in the format `RPM-XXXXXXXX`:

- **Prefix:** `RPM-` (ReturnProMax)
- **Suffix:** Last 8 characters of the internal CUID, uppercased
- **Character set:** A-Z, 0-9 (non-alphanumeric characters replaced with `X`)

**Generation logic** (from `app/lib/return-request-id.ts`):

```typescript
export function formatReturnRequestId(id: string): string {
  if (!id || id.length < 8) return id;
  const suffix = id.slice(-8).toUpperCase().replace(/[^A-Z0-9]/g, "X");
  return `RPM-${suffix}`;
}
```

**Examples:**
- Internal ID `clx4f8g9h0001...a1b2c3d4` produces `RPM-A1B2C3D4`
- The RPM number is stored in `returnRequestNo` on the `ReturnCase` model
- Used in the customer portal, email notifications, and admin panel
- Searchable in the returns list

---

## Bulk Operations

### Bulk Endpoint

`POST /api/returns/bulk`

### Supported Operations

#### Bulk Approve

```json
{
  "action": "approve",
  "ids": ["id1", "id2", "id3"],
  "resolutionType": "refund"
}
```

Approves all specified returns. Each return is processed individually -- if one fails, others continue. Results include per-return success/failure details.

#### Bulk Reject

```json
{
  "action": "reject",
  "ids": ["id1", "id2", "id3"],
  "rejectionReason": "Items do not meet return policy criteria"
}
```

#### Bulk Status Update

```json
{
  "action": "update_status",
  "ids": ["id1", "id2", "id3"],
  "status": "processing"
}
```

### Error Handling

Bulk operations use a "best effort" approach:

- Each return is processed independently.
- Returns that are already in terminal statuses are skipped with an error message.
- The response includes a summary with counts of successes and failures.
- Individual error messages are returned per return ID.

---

## Fynd Integration in Returns

### Sync Lifecycle

When a return is approved, ReturnProMax attempts to create a corresponding return on Fynd:

| Sync Status             | Description                                              |
|-------------------------|----------------------------------------------------------|
| `pending`               | Return created, Fynd sync not yet attempted              |
| `processing`            | Synced to Fynd, awaiting logistics assignment             |
| `synced`                | Fynd return fully created with shipment details          |
| `failed`                | Fynd sync failed (can be retried)                        |
| `retry_scheduled`       | Automatic retry scheduled                                |
| `pending_consolidation` | Queued for batch processing (consolidation mode)         |

### Automatic Retry

Failed Fynd syncs can be retried:

- **Manual retry:** Admin clicks "Retry Fynd Sync" on the return detail page.
- **Automatic retry:** Background retry mechanism processes returns with `fyndSyncStatus: "retry_scheduled"` and `fyndSyncNextRetry` in the past.
- **Retry tracking:** `fyndSyncRetries` counter and `fyndSyncError` message are maintained.

### Return Consolidation

When `fyndConsolidateReturns` is enabled in settings:

- Multiple returns for the same order are batched together.
- Returns are queued with `fyndSyncStatus: "pending_consolidation"`.
- A cron job (`api.fynd-consolidation-cron.ts`) processes batches after the configured window (1, 4, 8, or 24 hours).
- Reduces API calls to Fynd and groups items into single shipments.

### Fynd Status Gating for Refunds

The `allowedFyndStatusesForRefund` setting restricts when refunds can be processed:

- Only returns whose `fyndCurrentStatus` matches an allowed status can be refunded.
- Common allowed statuses: `delivery_done`, `handed_over_to_customer`.
- This prevents refunding before the return shipment is physically received.
- If not configured (empty/null), all refunds are allowed regardless of Fynd status.

---

## Notifications

Return status changes trigger email notifications:

| Event           | Recipient | Content                                              |
|-----------------|-----------|------------------------------------------------------|
| New Return      | Admin     | Return request details, order info, customer info    |
| Approved        | Customer  | Approval confirmation, admin notes, return instructions |
| Rejected        | Customer  | Rejection notice with reason                         |
| Refund Processed| Customer  | Refund amount, method, discount code (if applicable) |
| Note Published  | Customer  | Published customer-facing note                       |

Notifications are sent asynchronously. Failures are logged but do not block the action.
