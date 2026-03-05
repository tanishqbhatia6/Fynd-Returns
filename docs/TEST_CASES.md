# Fynd Returns — End-to-End Test Cases

Comprehensive test suite covering every flow between **Fynd**, **Shopify**, **Return App Admin**, **Customer Portal**, and **SMTP Notifications**.

---

## Table of Contents

1. [Customer Portal — Lookup & Authentication](#1-customer-portal--lookup--authentication)
2. [Customer Portal — Order Details & Eligibility](#2-customer-portal--order-details--eligibility)
3. [Customer Portal — Return Creation](#3-customer-portal--return-creation)
4. [Admin — Dashboard & Reports](#4-admin--dashboard--reports)
5. [Admin — Returns List](#5-admin--returns-list)
6. [Admin — Return Detail & Actions](#6-admin--return-detail--actions)
7. [Admin — Refund Processing](#7-admin--refund-processing)
8. [Admin — Refund Payment Method Configuration](#8-admin--refund-payment-method-configuration)
9. [Fynd Integration — Sync & Retry](#9-fynd-integration--sync--retry)
10. [Fynd Webhooks](#10-fynd-webhooks)
11. [Shopify Webhooks](#11-shopify-webhooks)
12. [Notifications (SMTP)](#12-notifications-smtp)
13. [Settings — Return Settings](#13-settings--return-settings)
14. [Settings — Fynd Integration](#14-settings--fynd-integration)
15. [Settings — Notifications](#15-settings--notifications)
16. [Settings — Portal Widget & Theme](#16-settings--portal-widget--theme)
17. [Settings — Permissions](#17-settings--permissions)
18. [Settings — Policy Rules](#18-settings--policy-rules)
19. [Portal Authentication (OTP)](#19-portal-authentication-otp)
20. [Fynd Enrichment](#20-fynd-enrichment)
21. [Rate Limiting & Security](#21-rate-limiting--security)
22. [Edge Cases & Error Handling](#22-edge-cases--error-handling)
23. [Cross-System Integration Scenarios](#23-cross-system-integration-scenarios)

---

## 1. Customer Portal — Lookup & Authentication

### 1.1 Email Lookup

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 1.1.1 | Valid email with existing returns | `lookupType: "email"`, `lookupValue: "customer@example.com"` | Returns list with matching returns + Shopify orders for that customer |
| 1.1.2 | Valid email with no returns | `lookupType: "email"`, `lookupValue: "noorders@example.com"` | Empty returns array, orders from Shopify (if any) |
| 1.1.3 | Valid email with returns but no Shopify orders | Email exists in ReturnCase but customer not in Shopify | Returns from DB, empty orders array |
| 1.1.4 | Invalid email format | `lookupValue: "notanemail"` | 400 — Invalid lookup value |
| 1.1.5 | Empty email | `lookupValue: ""` | 400 — Lookup value required |
| 1.1.6 | Email with leading/trailing spaces | `lookupValue: "  customer@example.com  "` | Trimmed and normalized, returns correct results |
| 1.1.7 | Case-insensitive email match | `lookupValue: "Customer@Example.COM"` | Normalized to lowercase, matches existing returns |

### 1.2 Phone Lookup

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 1.2.1 | Valid phone with existing returns | `lookupType: "phone"`, `lookupValue: "+919876543210"` | Returns matching `customerPhoneNorm` |
| 1.2.2 | Phone with no returns | Valid phone, no matching records | Empty returns array |
| 1.2.3 | Phone number normalization | `lookupValue: "9876543210"` (no country code) | Properly normalized, matches records |
| 1.2.4 | Phone with special characters | `lookupValue: "+91-987-654-3210"` | Digits extracted, normalized, matches |

### 1.3 Order Number Lookup

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 1.3.1 | Valid order number with `#` prefix | `lookupType: "order_no"`, `lookupValue: "#1042"` | `#` stripped, returns matching returns + Shopify order |
| 1.3.2 | Valid order number without `#` | `lookupValue: "1042"` | Returns matching returns + Shopify order |
| 1.3.3 | Order number not in Shopify | Non-existent order number | Returns from DB (if any), no Shopify order |
| 1.3.4 | Order with PCDA (protected customer data access) error | Shopify returns `OrderAccessError` | Returns from DB, `fallback: true` message |

### 1.4 Return ID / AWB Lookup

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 1.4.1 | Return number lookup | `lookupType: "return_no"`, `lookupValue: "RPM-ABC123"` | Matching return case |
| 1.4.2 | Return ID lookup | `lookupType: "return_id"`, valid CUID | Matching return case |
| 1.4.3 | Forward AWB lookup | `lookupType: "forward_awb"`, valid AWB | Matching return with forward AWB |
| 1.4.4 | Return AWB lookup | `lookupType: "return_awb"`, valid AWB | Matching return with return AWB |
| 1.4.5 | Invalid lookup type | `lookupType: "invalid"` | 400 — Invalid lookup type |
| 1.4.6 | AWB not found | Valid AWB format but no match | Empty returns |

### 1.5 Lookup — General Edge Cases

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 1.5.1 | Missing `shop` parameter | No `shop` in body | 400 — Shop required |
| 1.5.2 | Non-existent shop domain | `shop: "nonexistent.myshopify.com"` | 404 — Shop not found |
| 1.5.3 | Lookup value too long | > 256 characters | 400 — Validation error |
| 1.5.4 | Lookup value too short | < 2 characters | 400 — Validation error |
| 1.5.5 | Returns with `_needsFyndEnrich: true` flag | Return has `shopifyOrderName` and `fyndShipmentId` | Response includes `_needsFyndEnrich: true` per return |
| 1.5.6 | Multiple returns for same email | Email with 5+ returns | All returns returned in array |

---

## 2. Customer Portal — Order Details & Eligibility

### 2.1 Order Fetch

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 2.1.1 | Valid fulfilled order | `orderNumber: "1042"`, order is `FULFILLED` | Order details with line items, customer info |
| 2.1.2 | Partially fulfilled order | Order is `PARTIALLY_FULFILLED` | Order returned, eligible items filtered |
| 2.1.3 | Unfulfilled order | Order is `UNFULFILLED` | `returnEligibility.eligible: false`, reason: "not yet fulfilled" |
| 2.1.4 | Refunded order | `financialStatus: "REFUNDED"` | `returnEligibility.eligible: false`, reason: "already refunded" |
| 2.1.5 | Voided order | `financialStatus: "VOIDED"` | `returnEligibility.eligible: false` |
| 2.1.6 | Order not found | Non-existent order number | 404 with existing/active returns for that order name |
| 2.1.7 | PCDA error on order fetch | Shopify throws `OrderAccessError` | 200 with `fallback: true`, manual form message |
| 2.1.8 | Missing order number parameter | No `orderNumber` in query | 400 — Order number required |

### 2.2 Return Window Eligibility

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 2.2.1 | Order within return window | Order placed 10 days ago, `returnWindowDays: 30` | Eligible |
| 2.2.2 | Order outside return window | Order placed 45 days ago, `returnWindowDays: 30` | Not eligible, reason: "return window expired" |
| 2.2.3 | Order placed on boundary date | Order placed exactly 30 days ago, `returnWindowDays: 30` | Edge — verify if day boundary is inclusive/exclusive |
| 2.2.4 | Very large return window | `returnWindowDays: 365` | Eligible for orders up to 1 year old |
| 2.2.5 | Return window set to 0 | `returnWindowDays: 0` | No returns eligible (or all — verify behavior) |

### 2.3 No-Return Period

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 2.3.1 | Order placed during no-return period | `noReturnPeriodEnabled: true`, order date within start–end | Not eligible, reason: "purchased during no-return period" |
| 2.3.2 | Order placed outside no-return period | `noReturnPeriodEnabled: true`, order date before start | Eligible |
| 2.3.3 | No-return period disabled | `noReturnPeriodEnabled: false` | Eligible regardless of dates |
| 2.3.4 | No-return period with no dates set | `noReturnPeriodEnabled: true`, no start/end | Eligible (no valid range) |

### 2.4 Product Tag Restrictions

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 2.4.1 | Product has restricted tag | Product tags: `["sale", "clearance"]`, restricted: `["sale"]` | Item not eligible |
| 2.4.2 | Product has no restricted tags | Product tags: `["new"]`, restricted: `["sale"]` | Item eligible |
| 2.4.3 | No tags configured | `restrictedProductTagsJson: "[]"` | All items eligible |
| 2.4.4 | Case sensitivity of tags | Product tag: `"SALE"`, restricted: `["sale"]` | Verify case-insensitive matching |

### 2.5 Minimum Price

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 2.5.1 | Item price above minimum | Price: ₹500, `minimumReturnPrice: 200` | Eligible |
| 2.5.2 | Item price below minimum | Price: ₹100, `minimumReturnPrice: 200` | Not eligible |
| 2.5.3 | Item price equals minimum | Price: ₹200, `minimumReturnPrice: 200` | Edge — verify boundary |
| 2.5.4 | No minimum set | `minimumReturnPrice: null` | All items eligible |

### 2.6 Region Restrictions

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 2.6.1 | Shipping to restricted region | Country: "IN", Province: "Kashmir", restricted: `["IN-Kashmir"]` | Not eligible |
| 2.6.2 | Shipping to unrestricted region | Country: "IN", Province: "Maharashtra" | Eligible |
| 2.6.3 | No regions restricted | `restrictedRegionsJson: "[]"` | All eligible |

### 2.7 Per-Item Eligibility

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 2.7.1 | Some items eligible, some not | 3-item order, 1 has restricted tag | `itemEligibility` shows 2 eligible, 1 not |
| 2.7.2 | All items already returned | All line items have active returns | `activeReturns` count matches, items not eligible |
| 2.7.3 | Partially returned item | Item qty 3, 1 already returned | Remaining qty eligible |

---

## 3. Customer Portal — Return Creation

### 3.1 Standard Return (Auto Mode)

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 3.1.1 | Create return for single item | Valid order, 1 item, reason code | `201` — Return created, `returnRequestNo` generated |
| 3.1.2 | Create return for multiple items | Valid order, 3 items | Return created with 3 `ReturnItem` records |
| 3.1.3 | Return with customer notes | `customerNotes: "Defective stitching"` | Notes saved in `ReturnCase.customerNotes` |
| 3.1.4 | Return with media/photos | 1–5 valid JPEG/PNG images, each < 5MB | Media URLs saved in `customerMediaJson` |
| 3.1.5 | Return with reason code | `reasonCode: "defective"` per item | Reason saved per `ReturnItem.reasonCode` |
| 3.1.6 | Auto-approve enabled | `autoApproveEnabled: true` | Return created with status `approved`, Fynd sync attempted |
| 3.1.7 | Auto-approve disabled | `autoApproveEnabled: false` | Return created with status `pending` |

### 3.2 Manual Return

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 3.2.1 | Manual return with description | `manual: true`, `manualItemDescription: "Blue T-shirt XL"` | Return created with `shopifyOrderId: "manual:..."` |
| 3.2.2 | Manual return without description | `manual: true`, no `manualItemDescription` | 400 — Description required for manual returns |
| 3.2.3 | Manual return bypasses fulfillment check | Order is unfulfilled | Return created (manual skips fulfillment validation) |
| 3.2.4 | Manual return with PCDA fallback | Shopify lookup fails for order | Return created via manual path |

### 3.3 Duplicate Detection

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 3.3.1 | Duplicate return for same order (pending) | Existing return with `status: "pending"` for same order | 409 — Duplicate return |
| 3.3.2 | Duplicate return for same order (approved) | Existing return with `status: "approved"` | 409 — Duplicate return |
| 3.3.3 | Return after previous was rejected | Previous return `status: "rejected"` | New return created (rejected is terminal) |
| 3.3.4 | Return after previous was completed | Previous return `status: "completed"` | New return created (completed is terminal) |
| 3.3.5 | Return after previous was cancelled | Previous return `status: "cancelled"` | New return created |

### 3.4 Validation Failures

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 3.4.1 | Missing shop parameter | No `shop` in body | 400 — Shop required |
| 3.4.2 | Missing order name | No `shopifyOrderName` | 400 — Order name required |
| 3.4.3 | Missing order ID (non-manual) | `manual: false`, no `orderId` | 400 — Order ID required |
| 3.4.4 | Empty items array | `items: []` | 400 — At least one item required |
| 3.4.5 | Invalid media format | Non-image file (PDF) | 400 — Invalid media format |
| 3.4.6 | Media exceeds 5MB | Image > 5MB | 400 — File too large |
| 3.4.7 | More than 5 media files | 6 images | 400 — Maximum 5 images |
| 3.4.8 | Order already refunded | `financialStatus: "REFUNDED"` | 400 — Already refunded |
| 3.4.9 | Order outside return window | Order older than `returnWindowDays` | 400 — Return window expired |
| 3.4.10 | Item with restricted product tag | Tag in `restrictedProductTagsJson` | 400 — Item not eligible |
| 3.4.11 | Photo required but not provided | `photoRequired: true`, no media | 400 — Photos required |

### 3.5 Post-Creation Side Effects

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 3.5.1 | New return notification sent | `notificationNewReturn: true`, SMTP configured | Admin email sent |
| 3.5.2 | New return notification disabled | `notificationNewReturn: false` | No email sent |
| 3.5.3 | Auto-approve + Fynd sync success | `autoApproveEnabled: true`, Fynd configured | Status `approved`, Fynd return created |
| 3.5.4 | Auto-approve + Fynd sync failure | `autoApproveEnabled: true`, Fynd API error | Status `approved`, `fyndSyncStatus: "failed"`, retry scheduled |
| 3.5.5 | ReturnEvent created | Any successful return creation | `ReturnEvent` with `eventType: "return_created"` |
| 3.5.6 | Return fee calculated | `returnFeeAmount: 50`, `returnFeeCurrency: "INR"` | Fee noted in return summary |

---

## 4. Admin — Dashboard & Reports

### 4.1 Dashboard KPIs

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 4.1.1 | Total returns count | Multiple returns across statuses | Correct total count |
| 4.1.2 | Pending returns count | 5 returns with `status: "pending"` | Shows `5` |
| 4.1.3 | Approved count | Returns with `status: "approved"` | Correct count |
| 4.1.4 | Refunded count | Returns with `refundStatus: "refunded"` | Correct count |
| 4.1.5 | Completed count | Returns with `status: "completed"` | Correct count |
| 4.1.6 | Date range filter | `range: "7d"`, `"30d"`, `"90d"`, custom | Counts filtered by date range |
| 4.1.7 | Zero returns | No returns in DB | All KPIs show 0, empty states displayed |

### 4.2 Dashboard Insights

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 4.2.1 | "Approved returns awaiting refund" | 3 returns: `status: "approved"`, `refundStatus: null` | Shows `3 approved returns awaiting refund` |
| 4.2.2 | Approved but already refunded excluded | `status: "approved"`, `refundStatus: "refunded"` | Not counted in "awaiting refund" |
| 4.2.3 | Fynd sync count | Returns with any of `fyndReturnNo`, `fyndReturnId`, `fyndShipmentId` | Correctly counted as synced |
| 4.2.4 | Returns not synced to Fynd | Returns without any Fynd identifiers | Shows unsync count |
| 4.2.5 | No insights when all healthy | All returns processed, no pending issues | No warning insights shown |

### 4.3 Reports Page

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 4.3.1 | Refund rate calculation | 8 approved, 6 refunded | Refund rate = 75% (6/8) |
| 4.3.2 | Status distribution chart | Various statuses | Correct pie/bar chart data |
| 4.3.3 | Top return reasons | Returns with different `reasonCode` values | Sorted by frequency |
| 4.3.4 | Trend chart | Returns over time | Correct daily/weekly aggregation |
| 4.3.5 | All reports with zero data | No returns | Charts show empty state, gauges at 0% |

---

## 5. Admin — Returns List

### 5.1 List & Pagination

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 5.1.1 | Default list (no filters) | No query params | First page of returns, sorted by `createdAt` desc |
| 5.1.2 | Pagination | 50+ returns, page 2 | Correct offset/limit |
| 5.1.3 | Search by order name | `query: "#1042"` | Returns matching `shopifyOrderName` |
| 5.1.4 | Search by customer email | `query: "customer@example.com"` | Returns matching email |
| 5.1.5 | Search by return request number | `query: "RPM-ABC123"` | Matching return |
| 5.1.6 | Filter by status | `status: "pending"` | Only pending returns |
| 5.1.7 | Filter by multiple statuses | `status: "approved,completed"` | Returns with either status |
| 5.1.8 | No results | Search with no matches | Empty state message |

### 5.2 List Display

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 5.2.1 | Fynd Return ID column | Return with `fyndReturnId: "R123"` | Shows "R123" in Fynd Return ID column |
| 5.2.2 | Fynd Return ID fallback | No `fyndReturnId`, has `fyndReturnNo` | Shows `fyndReturnNo` |
| 5.2.3 | Fynd Return ID second fallback | No `fyndReturnId`/`fyndReturnNo`, has `fyndShipmentId` | Shows `fyndShipmentId` |
| 5.2.4 | No Fynd data | No Fynd identifiers | Shows "—" |
| 5.2.5 | Status badge colors | Each status value | Correct color from `getStatusColor` |

### 5.3 Export

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 5.3.1 | Export all returns as CSV | No filters | CSV with all returns |
| 5.3.2 | Export filtered returns | `status: "approved"` | CSV with only approved returns |
| 5.3.3 | Export with date range | `from: "2025-01-01"`, `to: "2025-12-31"` | CSV filtered by date |
| 5.3.4 | Export empty set | No matching returns | CSV with headers only |

---

## 6. Admin — Return Detail & Actions

### 6.1 Return Detail View

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 6.1.1 | View pending return | Return with `status: "pending"` | Shows approve/reject buttons |
| 6.1.2 | View approved return | `status: "approved"` | Shows "Process Refund" button |
| 6.1.3 | View completed + refunded return | `status: "completed"`, `refundStatus: "refunded"` | No action buttons, refund details shown |
| 6.1.4 | View rejected return | `status: "rejected"` | Shows rejection reason, no actions |
| 6.1.5 | View cancelled return | `status: "cancelled"` | No actions available |
| 6.1.6 | Shopify order details tab | Return linked to valid Shopify order | Order details, line items, customer info |
| 6.1.7 | Fynd journey timeline | Return with Fynd payload | Journey steps displayed chronologically |
| 6.1.8 | Customer media/photos | Return with `customerMediaJson` | Photos displayed in gallery |
| 6.1.9 | Return events timeline | Multiple `ReturnEvent` records | All events displayed chronologically |
| 6.1.10 | Manual return indicator | `shopifyOrderId` starts with `manual:` | "Manual Return" badge shown |
| 6.1.11 | Unified return state | Various status combinations | Correct state label, color, step, description |

### 6.2 Approve Action

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 6.2.1 | Approve pending return | `action: "approve"` on pending return | Status → `approved`, event created |
| 6.2.2 | Approve with notes | `action: "approve"`, `notesForCustomer: "Approved, please ship back"` | Notes saved, included in notification |
| 6.2.3 | Approve triggers notification | `notificationApproved: true` | Customer email sent |
| 6.2.4 | Approve notification disabled | `notificationApproved: false` | No email |
| 6.2.5 | Approve triggers Fynd sync | Fynd configured | Return created on Fynd |
| 6.2.6 | Approve — Fynd sync fails | Fynd API error | Status still `approved`, `fyndSyncStatus: "failed"`, retry scheduled |
| 6.2.7 | Approve already approved return | `status: "approved"` | Error — return already in terminal state |
| 6.2.8 | Approve rejected return | `status: "rejected"` | Error — cannot approve rejected return |

### 6.3 Reject Action

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 6.3.1 | Reject pending return | `action: "reject"`, `rejectionReason: "Item not eligible"` | Status → `rejected`, reason saved |
| 6.3.2 | Reject without reason | `action: "reject"`, no reason | Rejection processed (reason optional or required — verify) |
| 6.3.3 | Reject triggers notification | `notificationRejected: true` | Customer email with rejection reason |
| 6.3.4 | Reject notification disabled | `notificationRejected: false` | No email |
| 6.3.5 | Reject already rejected return | `status: "rejected"` | Error — already terminal |

### 6.4 Update Status

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 6.4.1 | Update status to completed | `action: "update_status"`, `status: "completed"` | Status updated, event created |
| 6.4.2 | Update with admin notes | `action: "update_status"`, `note: "Received at warehouse"` | Notes saved in `adminNotes` |
| 6.4.3 | Update from terminal to non-terminal | `status: "rejected"` → try update to `"pending"` | Verify behavior (should error) |

### 6.5 Add Notes

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 6.5.1 | Add admin note | `action: "add_note"`, `note: "Contacted customer"` | Note appended, event created |
| 6.5.2 | Add customer-facing note | `notesForCustomer: "Your refund is being processed"` | Saved in `notesForCustomer` |

---

## 7. Admin — Refund Processing

### 7.1 Original Payment Refund

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 7.1.1 | Process refund — original payment | `refundMethod: "original"` on approved return | Shopify `refundCreate` called, refund completed |
| 7.1.2 | Refund uses `suggestedRefund` | Valid order with transaction history | `suggestedTransactions` used for gateway + parentTransaction |
| 7.1.3 | Refund amount correct | 2 items, ₹500 + ₹300 | Refund amount = ₹800 (from Shopify suggested) |
| 7.1.4 | Refund status updated | Successful refund | `refundStatus: "refunded"`, `refundJson` populated |
| 7.1.5 | Refund notification sent | `notificationRefunded: true` | Customer email with refund details |
| 7.1.6 | Refund on already refunded return | `refundStatus: "refunded"` | Button not shown / error returned |

### 7.2 Store Credit Refund

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 7.2.1 | Full store credit refund | `refundMethod: "store_credit"` | `refundMethods.storeCreditRefund` sent with full amount |
| 7.2.2 | Store credit — amount from suggestedRefund | Valid order | Amount calculated from `suggestedRefund.amount.shopMoney` |
| 7.2.3 | Store credit — currency correct | INR order | `currencyCode: "INR"` in store credit input |
| 7.2.4 | Store credit — no customer accounts | Customer accounts not enabled in Shopify | Shopify returns user error |
| 7.2.5 | Store credit — no customer on order | Guest checkout order | Shopify returns user error |
| 7.2.6 | Store credit — transactions set to empty | `refundMethod: "store_credit"` | `transactions: []` in refund input |

### 7.3 Split Refund (Both)

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 7.3.1 | 50/50 split | `refundMethod: "both"`, `storeCreditPct: 50` | 50% store credit + 50% original payment |
| 7.3.2 | 70/30 split | `storeCreditPct: 70` | 70% store credit + 30% original |
| 7.3.3 | 95/5 split (edge) | `storeCreditPct: 95` | 95% store credit + 5% original |
| 7.3.4 | 5/95 split (edge) | `storeCreditPct: 5` | 5% store credit + 95% original |
| 7.3.5 | Split amounts sum correctly | Total ₹1000, 60% SC | SC: ₹600, Original: ₹400 |
| 7.3.6 | Rounding with odd amounts | Total ₹999, 33% SC | Verify no penny loss (₹329.67 SC + ₹669.33 original) |
| 7.3.7 | Split with zero store credit amount | `storeCreditPct: 0` | Effectively original payment only |

### 7.4 Refund Location

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 7.4.1 | Auto location mode — fulfillment location | `refundLocationMode: "auto"`, order has fulfillment | Uses fulfillment location ID |
| 7.4.2 | Auto location mode — no fulfillment | Unfulfilled order, `refundLocationId` set | Uses fallback `refundLocationId` |
| 7.4.3 | Auto location mode — no fallback | No fulfillment, no `refundLocationId` | Uses `fetchPrimaryLocationId` |
| 7.4.4 | Manual location mode | `refundLocationMode: "manual"` | Modal shows location dropdown, uses selected |
| 7.4.5 | Location error — NO_RESTOCK retry | Shopify rejects location (inventory not tracked) | Retry with `restockType: "NO_RESTOCK"` |
| 7.4.6 | NO_RESTOCK retry succeeds | Valid refund without restock | Refund completed, `refundMethod` recorded |
| 7.4.7 | NO_RESTOCK retry also fails | Shopify rejects retry too | Error returned to admin |
| 7.4.8 | No locations available | `read_locations` scope missing | Locations array empty, warning shown |

### 7.5 Refund from Settings Config

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 7.5.1 | Modal pre-fills from settings | `refundPaymentMethod: "store_credit"` in settings | Modal opens with store credit pre-selected |
| 7.5.2 | Modal override — change from settings default | Settings say original, admin selects store credit | Uses admin's modal selection, not settings |
| 7.5.3 | No override — uses settings | Admin doesn't change method in modal | Settings config applied |
| 7.5.4 | Split percentage pre-fills | `refundStoreCreditPct: 60` in settings | Slider pre-set to 60% |

### 7.6 Manual Return Refund

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 7.6.1 | Manual return — mark refunded | Manual return (`shopifyOrderId: "manual:..."`) | Different UI — mark as refunded without Shopify API call |
| 7.6.2 | Manual return — no Shopify refund API call | Process manual return refund | No `refundCreate` mutation called |

### 7.7 Refund Errors

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 7.7.1 | Shopify API error (500) | Shopify returns 500 | Error message shown, retry possible |
| 7.7.2 | Invalid response from Shopify | Non-JSON response | "Invalid response from Shopify" error |
| 7.7.3 | GraphQL errors | `errors` array in response | Error messages joined and displayed |
| 7.7.4 | User errors from Shopify | `userErrors` in `refundCreate` response | Error messages shown |
| 7.7.5 | No line items for refund | Return with no `ReturnItem` records with valid `shopifyLineItemId` | "No line items specified" error |
| 7.7.6 | Already refunded order | Shopify says "already refunded" | Graceful handling |
| 7.7.7 | Concurrent refund attempts | Two admins click refund simultaneously | Second request should fail gracefully |

---

## 8. Admin — Refund Payment Method Configuration

### 8.1 Settings Page

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 8.1.1 | Select original payment | Click "Original payment method" radio | `refundPaymentMethod: "original"` saved |
| 8.1.2 | Select store credit | Click "Store credit" radio | `refundPaymentMethod: "store_credit"` saved |
| 8.1.3 | Select split | Click "Split" radio | `refundPaymentMethod: "both"` saved, slider appears |
| 8.1.4 | Adjust split slider | Drag to 70% | `refundStoreCreditPct: 70` saved |
| 8.1.5 | Split preview | Slider at 60% | Shows "Store credit: 60% | Original payment: 40%" |
| 8.1.6 | Store credit info banner | Select store credit | Info about new customer accounts shown |
| 8.1.7 | Save and reload | Save settings, refresh page | Correct method and percentage loaded |
| 8.1.8 | Discard changes | Click Discard after changing | Reverts to saved values |

### 8.2 Settings Index Badge

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 8.2.1 | Original payment badge | `refundPaymentMethod: "original"` | Badge shows "Original payment" |
| 8.2.2 | Store credit badge | `refundPaymentMethod: "store_credit"` | Badge shows "Store credit" |
| 8.2.3 | Split refund badge | `refundPaymentMethod: "both"` | Badge shows "Split refund" |

---

## 9. Fynd Integration — Sync & Retry

### 9.1 Create Return on Fynd

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 9.1.1 | Successful Fynd sync | Approved return, Fynd configured | `fyndSyncStatus: "synced"`, `fyndReturnId` populated |
| 9.1.2 | Fynd API error | Fynd returns 500 | `fyndSyncStatus: "failed"`, retry scheduled |
| 9.1.3 | Fynd not configured | No Fynd credentials | Sync skipped, no error |
| 9.1.4 | Fynd auth failure | Invalid credentials | `fyndSyncStatus: "failed"`, error logged |
| 9.1.5 | Manual return — no Fynd sync | `shopifyOrderId: "manual:..."` | Fynd sync not attempted |

### 9.2 Retry Queue

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 9.2.1 | Retry picks up failed syncs | Return with `fyndSyncStatus: "failed"`, `fyndSyncNextRetry` in past | Retry attempted |
| 9.2.2 | Retry succeeds | Previously failed, now Fynd is up | `fyndSyncStatus: "synced"` |
| 9.2.3 | Retry fails again | Fynd still down | `fyndSyncRetries` incremented, next retry scheduled |
| 9.2.4 | Max retries exceeded | `fyndSyncRetries` at max | No more retries scheduled |
| 9.2.5 | Retry skips future retries | `fyndSyncNextRetry` in future | Not picked up until time arrives |

### 9.3 Status Polling

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 9.3.1 | Poll stale returns | Return with old `lastFyndStatusCheck` | Fynd queried for latest status |
| 9.3.2 | Poll updates status | Fynd shows new status | `ReturnCase` updated, event created |
| 9.3.3 | Poll — Fynd returns same status | No change | No update, `lastFyndStatusCheck` updated |
| 9.3.4 | Poll — Fynd API error | API timeout | Error logged, polling continues for others |

---

## 10. Fynd Webhooks

### 10.1 Webhook Matching

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 10.1.1 | Match by `fyndShipmentId` | Payload `shipment_id: "S123"`, return has `fyndShipmentId: "S123"` | Correct return case found |
| 10.1.2 | Match by `fyndOrderId` | No shipment match, `order_id` matches `fyndOrderId` | Correct return case found |
| 10.1.3 | Match by `affiliate_order_id` | Matches `shopifyOrderId` or `shopifyOrderName` | Return case found |
| 10.1.4 | No match found | Payload IDs don't match any return | `{ ok: true, action: "ignored" }` |
| 10.1.5 | Missing shipment and order IDs | Payload has neither | `{ ok: true, action: "ignored" }` |
| 10.1.6 | Backfill missing IDs | Return found but `fyndShipmentId` was null | `fyndShipmentId` updated from payload |

### 10.2 Refund Status — In Progress

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 10.2.1 | `refund_initiated` status | Webhook with `refund_status: "refund_initiated"` | `refundStatus: "in_progress"`, event logged |
| 10.2.2 | `refund_pending` status | `refund_status: "refund_pending"` | `refundStatus: "in_progress"` |
| 10.2.3 | `under process` status | `refund_status: "under process"` | `refundStatus: "in_progress"` |

### 10.3 Refund Complete — Shopify Refund Triggered

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 10.3.1 | `refund_done` triggers Shopify refund | `refund_status: "refund_done"` | `createRefund` called, `refundStatus: "refunded"` |
| 10.3.2 | `REFUNDED` status | `refund_status: "REFUNDED"` | Shopify refund processed |
| 10.3.3 | `completed` status | `refund_status: "completed"` | Shopify refund processed |
| 10.3.4 | Refund uses configured payment method | Settings: `store_credit` | `createRefund` called with `refundMethodCfg.method: "store_credit"` |
| 10.3.5 | Refund uses configured split | Settings: `both`, 60% | Split refund with 60% store credit |
| 10.3.6 | Shopify refund fails | `createRefund` returns error | Error logged in `FyndWebhookLog`, `refundStatus` not updated |
| 10.3.7 | Shopify says "already refunded" | Error message matches already-refunded pattern | `refundStatus: "refunded"`, `status: "completed"` |
| 10.3.8 | Manual return — mark complete only | `shopifyOrderId: "manual:..."` | No Shopify refund, status → `completed`, notification sent |
| 10.3.9 | Refund notification sent | `notificationRefunded: true`, customer email available | Email sent |

### 10.4 Auto-Refund on Credit Note

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 10.4.1 | `credit_note_generated` with auto-refund ON | `autoRefundEnabled: true` | Shopify refund triggered |
| 10.4.2 | `credit_note_generated` with auto-refund OFF | `autoRefundEnabled: false` | Event logged: "Auto-refund is disabled. Process manually." |
| 10.4.3 | `credit_note` variant status | `refund_status: "credit_note"` | Same as credit_note_generated |
| 10.4.4 | Credit note — already refunded | `refundStatus: "refunded"` | Skipped, no duplicate refund |
| 10.4.5 | Credit note — refund uses payment method config | Settings: `store_credit` | Store credit refund via Shopify |
| 10.4.6 | Credit note — refund uses location config | `refundLocationId` set in settings | Location used for restock |
| 10.4.7 | Credit note — order ID resolution | `shopifyOrderId` is order name, not GID | `fetchOrderByOrderNumber` used to resolve |
| 10.4.8 | Credit note — no line items | Return has no linked line items | Falls back to `fetchOrder` to get all items |
| 10.4.9 | Credit note — Shopify refund fails | API error | Error logged in webhook log and timeline |

### 10.5 Other Statuses

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 10.5.1 | Shipment pickup status | `status: "bag_picked"` | Event logged to timeline only |
| 10.5.2 | Shipment in transit | `status: "in_transit"` | Event logged |
| 10.5.3 | Return delivered | `status: "return_delivered"` | Event logged |
| 10.5.4 | Unknown status | `status: "some_new_status"` | Event logged, no action |

### 10.6 Webhook Logging

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 10.6.1 | Every webhook creates log | Any payload | `FyndWebhookLog` record created |
| 10.6.2 | Log includes raw payload | Full Fynd payload | `rawPayload` saved as JSON string |
| 10.6.3 | Log includes error | Processing error | `error` field populated |
| 10.6.4 | Log links to return case | Return found | `returnCaseId` populated |

### 10.7 Edge Cases

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 10.7.1 | Duplicate webhook | Same payload received twice | Idempotent — no duplicate refund |
| 10.7.2 | Webhook with no auth session | No offline session for shop | Error: "No offline session" |
| 10.7.3 | Webhook with malformed payload | Missing required fields | Graceful handling, error logged |
| 10.7.4 | Concurrent webhooks | Two webhooks for same return simultaneously | No race condition on refund |

---

## 11. Shopify Webhooks

### 11.1 Orders Fulfilled

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 11.1.1 | Order fulfilled — has matching return | Shopify `orders/fulfilled` webhook | `ReturnEvent` created: `order_fulfilled` |
| 11.1.2 | Order fulfilled — no matching return | No return for this order | No action |

### 11.2 Orders Updated

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 11.2.1 | Order cancelled — active return | Order `cancelled`, return `pending` | Return auto-cancelled |
| 11.2.2 | Order refunded externally | `financialStatus: "refunded"` via Shopify | Return updated accordingly |
| 11.2.3 | Order voided | `financialStatus: "voided"` | Return auto-cancelled |
| 11.2.4 | Order updated — no impact | Normal update, not cancelled/refunded | No action |

### 11.3 App Lifecycle

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 11.3.1 | App uninstalled | `app/uninstalled` webhook | All sessions for shop deleted |
| 11.3.2 | Scopes updated | `app/scopes_update` webhook | Acknowledged, no action |

---

## 12. Notifications (SMTP)

### 12.1 SMTP Configuration

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 12.1.1 | Valid SMTP config | Host, port, user, pass all set | Emails sent successfully |
| 12.1.2 | SMTP not configured | No `smtpHost` | Emails silently skipped |
| 12.1.3 | Invalid SMTP credentials | Wrong password | `testSmtpConnection` fails, emails fail |
| 12.1.4 | Test SMTP connection — success | Valid config, `intent: "test_smtp"` | `{ success: true }` |
| 12.1.5 | Test SMTP connection — failure | Invalid host | `{ success: false, error: "..." }` |
| 12.1.6 | SMTP with SSL (port 465) | `smtpSecure: true`, `smtpPort: 465` | SSL connection established |
| 12.1.7 | SMTP with STARTTLS (port 587) | `smtpSecure: false`, `smtpPort: 587` | STARTTLS upgrade works |
| 12.1.8 | SMTP timeout | Server unreachable | Connection timeout (10s) |

### 12.2 Email Types

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 12.2.1 | New return email to admin | New return created | Email with return details to `adminNotifyEmail` |
| 12.2.2 | Approval email to customer | Return approved | Email with order name, approval message |
| 12.2.3 | Rejection email to customer | Return rejected, `rejectionReason` set | Email includes rejection reason |
| 12.2.4 | Refund email to customer | Refund processed | Email with refund amount, method |
| 12.2.5 | OTP email | OTP requested for portal login | Email with 6-digit OTP code |

### 12.3 Notification Toggles

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 12.3.1 | New return toggle OFF | `notificationNewReturn: false` | No email on new return, returns `{ success: true }` |
| 12.3.2 | Approval toggle OFF | `notificationApproved: false` | No email on approval |
| 12.3.3 | Rejection toggle OFF | `notificationRejected: false` | No email on rejection |
| 12.3.4 | Refund toggle OFF | `notificationRefunded: false` | No email on refund |
| 12.3.5 | All toggles OFF | All false | No emails except OTP |
| 12.3.6 | OTP email — no toggle | OTP always sent when requested | OTP has no toggle, always sends (if SMTP configured) |

### 12.4 Email Content

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 12.4.1 | From address correct | `smtpFromEmail: "returns@store.com"`, `smtpFromName: "Store Returns"` | Email from "Store Returns <returns@store.com>" |
| 12.4.2 | HTML template renders | All email types | Valid HTML with styling, no broken layout |
| 12.4.3 | XSS in customer input | Customer notes contain `<script>` | HTML escaped in email template |
| 12.4.4 | Long order name | Order name > 50 chars | Properly truncated/displayed |
| 12.4.5 | Missing customer email | Return has no `customerEmailNorm` | Notification skipped gracefully |

### 12.5 Sound Notifications

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 12.5.1 | Sound enabled + new return | `adminSoundEnabled: true`, new pending return detected | Browser audio plays |
| 12.5.2 | Sound disabled | `adminSoundEnabled: false` | No sound |
| 12.5.3 | Sound preview in settings | Click preview button | Notification sound plays once |

---

## 13. Settings — Return Settings

### 13.1 Save & Load

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 13.1.1 | Save all settings | Fill all fields, click Save | All fields persisted, success message |
| 13.1.2 | Load saved settings | Refresh page | All saved values loaded correctly |
| 13.1.3 | Discard changes | Modify fields, click Discard | Navigate back to settings index |

### 13.2 No-Return Period

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 13.2.1 | Enable no-return period | Check enable, set dates | Saved correctly |
| 13.2.2 | Disable no-return period | Uncheck enable | `noReturnPeriodEnabled: false` |
| 13.2.3 | Invalid dates (end before start) | Start: 2026-03-15, End: 2026-03-01 | Verify validation |
| 13.2.4 | Enable without dates | Check enable, no dates set | Saved but no effect |

### 13.3 Product Tag Restrictions

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 13.3.1 | Add tag | Type "sale", click Add | Tag added to list |
| 13.3.2 | Add duplicate tag | Type existing tag "sale" | Not added (duplicate prevented) |
| 13.3.3 | Remove tag | Click × on tag | Tag removed |
| 13.3.4 | Add tag via Enter key | Type tag, press Enter | Tag added |
| 13.3.5 | Empty tag input | Click Add with empty input | No tag added |

### 13.4 Photo Requirement

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 13.4.1 | Enable photo required | Select "Yes" | `photoRequired: true` |
| 13.4.2 | Disable photo required | Select "No" | `photoRequired: false` |

### 13.5 Return Fee

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 13.5.1 | Set return fee | Amount: 50, Currency: INR | `returnFeeAmount: 50`, `returnFeeCurrency: "INR"` |
| 13.5.2 | Zero fee | Amount: 0 | No fee applied |
| 13.5.3 | Negative fee | Amount: -10 | Clamped to 0 |
| 13.5.4 | Decimal fee | Amount: 49.99 | Saved correctly |

### 13.6 Auto-Approve & Auto-Refund

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 13.6.1 | Enable auto-approve | Select "Yes" | `autoApproveEnabled: true` |
| 13.6.2 | Enable auto-refund | Select "Yes" | `autoRefundEnabled: true` |
| 13.6.3 | Both enabled | Enable both | Both saved correctly |
| 13.6.4 | Disable both | Select "No" for both | Both `false` |

---

## 14. Settings — Fynd Integration

### 14.1 Credentials

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 14.1.1 | Save valid credentials | Company ID, App ID, Client ID, Client Secret | Encrypted and saved, "Connected" badge |
| 14.1.2 | Test platform connection — success | Valid credentials | `{ success: true }`, token fetched |
| 14.1.3 | Test platform connection — failure | Invalid client secret | Error message shown |
| 14.1.4 | Clear credentials | Click Clear | All Fynd credentials removed |
| 14.1.5 | Save without all fields | Missing Client Secret | Partial save (verify behavior) |

### 14.2 Environment

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 14.2.1 | Set environment to UAT | Select "UAT" | `fyndEnvironment: "uat"`, uses UAT API base |
| 14.2.2 | Set environment to Production | Select "Production" | `fyndEnvironment: "prod"` |
| 14.2.3 | Custom base URL | Enter custom URL | `fyndCustomBaseUrl` saved, overrides env URL |
| 14.2.4 | App mode — dev | Select "Dev" | Dev banner shown in app |
| 14.2.5 | App mode — prod | Select "Prod" | No dev banner |

### 14.3 Webhook Registration

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 14.3.1 | Register Fynd webhook | Click Register in setup | Webhook URL registered with Fynd |
| 14.3.2 | Test webhook | Click Test | Test payload sent, processed |
| 14.3.3 | Webhook already registered | URL already exists | Shows "Already registered" |
| 14.3.4 | Register without credentials | Fynd not configured | Error: credentials required |

---

## 15. Settings — Notifications

### 15.1 SMTP Configuration

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 15.1.1 | Save SMTP settings | Fill host, port, user, pass | Settings saved |
| 15.1.2 | Test connection — success | Valid SMTP | "Connected successfully" |
| 15.1.3 | Test connection — wrong host | Invalid hostname | Error with specific message |
| 15.1.4 | Test connection — wrong password | Invalid credentials | Auth failure error |
| 15.1.5 | Enable SSL toggle | `smtpSecure: true` | SSL mode enabled |
| 15.1.6 | Custom from email and name | `smtpFromEmail`, `smtpFromName` | Used in all outgoing emails |

### 15.2 Notification Toggles

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 15.2.1 | Toggle new return notification | ON → OFF → ON | Correctly toggles |
| 15.2.2 | Toggle approval notification | ON → OFF | Saved, no emails on approval |
| 15.2.3 | Toggle rejection notification | ON → OFF | Saved |
| 15.2.4 | Toggle refund notification | ON → OFF | Saved |
| 15.2.5 | Settings index shows count | 3 of 4 enabled | Shows "3/4 enabled" |

### 15.3 Admin Alerts

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 15.3.1 | Set admin email | Valid email | Saved, used for new return notifications |
| 15.3.2 | Enable sound alerts | Toggle ON | Sound plays on new returns |
| 15.3.3 | Sound preview button | Click preview | Sound plays once |

### 15.4 Email Template Previews

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 15.4.1 | Preview new return template | Click preview | HTML template rendered in-page |
| 15.4.2 | Preview approval template | Click preview | Template shown |
| 15.4.3 | Preview rejection template | Click preview | Template shown |
| 15.4.4 | Preview refund template | Click preview | Template shown |

---

## 16. Settings — Portal Widget & Theme

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 16.1 | Save portal theme colors | Primary, background, text colors | Theme JSON saved |
| 16.2 | Change font family | Select from font options | Font saved in theme |
| 16.3 | Save portal config | Logo URL, header text, etc. | Config JSON saved |
| 16.4 | Portal URL displayed | App proxy URL shown | Correct URL format |
| 16.5 | Theme applied to portal | Visit portal URL | Colors, fonts match saved theme |

---

## 17. Settings — Permissions

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 17.1 | Enable read all orders | Toggle ON | `readAllOrdersEnabled: true` |
| 17.2 | Disable read all orders | Toggle OFF | `readAllOrdersEnabled: false` |
| 17.3 | Permissions display | Current scopes shown | OAuth scopes listed accurately |

---

## 18. Settings — Policy Rules

### 18.1 Return Reasons

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 18.1.1 | Add return reason | Title + code | Reason added to list |
| 18.1.2 | Remove return reason | Click remove | Reason removed |
| 18.1.3 | Reorder reasons | Drag and drop | Order saved |
| 18.1.4 | Reasons by category | Category-specific reasons | Saved in `returnReasonsByCategoryJson` |

### 18.2 Region Restrictions

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 18.2.1 | Add restricted region | Country + Province | Saved in `restrictedRegionsJson` |
| 18.2.2 | Remove region | Click remove | Region removed |
| 18.2.3 | Multiple regions | Add 5 regions | All saved |

### 18.3 Return Offers

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 18.3.1 | Configure return offers | Exchange, store credit options | Saved in `returnOffersJson` |

---

## 19. Portal Authentication (OTP)

### 19.1 OTP Send

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 19.1.1 | Send OTP — valid session | Valid `sessionId` with email target | 6-digit OTP generated, email sent |
| 19.1.2 | Send OTP — expired session | `expiresAt` in past | 400 — Session expired |
| 19.1.3 | Send OTP — too many attempts | `attemptsCount >= 5` | 429 — Too many attempts |
| 19.1.4 | Send OTP — cooldown active | OTP sent < 60s ago | 429 — Wait before resending |
| 19.1.5 | Send OTP — invalid session ID | Non-existent session | 400 — Session not found |
| 19.1.6 | Send OTP — non-email target | Phone number as target | OTP logged (dev mode), no email sent |

### 19.2 OTP Verify

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 19.2.1 | Verify correct OTP | Matching OTP within 10 min | `{ portalToken }` returned, session verified |
| 19.2.2 | Verify wrong OTP | Wrong code | 400 — Invalid OTP, `attemptsCount` incremented |
| 19.2.3 | Verify expired OTP | OTP sent > 10 min ago | 400 — OTP expired |
| 19.2.4 | Verify after max attempts | 5 wrong attempts | 429 — Too many attempts |
| 19.2.5 | Verify — session expired | `expiresAt` in past | 400 — Session expired |
| 19.2.6 | Verify — already verified | Session already has `verifiedAt` | Verify behavior (new token or error?) |

### 19.3 Portal Token

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 19.3.1 | Use valid portal token | `Authorization: Bearer <token>` | Returns list for verified session |
| 19.3.2 | Use expired token | Token with expired session | 401 — Unauthorized |
| 19.3.3 | Use invalid token | Malformed JWT | 401 — Invalid token |
| 19.3.4 | Missing authorization header | No `Authorization` header | 401 — Token required |
| 19.3.5 | Token for unverified session | Session without `verifiedAt` | 401 — Unverified |

---

## 20. Fynd Enrichment

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 20.1 | Enrich order — Fynd configured | `type: "order"`, valid `orderName` | Fynd data returned with shipment details |
| 20.2 | Enrich order — cached mapping exists | `FyndOrderMapping` has entry | Uses cached `fyndOrderId`, skips search |
| 20.3 | Enrich order — no cache, search succeeds | No mapping, Fynd search finds order | Data returned, cache updated |
| 20.4 | Enrich order — Fynd not configured | No Fynd credentials | `{ fyndData: null }` |
| 20.5 | Enrich order — search fails | Fynd API error | `{ fyndData: null }` |
| 20.6 | Enrich returns — multiple returns | `type: "returns"`, 3 return IDs | Enrichment data for each |
| 20.7 | Enrich returns — some have no Fynd ID | Mixed returns | Only enriched returns have data |
| 20.8 | Missing shop parameter | No `shop` | 400 error |
| 20.9 | Non-existent shop | Invalid shop domain | 404 error |

---

## 21. Rate Limiting & Security

### 21.1 Rate Limits

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 21.1.1 | Lookup rate limit | > 30 requests/minute | 429 — Rate limited |
| 21.1.2 | Order rate limit | > 30 requests/minute | 429 |
| 21.1.3 | Create return rate limit | > 5 requests/5 minutes | 429 |
| 21.1.4 | OTP send rate limit | > 5 requests/5 minutes | 429 |
| 21.1.5 | OTP verify rate limit | > 10 requests/minute | 429 |
| 21.1.6 | Fynd enrich rate limit | > 60 requests/minute | 429 |
| 21.1.7 | Rate limit resets | Wait for window to pass | Requests allowed again |

### 21.2 CORS

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 21.2.1 | Portal API CORS headers | Request from customer portal domain | Correct `Access-Control-Allow-Origin` |
| 21.2.2 | Preflight OPTIONS request | OPTIONS method | Correct CORS headers returned |
| 21.2.3 | Cross-origin without CORS | Request from unauthorized origin | Verify behavior |

### 21.3 Authentication

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 21.3.1 | Admin auth — valid session | Authenticated Shopify session | Access granted |
| 21.3.2 | Admin auth — expired session | Expired session | Redirect to login |
| 21.3.3 | Admin auth — no session | Unauthenticated request | Redirect to OAuth |
| 21.3.4 | Portal auth — valid bearer | Valid JWT token | Access granted |
| 21.3.5 | Portal auth — tampered token | Modified JWT payload | 401 |

### 21.4 Data Security

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 21.4.1 | Fynd credentials encrypted | Save Fynd client secret | Stored encrypted in DB |
| 21.4.2 | OTP hashed | OTP generated | Stored as hash, not plaintext |
| 21.4.3 | Constant-time OTP comparison | Verify OTP | No timing attack vulnerability |
| 21.4.4 | Lookup value hashed | Email/phone for session | `lookupValueHash` stored, not raw value |
| 21.4.5 | Error messages sanitized | API error to customer | Safe patterns only, no internal details |

---

## 22. Edge Cases & Error Handling

### 22.1 Database Edge Cases

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 22.1.1 | Shop not in DB | First request from new shop | `findOrCreateShop` creates shop |
| 22.1.2 | Settings not created yet | New shop, no `ShopSettings` | Defaults used for all settings |
| 22.1.3 | Concurrent return creation | Two requests at same millisecond | Transaction ensures no duplicate |
| 22.1.4 | Return with no items | Edge case in data | Handled gracefully |
| 22.1.5 | Very long admin notes | 10,000+ character notes | Saved without truncation (DB allows) |
| 22.1.6 | Unicode in customer data | Japanese/emoji in customer name | Stored and displayed correctly |

### 22.2 Shopify API Edge Cases

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 22.2.1 | Order with no line items | Empty order | "No line items" error on refund |
| 22.2.2 | Order with deleted products | Product no longer exists | Refund uses available line item data |
| 22.2.3 | Order with partial fulfillment | Some items shipped, some not | Only fulfilled items available for return |
| 22.2.4 | Order ID as GID | `gid://shopify/Order/12345` | Handled without conversion |
| 22.2.5 | Order ID as numeric string | `"12345"` | Converted to GID |
| 22.2.6 | Order ID as order name | `"#1042"` | Resolved via `fetchOrderByOrderNumber` |
| 22.2.7 | Shopify API timeout | Network timeout | Graceful error message |
| 22.2.8 | Shopify API rate limit | 429 from Shopify | Error propagated with retry message |
| 22.2.9 | suggestedRefund returns zero amount | Already partially refunded order | Handle zero-amount edge |
| 22.2.10 | suggestedRefund with no transactions | No payment captured | Handle missing transaction data |

### 22.3 Fynd API Edge Cases

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 22.3.1 | Fynd returns object instead of string | Fynd API returns `{name: "..."}` for a string field | `safeStr` utility handles object-to-string |
| 22.3.2 | Fynd payload missing fields | Webhook with minimal payload | No crash, missing fields treated as null |
| 22.3.3 | Fynd order ID has prefix | `shopifyOrderName: "#RPM-1042"` | `#` stripped during lookup |
| 22.3.4 | Fynd webhook with empty refund_status | `refund_status: ""` or `null` | Treated as non-actionable, event logged |
| 22.3.5 | Very large Fynd payload | Payload > 1MB | Stored in `fyndPayloadJson` if under limit |

### 22.4 UI Edge Cases

| # | Test Case | Input | Expected Result |
|---|-----------|-------|-----------------|
| 22.4.1 | Empty state — no returns | New install, no returns | Proper empty state with CTA |
| 22.4.2 | Empty state — no settings | New install | Default values shown |
| 22.4.3 | Loading state — slow API | Slow Shopify response | Loading spinners shown |
| 22.4.4 | Error boundary — route error | Loader throws error | Error boundary with helpful message |
| 22.4.5 | Form submission during loading | Double-click submit | Button disabled during submission |
| 22.4.6 | Very long return list | 1000+ returns | Pagination works correctly |
| 22.4.7 | Narrow viewport | Mobile/tablet width | Responsive layout |
| 22.4.8 | Return detail — missing Shopify order | Order deleted from Shopify | Graceful display with available data |

---

## 23. Cross-System Integration Scenarios

### 23.1 Full Return Lifecycle — Happy Path

| Step | System | Action | Expected |
|------|--------|--------|----------|
| 1 | Customer Portal | Look up order #1042 by email | Order found, eligible |
| 2 | Customer Portal | Submit return for 2 items with photos | Return created, status `pending` |
| 3 | SMTP | — | Admin receives new return email |
| 4 | Admin App | View return in list | Return visible with status `pending` |
| 5 | Admin App | Approve return with notes | Status → `approved` |
| 6 | SMTP | — | Customer receives approval email |
| 7 | Fynd | Return synced to Fynd | `fyndSyncStatus: "synced"`, `fyndReturnId` set |
| 8 | Fynd Webhook | Shipment picked up | Event logged, UI shows pickup status |
| 9 | Fynd Webhook | Shipment in transit | Event logged |
| 10 | Fynd Webhook | Return delivered | Event logged |
| 11 | Fynd Webhook | Credit note generated | Auto-refund triggered (if enabled) |
| 12 | Shopify | Refund created | `refundStatus: "refunded"`, `status: "completed"` |
| 13 | SMTP | — | Customer receives refund email |
| 14 | Customer Portal | Check return status | Shows "Refund Completed" |

### 23.2 Full Return Lifecycle — Manual Refund

| Step | System | Action | Expected |
|------|--------|--------|----------|
| 1–10 | — | Same as happy path | — |
| 11 | Fynd Webhook | Credit note generated, `autoRefundEnabled: false` | Event logged, no refund |
| 12 | Admin App | Open return detail | "Process Refund" button visible |
| 13 | Admin App | Click refund, select "Store credit", confirm | Shopify store credit refund created |
| 14 | Shopify | Store credit issued | `refundStatus: "refunded"`, `refundMethod: "store_credit"` |
| 15 | SMTP | — | Customer receives refund email |

### 23.3 Auto-Approve + Auto-Refund (Fully Automated)

| Step | System | Action | Expected |
|------|--------|--------|----------|
| 1 | Customer Portal | Submit return | Return created |
| 2 | App | `autoApproveEnabled: true` | Status → `approved`, Fynd sync |
| 3 | SMTP | — | Admin email (new) + customer email (approved) |
| 4 | Fynd | Processes return | Various webhook status updates |
| 5 | Fynd Webhook | `credit_note_generated` | Auto-refund triggered |
| 6 | Shopify | Refund with configured payment method | Refund completed |
| 7 | SMTP | — | Customer receives refund email |
| 8 | — | Zero admin interaction required | Full automation verified |

### 23.4 Rejection Flow

| Step | System | Action | Expected |
|------|--------|--------|----------|
| 1 | Customer Portal | Submit return | Status `pending` |
| 2 | Admin App | Reject with reason "Item is damaged beyond policy" | Status → `rejected` |
| 3 | SMTP | — | Customer receives rejection email with reason |
| 4 | Customer Portal | Check status | Shows "Rejected" with reason |
| 5 | Customer Portal | Submit new return for same order | Allowed (rejected is terminal) |

### 23.5 Manual Return Flow (No Shopify Order)

| Step | System | Action | Expected |
|------|--------|--------|----------|
| 1 | Customer Portal | Submit manual return (PCDA fallback) | Return with `shopifyOrderId: "manual:..."` |
| 2 | Admin App | View manual return | "Manual Return" badge, no Shopify order tab |
| 3 | Admin App | Approve | Status → `approved`, no Fynd sync |
| 4 | Fynd Webhook | `refund_done` for manual return | Status → `completed`, refund marked (no Shopify API) |
| 5 | SMTP | — | Customer notified |

### 23.6 Split Refund — End to End

| Step | System | Action | Expected |
|------|--------|--------|----------|
| 1 | Settings | Set `refundPaymentMethod: "both"`, `storeCreditPct: 60` | Settings saved |
| 2 | Customer Portal | Submit return for ₹1000 order | Return created |
| 3 | Admin App | Approve + process refund (settings pre-filled) | Modal shows 60/40 split |
| 4 | Shopify | `refundCreate` with `storeCreditRefund: ₹600` + `transactions: ₹400` | Both processed |
| 5 | DB | `refundJson.method: "both"` | Correct method recorded |
| 6 | SMTP | — | Refund email sent |

### 23.7 Fynd Webhook — Refund Already Done in Shopify

| Step | System | Action | Expected |
|------|--------|--------|----------|
| 1 | Admin App | Process refund manually | Shopify refund done |
| 2 | Fynd Webhook | `refund_done` arrives later | `createRefund` returns "already refunded" |
| 3 | App | Detects already-refunded pattern | `refundStatus: "refunded"`, `status: "completed"` |
| 4 | — | No duplicate refund issued | Idempotent |

### 23.8 Location Error Recovery

| Step | System | Action | Expected |
|------|--------|--------|----------|
| 1 | Admin App | Process refund with location A | `refundCreate` called with `locationId: A` |
| 2 | Shopify | Returns "location not valid for restock" | User error detected |
| 3 | App | Auto-retry with `restockType: "NO_RESTOCK"` | Second mutation sent |
| 4 | Shopify | Refund succeeds without restock | Refund completed |
| 5 | — | Admin sees success, not error | Transparent retry |

### 23.9 Concurrent Return + Webhook

| Step | System | Action | Expected |
|------|--------|--------|----------|
| 1 | Admin App | Clicks "Process Refund" | Request sent to API |
| 2 | Fynd Webhook | `refund_done` arrives at same time | Second refund attempt |
| 3 | — | First refund succeeds | `refundStatus: "refunded"` |
| 4 | — | Second attempt | Shopify says "already refunded" → treated as success |
| 5 | — | No double refund | Data consistent |

### 23.10 App Reinstall Flow

| Step | System | Action | Expected |
|------|--------|--------|----------|
| 1 | Shopify | Merchant uninstalls app | `app/uninstalled` webhook, sessions deleted |
| 2 | Shopify | Merchant reinstalls app | New OAuth flow |
| 3 | App | New session created | `findOrCreateShop` finds existing shop |
| 4 | Admin App | Settings preserved | Previous `ShopSettings` still exist |
| 5 | Admin App | Returns preserved | Previous `ReturnCase` records intact |
| 6 | App | Re-authorize scopes | `read_locations` and other scopes granted |

### 23.11 Multi-Currency Order

| Step | System | Action | Expected |
|------|--------|--------|----------|
| 1 | Shopify | Order in EUR (store currency USD) | `presentmentMoney` in EUR |
| 2 | Admin App | Process refund | Refund in presentment currency (EUR) |
| 3 | Store Credit | Split refund | `currencyCode: "EUR"` in store credit input |
| 4 | Shopify | Refund completed | Amounts in EUR |

### 23.12 Portal Session Expiry

| Step | System | Action | Expected |
|------|--------|--------|----------|
| 1 | Customer Portal | Start lookup, receive session | `LookupSession` created with `expiresAt` |
| 2 | Customer Portal | Wait past expiry | Session expires |
| 3 | Customer Portal | Try to send OTP | 400 — Session expired |
| 4 | Customer Portal | Try to use old portal token | 401 — Expired |
| 5 | Customer Portal | Start new lookup | New session created |

### 23.13 Notification Failure — Non-Blocking

| Step | System | Action | Expected |
|------|--------|--------|----------|
| 1 | Settings | SMTP configured but server is down | — |
| 2 | Admin App | Approve return | Status → `approved` successfully |
| 3 | SMTP | Email send fails | Error logged |
| 4 | — | Return approval NOT rolled back | Notification failure is non-blocking |
| 5 | Fynd Webhook | Refund notification fails | Refund still marked as complete |

### 23.14 Return With All Eligibility Rules Active

| Step | System | Action | Expected |
|------|--------|--------|----------|
| 1 | Settings | Enable: 30-day window, restricted tags, min price ₹200, region restrictions, no-return period, photo required | All rules active |
| 2 | Customer Portal | Order within window, no restricted tags, price > ₹200, unrestricted region, outside no-return period | All checks pass |
| 3 | Customer Portal | Submit with photos | Return created |
| 4 | Customer Portal | Order outside window | Rejected: "return window expired" |
| 5 | Customer Portal | Product has restricted tag | Rejected: "product not eligible" |
| 6 | Customer Portal | Price below minimum | Rejected: "price below minimum" |
| 7 | Customer Portal | Restricted region | Rejected: "region restricted" |
| 8 | Customer Portal | Order in no-return period | Rejected: "purchased during no-return period" |
| 9 | Customer Portal | Missing photos when required | Rejected: "photos required" |

---

## Appendix: Settings Impact Matrix

| Setting | Portal Create | Admin Approve | Admin Refund | Fynd Webhook Refund | Auto Refund (CN) |
|---------|--------------|---------------|-------------|-------------------|------------------|
| `returnWindowDays` | Eligibility check | — | — | — | — |
| `noReturnPeriodEnabled` | Eligibility check | — | — | — | — |
| `restrictedProductTagsJson` | Per-item check | — | — | — | — |
| `minimumReturnPrice` | Per-item check | — | — | — | — |
| `restrictedRegionsJson` | Eligibility check | — | — | — | — |
| `photoRequired` | Validation | — | — | — | — |
| `returnFeeAmount` | Fee calculation | — | — | — | — |
| `autoApproveEnabled` | Auto-approve | — | — | — | — |
| `autoRefundEnabled` | — | — | — | — | Triggers refund |
| `refundPaymentMethod` | — | — | Pre-fill modal | Used | Used |
| `refundStoreCreditPct` | — | — | Pre-fill slider | Used | Used |
| `refundLocationMode` | — | — | Auto/manual location | Used | Used |
| `refundLocationId` | — | — | Fallback location | Fallback | Fallback |
| `notificationNewReturn` | Send/skip email | — | — | — | — |
| `notificationApproved` | — | Send/skip email | — | — | — |
| `notificationRejected` | — | Send/skip email | — | — | — |
| `notificationRefunded` | — | — | Send/skip email | Send/skip | Send/skip |
| `smtpHost/User/Pass` | OTP email | All emails | All emails | Refund email | Refund email |
| `adminNotifyEmail` | New return email | — | — | — | — |
| `adminSoundEnabled` | — | — | — | — | — |

---

*Total test cases: 250+*
*Last updated: March 2026*
