# Return Pro Max – Features, Functionality & Capabilities

## Fynd ↔ Shopify integration (end-to-end)

### In Shopify Admin

- **Fynd details (return detail page)**  
  Each return has a **Fynd details (end-to-end)** section showing:
  - **Fynd Order ID** – ID used for Fynd API (usually same as Shopify order name without `#`)
  - **Fynd Return ID** – Fynd’s internal return ID
  - **Fynd Return #** – Human-readable return number from Fynd
  - **Fynd Shipment ID** – Main shipment ID from Fynd
  - **Forward AWB** – Forward logistics AWB (when available)
  - **Return AWB** – Return shipment AWB (when available)

- **Returns list**  
  Table columns include: Order, **Fynd Order ID**, **Fynd Return #**, Forward AWB, Return AWB, Status, Created.  
  Search/filter works on order #, AWB, Return #, email, phone. Export to CSV includes these fields.

- **Items with Fynd IDs**  
  On the return detail page, each line item can show **Fynd Shipment ID** and **Fynd Bag ID** when present.

- **Return tracking (timeline)**  
  Admin return detail page has a **Return tracking (timeline)** section with all events (portal initiated, admin approved, fynd_sync, refund_processed, etc.) in order.

- **Sync to Fynd**  
  When Fynd is configured (Platform API), approving a return creates the return on Fynd and stores Fynd Order ID, Return ID, Return #, and Shipment ID.  
  **Retry Fynd sync** is available for approved returns that don’t yet have a Fynd Return #.  
  Fynd sync errors are shown in the UI with a clear message and retry option.

---

## Return tracking (customers and admin)

### Customer portal (Track Return)

- **Look up by**  
  Order Number, Return Number, Forward AWB, Return AWB, Email, or Mobile.

- **Tracking view per return**  
  For each matched return, customers see:
  - Order # and status
  - **Fynd Return #** (if synced to Fynd)
  - **Forward AWB** and **Return AWB**
  - Created date
  - **Tracking timeline** – chronological list of events (e.g. initiated, approved, fynd_sync) with timestamps.  
  Rejection reason is shown when status is rejected.

### Admin

- **Return detail page**  
  Single place for:
  - Shopify order summary
  - Return details (status, order, AWBs, created, refund status)
  - **Fynd details** (Order ID, Return ID, Return #, Shipment ID, AWBs)
  - Actions (Approve, Reject, Sync to Fynd, Process refund in Shopify, notes)
  - Items (with optional Fynd Shipment/Bag ID per item)
  - **Return tracking (timeline)** with all events

- **Returns list**  
  Search, filter by status, and export CSV. Columns include Fynd Order ID and Fynd Return # for quick reference.

---

## Related features and capabilities

| Feature | Admin | Customer |
|--------|--------|----------|
| View Fynd Order ID | ✅ Return detail + list | — |
| View Fynd Return ID | ✅ Return detail | — |
| View Fynd Return # | ✅ Return detail + list | ✅ Track Return |
| View Fynd Shipment ID | ✅ Return detail (+ per item) | — |
| Forward / Return AWB | ✅ Return detail + list | ✅ Track Return |
| Return tracking timeline | ✅ Return detail | ✅ Track Return (after lookup) |
| Create return on Fynd | ✅ On Approve / Retry sync | — |
| Process refund in Shopify | ✅ Return detail | — |
| Look up returns | ✅ Search/filter in list | ✅ Order #, Return #, AWB, email, phone |
| Export returns | ✅ CSV | — |
| Create return request | — | ✅ Portal (by order or manual) |

---

## Configuration

- **Fynd**  
  Settings → Integrations: Fynd Environment (UAT/Prod), API type (Platform required for creating returns), Company ID, Application ID, Client ID/Secret (Platform) or Application Token (Storefront).  
  Creating returns on Fynd and seeing Fynd IDs end-to-end requires **Platform API**.

- **Customer portal**  
  Portal URL is shown under Customer Portal; theme and policy are configurable in Settings.  
  Customers use the same portal to **track** (lookup + timeline + AWB + Fynd Return #) and to **create** new return requests.

---

## Data flow

1. **Customer** creates return in portal (by order or manual) → Return case created in app (status initiated or auto-approved).
2. **Admin** approves in Shopify Admin → If Fynd Platform is configured, return is created on Fynd; Fynd Order ID, Return ID, Return #, and Shipment ID are stored and shown in admin and (where relevant) in the portal.
3. **Admin** can process refund in Shopify from the return detail page.
4. **Customer** and **admin** see the same tracking timeline and identifiers (Fynd Return #, AWBs) for full visibility end-to-end.
