# Return Pro Max — Features & Capabilities

> Complete reference for all features, modules, and capabilities of the ReturnProMax Shopify app.

---

## Table of Contents

1. [Admin Dashboard](#1-admin-dashboard)
2. [Returns Management](#2-returns-management)
3. [Customer Portal](#3-customer-portal)
4. [Customers Page](#4-customers-page)
5. [Reports & Analytics](#5-reports--analytics)
6. [Fynd Integration](#6-fynd-integration)
7. [Internationalization (i18n)](#7-internationalization-i18n)
8. [Settings Modules](#8-settings-modules)
9. [Notifications](#9-notifications)
10. [Security](#10-security)
11. [Data Flow](#11-data-flow)
12. [Feature Matrix](#12-feature-matrix)

---

## 1. Admin Dashboard

The dashboard provides a real-time overview of return operations with actionable insights.

### Summary Statistics
- **Total Returns** — Count with period-over-period % change (green for decrease, red for increase)
- **Approval Rate** — Percentage of approved returns out of total
- **Avg Processing Time** — Days from request to approval
- **Refund Rate** — Refunded count out of approved returns

### Charts & Visualizations
- **Return Volume Trend** — Area chart showing daily return volume over selected period
- **Status Distribution** — Donut chart with distinct colors per status (Approved: green, Completed: indigo, Pending: amber, Rejected: red)
- **Rate Gauges** — Circular progress indicators for approval, rejection, refund, and Fynd sync rates
- **Resolution Breakdown** — Donut chart showing Refund (purple) vs Exchange (blue) vs Store Credit (teal) vs Replacement (amber)
- **Revenue Impact** — Revenue retained from exchanges/store credits, green returns count
- **Top Return Reasons** — Horizontal bar chart ranked by frequency
- **Status Breakdown** — Table with status dot, count, percentage, and progress bar

### Formatting
- All currency values use `Intl.NumberFormat` with shop currency
- All dates use `Intl.DateTimeFormat` with shop locale and timezone
- Period change badges show directional arrows

---

## 2. Returns Management

### Returns List (`/app/returns`)

**Table Columns:**
| Column | Description |
|--------|-------------|
| Checkbox | Multi-select for bulk actions |
| Return ID | Link to detail page |
| Order | Shopify order name |
| Status | Color-coded badge |
| Fynd ID | Fynd order ID (desktop only) |
| Customer | Email (desktop only) |
| Date | Locale-formatted creation date |

**Features:**
- **Search** — Filter by order name, email, phone, Fynd ID, AWB, return #
- **Status filter** — All, Pending, Approved, Rejected tabs with counts
- **Multi-select** — Checkboxes work independently of row click navigation
- **Bulk actions** — Floating action bar for approve/reject with rejection reason modal
- **Pagination** — Page-based with SVG arrow navigation
- **Fixed column widths** — `tableLayout: fixed` with `<colgroup>` for precise alignment
- **Empty state** — Contextual message based on active filters
- **CSV export** — All fields including Fynd IDs, AWBs, customer data

### Return Detail (`/app/returns/:id`)

**Sections:**
1. **Header** — Return ID, status badge, action buttons (Approve/Reject/Sync)
2. **Shopify Order** — Line items, subtotal, discounts, shipping, total
3. **Return Info** — Status, resolution type, refund status, customer details
4. **Fynd Details** — Order ID, Return ID, Return #, Shipment ID, AWBs, Invoice, Fulfillment Store
5. **Items** — Returned items with Fynd Bag IDs, quantities, reasons
6. **Resolution & Refund** — Resolution type selector, refund calculator with bonus credit
7. **Timeline** — Chronological event log with source badges (Fynd/Shopify/Portal/System/Admin)
8. **Admin Notes** — Internal and customer-facing notes

**Actions:**
- Approve with resolution type selection
- Reject with reason
- Retry Fynd sync
- Process Shopify refund with location selection
- Mark as refunded

---

## 3. Customer Portal

Served via Shopify App Proxy at `/apps/returns`.

### Tabs
- **Create Return** — Submit new return requests
- **Track Return** — Look up and track existing returns
- **Track Order** — Real-time Fynd shipment tracking

### Return Creation Flow
1. Enter order number and email/phone
2. OTP verification (email or SMS)
3. Select items to return with reason codes
4. Upload photos (if required by policy)
5. View return fee (if applicable)
6. Confirmation with return instructions

### Return Tracking
- **Multi-field lookup** — Order #, Return #, Forward AWB, Return AWB, Email, Phone
- **6-step progress bar** — Submitted → Approved → Pickup Scheduled → In Transit → Received → Refunded
- **Fynd shipment timeline** — Real-time tracking events from Fynd
- **Status-specific messaging** — Different UI for approved, rejected, processing states

### Theming
- Customizable primary color, background color, font family, heading font, border radius
- Dynamic CSS injection via `applyPortalThemeToHtml`
- RTL layout support for Arabic/Hebrew/Farsi/Urdu

---

## 4. Customers Page

### Summary Statistics
- **Total Customers** — Unique customers who have submitted returns
- **Total Returns** — Aggregate across all customers
- **Total Refunded** — Sum of all refund amounts (including bonus credits and discount codes)
- **Serial Returners** — Customers with 3+ returns (flagged with badge)

### Customer List
- **Search** — By email or phone
- **Sort** — By returns count, total refunded, most recent
- **Expandable rows** — Click to reveal detailed return history

### Expanded Customer Detail
- **Quick stats** — Total items returned, avg items per return, resolution breakdown
- **Return history** — Each return as a linked card showing:
  - Return ID and order name
  - Items with count and titles (green return badge where applicable)
  - Status + resolution type
  - Refund amount (locale-formatted)
  - Date

### Edge Cases Handled
- Phone: shows "Not provided" when null
- Refund amount: shows `$0.00` formatted for zero values
- Empty state: different messages for "no customers" vs "no search results"

---

## 5. Reports & Analytics

### All Dashboard Metrics Plus:
- **Date range selector** — Presets (7/30/90 days, this month, all time) + custom range
- **Export CSV** — Full returns data export
- **Period comparison** — % change badges

### Charts
- Return volume trend (area chart)
- Status distribution (donut)
- Resolution breakdown (donut)
- Rate gauges (approval, rejection, refund, Fynd sync)
- Revenue impact card
- Top return reasons (bar chart)
- Status breakdown table with progress bars

---

## 6. Fynd Integration

### Connection Types
| Type | Capabilities |
|------|-------------|
| **Platform API** | Full CRUD — create returns, track, sync status |
| **Storefront API** | Read-only — order lookup, tracking |

### Configuration
- **Environment** — UAT (`api.uat.fyndx1.de`) or Production (`api.fynd.com`)
- **Custom base URL** — For private/custom Fynd deployments
- **Company ID** — Fynd company identifier
- **Application ID** — Fynd application identifier
- **Credentials** — Client ID + Client Secret (Platform) or Application Token (Storefront)

### Sync Behavior
1. Admin approves a return
2. System creates return on Fynd via Platform API
3. Fynd Return ID, Return #, Shipment ID stored on ReturnCase
4. Fynd webhooks update status in real-time
5. Admin can retry failed syncs

### Webhook Processing
- Receives Fynd shipment status updates
- Maps Fynd statuses to internal statuses
- Updates return timeline with Fynd events
- Logs all webhooks in `FyndWebhookLog` for audit

### Fynd Payload Data Extracted
- Invoice: store_invoice_id, external_invoice_id, invoice URL
- Fulfillment: store name, store code, fulfillment options
- Credit Note ID
- Journey Type (forward/return)
- Shipment tracking: forward AWB, return AWB, courier details

---

## 7. Internationalization (i18n)

### Supported Languages (15)

| Code | Language | Direction |
|------|----------|-----------|
| `en` | English | LTR |
| `es` | Español | LTR |
| `fr` | Français | LTR |
| `de` | Deutsch | LTR |
| `hi` | हिन्दी | LTR |
| `ar` | العربية | RTL |
| `pt` | Português | LTR |
| `ja` | 日本語 | LTR |
| `zh` | 中文 | LTR |
| `ko` | 한국어 | LTR |
| `it` | Italiano | LTR |
| `nl` | Nederlands | LTR |
| `ru` | Русский | LTR |
| `tr` | Türkçe | LTR |
| `th` | ไทย | LTR |

### Implementation Scope

| Area | Translation | Locale Formatting |
|------|------------|-------------------|
| Customer Portal | Full translation (~229 keys) | Currency + dates |
| Email Notifications | Full translation | Currency + dates |
| Admin UI | English only | Currency + dates via shop locale |

### How It Works
1. **Auto-detection** — `syncShopLocaleAndCurrency` fetches locale, currency, timezone from Shopify GraphQL
2. **Language selection** — Merchant selects portal language in Widget settings
3. **Client injection** — `window.__RPM_LABELS__`, `__RPM_LOCALE__`, `__RPM_CURRENCY__`, `__RPM_TIMEZONE__` injected into portal HTML
4. **Label overrides** — Merchants can customize any translation key via settings
5. **RTL** — `<html dir="rtl">` set automatically for AR, HE, FA, UR

---

## 8. Settings Modules

### Policy Rules (`/app/settings/rules`)
- **Return reasons** — Add/remove reasons (no duplicates)
- **Per-category reasons** — Different reason sets per product category
- **Return window** — Global days (1–365)
- **Minimum return price** — Orders below threshold cannot be returned
- **Restricted regions** — Block returns from specific countries
- **Return offers** — Discount incentives (% or flat) per reason/tag
- **Validation** — Server-side try/catch, error feedback UI

### Return Settings (`/app/settings/return-settings`)
- **No-return period** — Date range toggle with controlled state (start/end validation)
- **Product tag restrictions** — Block returns for tagged products
- **Photo requirements** — Toggle mandatory photo uploads
- **Return fee** — Amount + currency
- **Auto-approve** — Toggle automatic approval
- **Auto-refund** — Toggle automatic refund processing
- **Refund location** — Auto or manual fulfillment location selection
- **Refund method** — Original payment, store credit, both, or discount code
- **Store credit split** — Percentage allocation (0–100%)
- **Discount code refund** — Enable with prefix and expiry days

### Product Policies (`/app/settings/product-policies`)
- **Match types** — Tags, product type, or collection
- **Per-product window** — Override global return window
- **Returnable toggle** — Mark products as non-returnable
- **Policy text** — Custom return policy per rule
- **First-match wins** — Order-dependent rule evaluation

### Customer Blocklist (`/app/settings/blocklist`)
- **Block types** — Email, phone, order name, IP
- **Duplicate detection** — Unique constraint `[settingsId, type, value]`
- **Normalized values** — Trimmed and lowercased
- **Toggle** — Enable/disable blocklist globally
- **Audit** — Tracks who added each entry

### Auto-Approve Rules (`/app/settings/auto-rules`)
- **Rule fields** — Order value, return reason, product tag, customer return count
- **Operators** — Less than, greater than, equals, not equals, contains
- **Actions** — Auto-approve or flag for review
- **Evaluation** — Rules checked in order during return creation

### Fynd Integration (`/app/settings/integrations`)
- **Credential management** — Platform API client ID/secret
- **Connection testing** — Test button with detailed results and debug log
- **Environment toggle** — UAT vs Production
- **Clear credentials** — Danger zone action
- **Client secret** — Password-masked input

### Notifications (`/app/settings/notifications`)
- **SMTP configuration** — Host, port, user, password (with TLS toggle)
- **Connection testing** — Test SMTP with real connection attempt
- **4 notification events** — New return, approved, rejected, refunded
- **Email templates** — Custom subject + HTML body per event with live preview
- **Template variables** — `{{returnId}}`, `{{orderName}}`, `{{customerEmail}}`, etc.
- **Admin email** — Separate notification address
- **Sound alerts** — Browser sound on new returns

### Portal Appearance (`/app/settings/widget`)
- **Theme** — Primary color, background color, font family, border radius
- **Tab visibility** — Show/hide order tracking, return tracking, create return tabs
- **Media uploads** — Toggle customer photo/video uploads
- **Default tab** — Set initial tab on portal load
- **Language** — Select from 15 supported languages
- **Label overrides** — Customize any translation key
- **Portal preview** — Direct link to live portal

### Permissions (`/app/settings/permissions`)
- **read_all_orders** — Toggle scope for full order history access
- **Scope detection** — Shows current OAuth scope status

---

## 9. Notifications

### Email Events

| Event | Recipient | Variables |
|-------|-----------|-----------|
| New Return | Admin | `{{returnId}}`, `{{orderName}}`, `{{customerEmail}}` |
| Approved | Customer | `{{returnId}}`, `{{orderName}}` |
| Rejected | Customer | `{{returnId}}`, `{{orderName}}`, `{{rejectionReason}}` |
| Refunded | Customer | `{{returnId}}`, `{{orderName}}`, `{{refundAmount}}` |

### Localization
- Subject and body translated via `portal-i18n` translation keys
- Currency amounts formatted with `Intl.NumberFormat`
- `<html lang="xx">` and `dir="rtl"` set on email HTML
- Merchant's portal language determines email language

---

## 10. Security

| Feature | Implementation |
|---------|---------------|
| Authentication | Shopify OAuth via `authenticate.admin` |
| Portal Auth | OTP (email/SMS) with expiry and attempt limits |
| Credential Storage | Fynd credentials encrypted at rest |
| Input Validation | Server-side validation on all form submissions |
| Error Handling | Try/catch on all database operations |
| Blocklist | Checked during return creation and portal lookup |
| CSRF | Shopify session token protection |
| Rate Limiting | OTP send limits and cooldown periods |

---

## 11. Data Flow

### Return Lifecycle

```
Customer Portal                    Admin Panel                    Fynd Platform
     │                                │                              │
     ├─ Submit Return Request ────────┤                              │
     │   (items, reason, photos)      │                              │
     │                                ├─ Review & Approve ──────────►│
     │                                │   (creates return on Fynd)   │
     │                                │                              │
     │                                │◄── Webhook Status Update ────┤
     │                                │    (tracking, AWB, status)   │
     │                                │                              │
     │                                ├─ Process Refund              │
     │                                │   (Shopify Admin API)        │
     │                                │                              │
     │◄── Email Notification ─────────┤                              │
     │    (translated, formatted)     │                              │
```

### Resolution Types

| Type | Flow |
|------|------|
| **Refund** | Approve → Refund via Shopify API → Mark completed |
| **Exchange** | Approve → Create new order → Link exchange order |
| **Store Credit** | Approve → Issue store credit (+ optional bonus %) |
| **Replacement** | Approve → Create replacement order |

---

## 12. Feature Matrix

| Feature | Admin | Portal | Email |
|---------|:-----:|:------:|:-----:|
| View returns | ✅ | ✅ | — |
| Create returns | — | ✅ | — |
| Approve/Reject | ✅ | — | — |
| Bulk operations | ✅ | — | — |
| Fynd sync | ✅ | — | — |
| Process refund | ✅ | — | — |
| Track shipment | ✅ | ✅ | — |
| View timeline | ✅ | ✅ | — |
| Search/filter | ✅ | ✅ | — |
| CSV export | ✅ | — | — |
| Analytics | ✅ | — | — |
| Customer list | ✅ | — | — |
| i18n formatting | ✅ | ✅ | ✅ |
| Full translation | — | ✅ | ✅ |
| RTL support | — | ✅ | ✅ |
| OTP verification | — | ✅ | ✅ |
| Photo upload | — | ✅ | — |
| Theme customization | ✅ (config) | ✅ (display) | — |
| Notifications | ✅ (config) | — | ✅ |

---

*Last updated: March 5, 2026*
