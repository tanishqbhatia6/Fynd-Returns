# Customer Portal

## Overview

The ReturnProMax customer portal is a fully self-contained HTML SPA (Single Page Application) served to customers through Shopify's App Proxy. It provides three core functions: creating return requests, tracking existing returns, and tracking orders. The portal is mobile-first, responsive, and fully customizable through the admin panel.

---

## Architecture

### App Proxy Serving

The portal is served through Shopify's App Proxy mechanism:

```
Customer → Shopify Storefront → App Proxy → ReturnProMax Server
              (your-store.com/      (routes to /api/portal/*)
               a/returns)
```

**How it works:**

1. The merchant configures an App Proxy in their Shopify Partner Dashboard (e.g., `your-store.com/a/returns`).
2. When a customer visits this URL, Shopify proxies the request to the ReturnProMax server.
3. The server responds with the portal HTML (`app/portal/index.html`) with server-side template variables replaced.
4. All subsequent API calls from the portal go through the same App Proxy path.

### Template Variables

The portal HTML contains server-side template placeholders that are replaced at render time:

| Placeholder           | Source                         | Description                    |
|-----------------------|--------------------------------|--------------------------------|
| `%APP_URL%`           | `SHOPIFY_APP_URL` env var      | Base URL for static assets     |
| `%PRIMARY_COLOR%`     | `ShopSettings.portalThemeJson` | Primary brand color            |
| `%PRIMARY_HOVER%`     | Computed from primary          | Hover state color              |
| `%BG_COLOR%`          | Portal theme settings          | Background color               |
| `%SURFACE_COLOR%`     | Portal theme settings          | Card/surface color             |
| `%TEXT_COLOR%`        | Portal theme settings          | Primary text color             |
| `%TEXT_MUTED%`        | Portal theme settings          | Secondary text color           |
| `%BORDER_COLOR%`      | Portal theme settings          | Border color                   |
| `%FONT_FAMILY%`       | Portal theme settings          | Body font family               |
| `%HEADING_FONT%`      | Portal theme settings          | Heading font family            |
| `%BORDER_RADIUS%`     | Portal theme settings          | Global border radius           |
| `%SHADOW%`            | Portal theme settings          | Box shadow style               |

### CSS Custom Properties

The portal uses CSS custom properties (variables) for all theming:

```css
:root {
  --portal-primary: %PRIMARY_COLOR%;
  --portal-primary-hover: %PRIMARY_HOVER%;
  --portal-bg: %BG_COLOR%;
  --portal-surface: %SURFACE_COLOR%;
  --portal-text: %TEXT_COLOR%;
  --portal-text-muted: %TEXT_MUTED%;
  --portal-border: %BORDER_COLOR%;
  --portal-font: %FONT_FAMILY%;
  --portal-heading-font: %HEADING_FONT%;
  --portal-radius: %BORDER_RADIUS%;
  --portal-shadow: %SHADOW%;
}
```

Status colors are also defined as CSS variables:

| Variable Group      | States                                                 |
|---------------------|--------------------------------------------------------|
| `--status-ok`       | Green tones for success/delivered/completed            |
| `--status-pending`  | Amber tones for pending/processing                     |
| `--status-error`    | Red tones for errors/rejected/cancelled                |
| `--status-transit`  | Blue tones for in-transit/shipping                     |
| `--status-processing` | Amber with pulsing animation for active processing  |

---

## Three Portal Tabs

The portal presents three main tabs to the customer:

### 1. Create Return

Allows customers to submit a new return request through a multi-step wizard.

### 2. Track Return

Allows customers to look up existing return requests and view their status, timeline, and shipping details.

### 3. Track Order

Allows customers to look up their order and view its fulfillment status, tracking information, and delivery progress.

---

## Return Creation Flow

The return creation process is a 6-step wizard:

```
Step 1          Step 2         Step 3          Step 4
Order Lookup → OTP Verify → Select Items → Upload Photos
                                                │
                                          Step 5 │ Step 6
                                          Review → Confirmation
```

### Step 1: Order Lookup

The customer provides their order identifier and contact information:

**Input Fields:**
- Order number (e.g., `#1001` or `1001`)
- Email address OR phone number

**API Call:** `POST /api/portal/lookup`

**Behavior:**
1. The portal sends the order number and customer email to the lookup endpoint.
2. The server queries Shopify for the order and validates it belongs to the customer.
3. Sensitive lookups require verified customer identity by default. The server creates a `LookupSession`, sends an OTP to the verified contact, and returns only `sessionId` plus a masked contact hint until verification completes.
4. After successful OTP verification, the portal receives a short-lived customer token and can fetch the minimum order/return fields needed to submit the return.

**Lookup Session:**
- Created in the `LookupSession` table.
- Contains: hashed lookup value, shop ID, OTP hash, attempt count, expiry.
- Expires after a configurable duration.

### Step 2: OTP Verification

The customer must verify their identity with a one-time password before sensitive portal data is returned.

**OTP Send:** `POST /api/portal/otp/send`

```json
{
  "sessionId": "clx4f8g9h..."
}
```

**Behavior:**
1. Generates a 6-digit numeric OTP.
2. Hashes the OTP with bcrypt and stores only the hash on the `LookupSession`.
3. Sends the OTP to the customer via email using SMTP. Phone OTP starts fail closed until a real SMS/WhatsApp OTP delivery path is implemented and verified.
4. Enforces rate limits:
   - 60-second cooldown between sends.
   - Maximum 5 attempts per session.

**OTP Verify:** `POST /api/portal/otp/verify`

```json
{
  "sessionId": "clx4f8g9h...",
  "otp": "123456"
}
```

**Behavior:**
1. Compares the submitted OTP with the stored bcrypt hash.
2. Accepts legacy SHA-256 OTP hashes only for sessions created before the bcrypt rollout, then upgrades the session state on successful verification.
3. On success, sets `verifiedAt`, clears the stored OTP hash, and issues a short-lived portal JWT with the session context.
4. The portal must present that token before sensitive order details or return creation are allowed.

OTP verification cannot be skipped in production. Phone OTP starts fail closed until a real SMS/WhatsApp OTP delivery path is implemented and verified.

**UI Details:**
- OTP input field uses `letter-spacing: 0.5em` and center alignment for a PIN-entry style.
- Countdown timer shows seconds remaining before a new OTP can be requested.
- Error messages display for expired sessions, too many attempts, or wrong codes.

### Step 3: Select Items

The customer selects which items to return from the order.

**Display:**
- Each line item shows: product image, title, variant title, price, and available quantity.
- Checkbox for item selection.
- Quantity selector (1 to max fulfilled quantity).
- Return reason dropdown (populated from `returnReasonsJson` in settings).
- Optional: item condition selector (unused, used good, used damaged, defective).
- Optional: per-item notes field.

**Eligibility Filtering:**

Items are filtered through the eligibility engine before display. Ineligible items are either hidden or shown as disabled with a reason. The eligibility checks include:

| Check                    | Setting                          | Behavior                                     |
|--------------------------|----------------------------------|----------------------------------------------|
| **Return window**        | `returnWindowDays`               | Orders older than N days are ineligible       |
| **Product policy**       | `productPoliciesJson`            | Product-level window/eligibility overrides    |
| **Minimum price**        | `minimumReturnPrice`             | Items below threshold are ineligible          |
| **Restricted tags**      | `restrictedProductTagsJson`      | Tagged products blocked from returns          |
| **Restricted regions**   | `restrictedRegionsJson`          | Customer region blocked from returns          |
| **No-return period**     | `noReturnPeriodEnabled/Start/End`| Orders placed during blackout period blocked  |
| **Fulfillment status**   | `portalAllowedFulfillmentStatuses` | Only specific fulfillment statuses allowed  |
| **Blocklist**            | `blocklistEnabled`               | Blocked customers cannot create returns       |

### Step 4: Upload Photos

If `photoRequired` is enabled in settings, the customer must upload photos of the items being returned.

**Upload Interface:**
- Drag-and-drop upload area with dashed border.
- Click to browse files.
- Supports images (JPG, PNG, WEBP) and videos.
- Multiple files can be uploaded per return.
- Preview thumbnails with remove button.
- File size validation and error messages.

**Storage:**
- Files are converted to base64 data URIs on the client side.
- Stored in `customerMediaJson` on the `ReturnCase` as a JSON array:
  ```json
  [
    { "name": "photo1.jpg", "mimeType": "image/jpeg", "dataUrl": "data:image/jpeg;base64,..." },
    { "name": "video1.mp4", "mimeType": "video/mp4", "dataUrl": "data:video/mp4;base64,..." }
  ]
  ```

**Optional Upload:**
If `photoRequired` is `false`, the upload step is shown but can be skipped.

### Step 5: Review

The customer reviews their return request before submission.

**Display:**
- Summary card showing:
  - Order number and date
  - Selected items with quantities, reasons, and conditions
  - Uploaded photos/videos (thumbnail previews)
  - Return fee amount (if applicable)
  - Estimated refund amount
  - Return instructions (if configured)
- Edit buttons to go back to previous steps.
- Submit button to finalize the return.

### Step 6: Confirmation

After successful submission, the customer sees a confirmation screen.

**Display:**
- Success message with check icon.
- Return request ID block (`RPM-XXXXXXXX`) prominently displayed.
- Summary of the return:
  - Order name
  - Items returned
  - Status (pending)
  - Estimated processing time
- Instructions for next steps.
- Option to submit another return or track the submitted return.

**API Call:** `POST /api/portal/create-return`

**What happens on the server:**
1. Validates the JWT token.
2. Creates a `ReturnCase` record with status `pending`.
3. Creates `ReturnItem` records for each selected item.
4. Generates the return request number (`RPM-XXXXXXXX`).
5. Creates a `return_created` event.
6. Evaluates auto-approve rules (if enabled).
7. If auto-approved, immediately processes the approval and Fynd sync.
8. Sends a new return notification email to the admin.
9. Returns the return ID and request number to the portal.

---

## Return Tracking

The Track Return tab allows customers to look up and monitor their existing return requests.

### Lookup

The customer enters their order number and verified email. The portal calls `POST /api/portal/returns` to fetch matching return cases.

### Return Card Display

Each return is displayed as a card with:

- **Order name** (e.g., `#1001`)
- **Status badges:**
  - Shopify status badge (pending, approved, rejected, completed, cancelled)
  - Fynd status badge (if Fynd integration is active)
- **Metadata:** Return request number, created date, resolution type
- **Line items:** Product images, titles, quantities

### Status Badge Styling

| Status Class   | Background                | Text Color  | Use Case                        |
|----------------|---------------------------|-------------|----------------------------------|
| `.s-ok`        | Light green (`#ecfdf5`)   | Dark green  | Completed, delivered             |
| `.s-pending`   | Light amber (`#fffbeb`)   | Dark amber  | Pending, awaiting review         |
| `.s-error`     | Light red (`#fef2f2`)     | Dark red    | Rejected, cancelled, failed      |
| `.s-transit`   | Light blue (`#eff6ff`)    | Dark blue   | In transit, shipped              |
| `.s-processing`| Light amber + pulse anim  | Dark amber  | Processing, being worked on      |

### Progress Bar

Return tracking includes a visual progress bar showing the return's position in the lifecycle:

```
Return Submitted → Approved → In Transit → Delivered → Refund Processed
      [====]         [====]      [====]       [    ]        [    ]
```

The progress bar fills based on the current status and Fynd shipment status updates.

### Fynd Timeline

When Fynd integration is active, the return card includes a detailed timeline of logistics events:

```
Timeline:
  [dot] Return pickup scheduled        Mar 10, 2:30 PM
  [dot] Courier assigned               Mar 10, 3:15 PM
  [dot] Package picked up              Mar 11, 10:00 AM
  [dot] In transit to warehouse        Mar 11, 2:45 PM
  [dot] Delivered to warehouse         Mar 12, 9:30 AM
```

Timeline events are sourced from `ReturnEvent` records with `source: "fynd"` and presented chronologically.

### Tracking Details

If shipping information is available (from Fynd or manually entered), the card shows:

- Carrier name
- Tracking number
- Tracking URL (clickable link)
- Label download link
- QR code link (if available)

### Customer Notes

If the admin has published notes for the customer (`notesForCustomer`), they are displayed in the return card with a distinct visual style.

---

## Order Tracking

The Track Order tab allows customers to look up their order status and fulfillment details.

### Lookup

`POST /api/portal/order`

The customer enters their order number and verified email. The server queries Shopify for the order and returns:

- Order name and date
- Financial status (paid, refunded, partially refunded)
- Fulfillment status (unfulfilled, fulfilled, partially fulfilled)
- Line items with images, titles, prices, quantities
- Tracking information per fulfillment

### Order Card Display

Orders use the `order-card-v2` design with:

- **Header:** Order name, date, and status pill
- **Items:** Product images with quantity badges
- **Fulfillment details:** Carrier, tracking number, tracking URL
- **Financial summary:** Subtotal, shipping, tax, total

---

## Eligibility Rules

The portal enforces return eligibility rules before allowing customers to create returns. All rules are configured in `ShopSettings` and evaluated by the `checkReturnEligibility()` function in `app/lib/return-rules.server.ts`.

### Rule Evaluation Order

Rules are evaluated in this priority order (first failure stops evaluation):

1. **Product-level policy** (product policies JSON)
2. **Global return window** (only if no product policy matched)
3. **No-return period** (blackout dates)
4. **Minimum price** threshold
5. **Restricted product tags**
6. **Restricted regions** (country/province)

### Product-Level Policies

Product policies allow different return windows and eligibility per product:

```typescript
type ProductPolicyRule = {
  id: string;
  matchType: "tags" | "product_type" | "collection";
  matchValue: string;          // Comma-separated values
  windowDays: number;          // Product-specific return window
  policyText?: string;         // Custom message for ineligible items
  returnable: boolean;         // false = never returnable
};
```

**Match types:**

| Match Type     | How it matches                                              |
|----------------|-------------------------------------------------------------|
| `tags`         | Product tags contain any of the comma-separated values      |
| `product_type` | Product type exactly matches the value (case-insensitive)   |
| `collection`   | Product tags contain the collection handle                  |

**First match wins:** If multiple rules could match, the first one in the array takes precedence.

### Global Return Window

If no product policy matches, the global `returnWindowDays` (default: 30) is applied:

```
Window End = Order Date + returnWindowDays
Eligible if: Current Date <= Window End
```

### No-Return Period

A blackout period during which orders placed are not eligible for returns:

| Setting                 | Description                                   |
|-------------------------|-----------------------------------------------|
| `noReturnPeriodEnabled` | Toggle the blackout period on/off             |
| `noReturnPeriodStart`   | Start date of the no-return period            |
| `noReturnPeriodEnd`     | End date of the no-return period              |

If the order was placed between `start` and `end`, returns are blocked with the message: "Returns are not accepted for orders placed during the promotional period."

### Minimum Price

Items below `minimumReturnPrice` are not eligible:

```
Eligible if: Product Price >= minimumReturnPrice
```

### Restricted Product Tags

Products with any tag in `restrictedProductTagsJson` are blocked:

```json
["final-sale", "clearance", "non-returnable"]
```

### Restricted Regions

Customers from specific countries or provinces are blocked:

```json
[
  { "country": "US", "province": "HI" },
  { "country": "IN", "province": "AN" }
]
```

Matching logic: country match AND province match (if specified). Either field can be omitted for broader blocking.

### Fulfillment Status Filter

`portalAllowedFulfillmentStatuses` restricts which orders can have returns created:

```json
["FULFILLED", "PARTIALLY_FULFILLED"]
```

By default, only fulfilled orders are eligible. This can be expanded to include partially fulfilled or even unfulfilled orders.

---

## Return Offers

Return offers incentivize customers to keep items instead of returning them, by offering a discount on their next purchase.

### Configuration

| Setting                 | Type      | Default | Description                           |
|-------------------------|-----------|---------|---------------------------------------|
| `returnOffersEnabled`   | `boolean` | `false` | Enable return offer feature           |
| `returnOffersJson`      | `string`  | `null`  | JSON array of offer rules             |

### Offer Structure

```typescript
type ReturnOffer = {
  reasonCode?: string;    // Match specific return reason (optional)
  tag?: string;           // Match specific product tag (optional)
  offerType: "discount_pct" | "discount_flat";
  offerValue: number;     // Percentage (0-100) or flat amount
  message: string;        // Customer-facing offer message
};
```

### Matching Logic

Offers are evaluated in order. The first match wins:

1. If `reasonCode` is specified, it must match the customer's selected return reason.
2. If `tag` is specified, the product must have that tag.
3. Both conditions must be true (if both are specified).
4. If neither is specified, the offer matches all returns.

### Offer Flow

1. Customer selects items and reasons in the return creation wizard.
2. Before the review step, the portal checks for matching offers.
3. If an offer matches, the customer sees the offer message and discount details.
4. Customer can choose to accept the offer (keep item + get discount code) or proceed with the return.
5. If accepted, a Shopify discount code is generated via the `discountCodeBasicCreate` mutation.

### Discount Code Format for Offers

```
KEEP-{TIMESTAMP_BASE36}-{RANDOM_4_CHARS}
```

Example: `KEEP-M5X7K2-AB9F`

- Single use, expires in 90 days.
- Can be percentage-based or flat amount.
- Available to all customers (not restricted to the specific customer).

---

## Media Uploads

### Supported Formats

| Type    | Formats                        |
|---------|--------------------------------|
| Images  | JPEG, PNG, WEBP, GIF          |
| Videos  | MP4, MOV, WEBM                |

### Upload Flow

1. Customer clicks the upload area or drags files onto it.
2. Files are read as base64 data URIs using `FileReader`.
3. Preview thumbnails are displayed below the upload area.
4. Each file shows: file name, size indicator, and a remove button.
5. On form submission, all files are included in the `customerMediaJson` field.

### Upload Area UX

```
┌─────────────────────────────────────────┐
│                                         │
│            [camera icon]                │
│                                         │
│    Drag & drop photos or videos here    │
│         or click to browse              │
│                                         │
└─────────────────────────────────────────┘

  [photo1.jpg x]  [photo2.png x]  [video.mp4 x]
```

The upload area features:
- Dashed border that changes color on hover/drag-over.
- Transition animation for the drag-over state.
- Hidden file input triggered by click.
- Inline error messages for unsupported formats or oversized files.

### Photo Requirement

When `photoRequired` is `true` in shop settings:

- The upload step becomes mandatory.
- The "Next" button is disabled until at least one file is uploaded.
- A visual indicator shows that photos are required.

When `photoRequired` is `false`:

- The upload step is optional.
- The "Next" button displays "Skip" when no files are uploaded.
- Customers can still upload photos voluntarily.

---

## Portal Customization

### Theme Settings

Merchants customize the portal appearance in Settings > Portal Widget:

| Setting          | CSS Variable           | Description                    |
|------------------|------------------------|--------------------------------|
| Primary Color    | `--portal-primary`     | Buttons, links, active states  |
| Background Color | `--portal-bg`          | Page background                |
| Surface Color    | `--portal-surface`     | Card backgrounds               |
| Text Color       | `--portal-text`        | Primary text                   |
| Muted Text       | `--portal-text-muted`  | Secondary/helper text          |
| Border Color     | `--portal-border`      | Borders and dividers           |
| Font Family      | `--portal-font`        | Body text font                 |
| Heading Font     | `--portal-heading-font`| Headings font                  |
| Border Radius    | `--portal-radius`      | Corner rounding                |
| Box Shadow       | `--portal-shadow`      | Card elevation shadow          |

### Branding

| Setting          | Field              | Description                               |
|------------------|--------------------|-------------------------------------------|
| Brand Logo       | `brandLogoUrl`     | Base64 data URI or HTTPS URL for header   |
| Brand Favicon    | `brandFaviconUrl`  | Base64 data URI or HTTPS URL for favicon  |

### Multi-Language Support

| Setting          | Field              | Description                               |
|------------------|--------------------|-------------------------------------------|
| Portal Language  | `portalLanguage`   | Language code (default: `en`)             |
| Custom Labels    | `portalLabelsJson` | JSON object of label overrides            |

The portal supports i18n through the `portal-i18n.ts` module. Merchants can override any label string via `portalLabelsJson`:

```json
{
  "create_return": "Initier un retour",
  "track_return": "Suivre un retour",
  "track_order": "Suivre une commande"
}
```

### Responsive Design

The portal is mobile-first with three breakpoints:

| Breakpoint     | Width      | Layout Changes                                |
|----------------|------------|-----------------------------------------------|
| **Mobile**     | < 640px    | Full-width cards, stacked tabs, compact padding |
| **Tablet**     | >= 640px   | Max-width 640px, inline tabs, larger padding   |
| **Desktop**    | >= 1024px  | Max-width 880px, spacious layout               |

### Policy Banner

The portal can display a return policy banner at the top:

```html
<div id="policy-banner">
  <strong>Return Policy:</strong> Returns accepted within 30 days of delivery.
  Items must be unused and in original packaging.
</div>
```

Content is driven by `returnPolicyText` from shop settings. The banner uses a subtle primary-color-tinted background.

### Return Instructions

After a return is approved, `defaultReturnInstructions` from settings are displayed to the customer:

```
Please pack items securely in their original packaging.
Include all tags and accessories.
Drop off at your nearest courier location or wait for pickup.
```
