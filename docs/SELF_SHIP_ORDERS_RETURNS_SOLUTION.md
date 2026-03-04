# Self-Ship Orders & Returns — End-to-End Solution Document

> **Version:** 1.0  
> **Last Updated:** February 2025  
> **References:** Fynd Konnect, Platform REST API, DP Change by Seller Engg Soln (FPCP-871, FPCO-33881)

This document describes the complete flow for **Self Ship / Self Delivery** orders on Fynd Konnect—from user onboarding to channel configuration, logistics setup, and order/returns lifecycle management. It covers all APIs, documentation links, and edge/negative cases.

---

## Table of Contents

1. [Overview](#1-overview)
2. [User & System Categories](#2-user--system-categories)
3. [Configuration Keys & Flags](#3-configuration-keys--flags)
4. [Konnect Onboarding Flow](#4-konnect-onboarding-flow)
5. [Channel Configuration](#5-channel-configuration)
6. [Logistics Configuration](#6-logistics-configuration)
7. [Order Creation & DP Assignment Flow](#7-order-creation--dp-assignment-flow)
8. [Order Journey (Self Ship)](#8-order-journey-self-ship)
9. [Returns Journey (Self Ship)](#9-returns-journey-self-ship)
10. [API Reference](#10-api-reference)
11. [Edge Cases & Negative Scenarios](#11-edge-cases--negative-scenarios)

---

## 1. Overview

### 1.1 Purpose

- **Self Ship** = Seller manages logistics (own delivery partner or aggregator).
- **Marketplace-managed logistics** = Marketplace chooses and manages DP; Fynd does not perform DP selection.
- This document focuses on **Self Ship** flows where orders and returns are managed by the seller via Konnect or third-party aggregators.

### 1.2 Key Concepts

| Concept | Description |
|--------|-------------|
| **Fynd Konnect** | Multi-channel selling platform; unifies orders, returns, inventory across marketplaces, webstores, ERP/WMS. |
| **OMS** | Order Management System; central hub for orders, fulfillment, shipping, returns. |
| **DP** | Delivery Partner (Courier Partner). |
| **LAPA** | Plan enabling DP dropdown for manual DP selection. |
| **Stormbreaker** | Internal service for courier partner serviceability and rules. |

### 1.3 Documentation Links

| Resource | URL |
|----------|-----|
| Fynd Platform REST API | [https://docs.fynd.com/partners/commerce/sdk/latest/platform/client-libraries#introduction](https://docs.fynd.com/partners/commerce/sdk/latest/platform/client-libraries#introduction) |
| Fynd Konnect Introduction | [https://documentation.fynd.com/konnect/docs/introduction](https://documentation.fynd.com/konnect/docs/introduction) |
| Channels Overview | [https://documentation.fynd.com/konnect/docs/seller-onboarding/channels-overview](https://documentation.fynd.com/konnect/docs/seller-onboarding/channels-overview) |
| Company Auth | [https://documentation.fynd.com/konnect/docs/seller-onboarding/company-auth](https://documentation.fynd.com/konnect/docs/seller-onboarding/company-auth) |
| Self-Ship via Aggregators | [https://documentation.fynd.com/konnect/channels/erp-wms/whats-new/self-ship](https://documentation.fynd.com/konnect/channels/erp-wms/whats-new/self-ship) |
| Logistics Extension API Guide | [https://docs.fynd.com/partners/commerce/extension/logistics/api-guide/](https://docs.fynd.com/partners/commerce/extension/logistics/api-guide/) |
| Platform Order API | [https://docs.fynd.com/partners/commerce/sdk/latest/platform/company/order](https://docs.fynd.com/partners/commerce/sdk/latest/platform/company/order) |
| Serviceability | [https://docs.fynd.com/partners/commerce/sdk/latest/platform/application/serviceability](https://docs.fynd.com/partners/commerce/sdk/latest/platform/application/serviceability) |
| Delivery Setup | [https://docs.fynd.com/commerce/docs/Logistics/delivery_setup/](https://docs.fynd.com/commerce/docs/Logistics/delivery_setup/) |
| RMA Rules | [https://docs.fynd.com/commerce/docs/manage-website/other-configuration/rma/](https://docs.fynd.com/commerce/docs/manage-website/other-configuration/rma/) |
| Konnect ERP/WMS API | [https://documentation.fynd.com/konnect/channels/erp-wms/api-documentation](https://documentation.fynd.com/konnect/channels/erp-wms/api-documentation) |

---

## 2. User & System Categories

| Category | User Type | UI Usage | DP Selection |
|----------|-----------|----------|---------------|
| **Category 1** | WMS users | Direct Fynd WMS | OMS UI for DP selection |
| **Category 2** | Tools using Fynd WMS | OMS UI for changes | OMS UI for DP selection |
| **Category 3** | Third-party aggregators (Unicommerce, etc.) | Own system UI | API-driven only; no Fynd UI |

**Implication:** UI flows (DP dropdown, manual update) apply only to Category 1 & 2. Category 3 uses APIs exclusively.

---

## 3. Configuration Keys & Flags

### 3.1 Logistics Mode

| Mode | Description | DP Selection on Fynd |
|------|-------------|----------------------|
| **Marketplace-managed** | Marketplace manages DP | No DP selection needed |
| **Self / Seller-managed** | Seller manages logistics | DP selection required |

### 3.2 `is_self_ship`

| Value | Behavior |
|-------|----------|
| `false` or absent | Not self-ship; DP selection not required |
| `true` | Self-ship; DP selection logic and UI applicable |

**Source:** Order payload or response from Fetch Orders / Fetch Returns.

### 3.3 CP Configuration (`cp_configuration`)

- Used at order level to decide DP assignment behavior.
- When `is_self_ship = false`, CP configuration does not affect DP selection.

### 3.4 `extension_managed_cp`

- Used for **Konnect** marketplace self-ship.
- Path: `cp_configuration.extension_managed_cp`
- When `extension_managed_cp = true`:
  - DP assignment/cancellation is managed by the extension (aggregator).
  - OMS does not call `/courier-partners` Stormbreaker API for dropdown.
  - Courier partners passed in create order payload are shown in dropdown.

### 3.5 Dummy DP ID

- Used for configurations where real DP selection is not required.
- Example: `dummy DP ID = 30`.
- Acts as placeholder for internal logic.

### 3.6 `dp_manually_updated`

- Flag set when seller manually overrides DP from UI.
- When `true`: auto-reassignment logic is **disabled** for that order.

---

## 4. Konnect Onboarding Flow

### 4.1 Step-by-Step Onboarding

1. **Log in to Fynd Platform**
   - [https://platform.fynd.com](https://platform.fynd.com)

2. **Company Setup**
   - Company → Settings → Developers
   - Create OAuth client with required scopes:
     - `company/orders/read`
     - `company/orders/write`
     - `company/settings` (for webhook registration)

3. **Access Konnect**
   - Navigate to **Channels → All Channels** from left sidebar

4. **Configure Channel**
   - **Live** or **Configured** → Click **Configure**
   - Choose **Company Auth** or **Store Auth**

### 4.2 Company Auth Configuration

| Step | Action |
|------|--------|
| **Account Name** | Enter unique name (cannot be changed later) |
| **Shipping Type** | Pre-populated: **Ship by Marketplace** or **Ship by Seller** |
| **Order Sync** | Toggle ON; set start date (orders before this date not fetched) |
| **Return Sync** | Toggle ON; set start date (returns before this date not fetched) |
| **Inventory Sync** | Toggle ON for real-time stock sync |
| **Product Mapping** | Toggle ON if needed |
| **Inventory Reconciliation** | Toggle ON to detect/resolve inventory mismatches |

5. **Locations**
   - Validate company-level credentials
   - Map each location to **Channel Location ID**
   - Set status (Active/Inactive)

6. **Submit**
   - Click **Submit** after review

**Reference:** [Company Auth](https://documentation.fynd.com/konnect/docs/seller-onboarding/company-auth)

---

## 5. Channel Configuration

### 5.1 Channel Types

| Type | Description |
|------|-------------|
| **Marketplace** | Flipkart, Amazon, Meesho, etc. |
| **Webstore** | Brand-owned storefront |
| **ERP/WMS** | Warehouse / order management systems |
| **POS** | Point-of-sale |
| **Custom** | Custom integrations |

### 5.2 Shipping Type

- **Ship by Marketplace** → Marketplace manages DP; no DP selection on Fynd.
- **Ship by Seller** → Self-ship; DP selection logic applies.

### 5.3 Ordering Channels (Examples)

| Channel | Value |
|---------|-------|
| Fynd Store | `FYND-STORE` |
| ECOMM | `ECOMM` |
| Flipkart | `FLIPKART` |
| Myntra | `MYNTRA_IN` |
| Shopify | `SHOPIFY_IN` |
| Meesho | `MEESHO` |

### 5.4 Location Mapping

- Each Konnect location → **Channel Location ID** (marketplace/ERP identifier)
- `locationCode` is **mandatory** for company-level auth in Fetch Orders / Fetch Returns.

---

## 6. Logistics Configuration

### 6.1 Delivery Setup (Platform Panel)

- **Path:** Platform Panel → Sales Channel → Settings → Logistics & Support → Delivery Setup
- **Options:**
  - Third-party delivery partners (extensions)
  - Self-delivery

### 6.2 Courier Partner Setup

1. **Install extension** (e.g., Shiprocket, Delhivery, etc.)
2. **Create scheme** via Logistics Extension API:
   - `createCourierPartnerScheme` / `updateCourierPartnerScheme`
3. **Scheme parameters:**
   - `delivery_type`: standard, hyperlocal, sdd, ndd
   - `extension_id`, `scheme_id`
   - `payment_mode`: prepaid, cod, or both
   - `region`: intra-city, inter-city, inter-state, inter-country
   - `transport_type`: surface, air, waterways
   - `weight`, `volumetric_weight` limits
   - `feature`: doorstep_qc, doorstep_return, ewaybill, etc.

4. **Serviceability**:
   - Upload serviceability data for pincodes/regions
   - `bulkServiceability` API

5. **TAT**:
   - Upload TAT data for delivery time estimates
   - Same file upload process as serviceability

6. **Account creation**:
   - `createCourierPartnerAccount` / `updateCourierPartnerAccount`
   - `is_self_ship`: `true` for self-ship accounts
   - `is_own_account`: `true` for seller-managed credentials

### 6.3 Shipping Rules (Rule Engine)

- Configure courier partners in sales channel via rule engine
- Stormbreaker filters by address and availability
- Rules determine which DPs are shown in dropdown (serviceable)

### 6.4 RMA Rules

- **Path:** Platform Panel → Sales Channel → Settings → Logistics & Support → RMA
- Configure return reasons, sub-reasons, QC rules
- **Reference:** [RMA Rules](https://docs.fynd.com/commerce/docs/manage-website/other-configuration/rma/)

---

## 7. Order Creation & DP Assignment Flow

### 7.1 Pre-Check / Serviceability

1. System calls **logistics serviceability API** with shipment details.
2. Returns **prioritized list of DPs** (DP1, DP2, DP3, …).

### 7.2 Order Creation

- **New create order API:** `/orders` (FDK: `createOrder`)
- **Required for self-ship:** `is_self_ship = true` and courier partners in payload
- **Payload:** Order details, shipment details, `DP_ID` (top priority from logistics API), `is_self_ship`, CP config

**Note:** Old create-order API with `optimal_shipment_creation` off does **not** support self-ship + courier partners in payload. Use new create order API.

### 7.3 Happy Path

1. Order created with DP1 (top priority)
2. Logistics confirms DP1 serviceable
3. OMS marks **DP Assigned**
4. Flow: Confirmed → Packed → Invoice → Ready for Dispatch → Shipped

### 7.4 DP Not Serviceable Later

1. **Detection:** At Confirm / Invoice / Ready for DP, system finds DP not serviceable.
2. **Auto fallback:**
   - Call logistics API again
   - Get updated list (DP2, DP3, …)
   - Try DP2, DP3, … until one is serviceable
   - If none: order stays **DP not assigned**
3. **Scope:** Auto-assignment only for **DP not assigned**; not for manually updated orders.

### 7.5 Manual DP Update (UI)

- **States:** Place Confirm, Invoice Ready for DP, DP not assigned
- **Flow:** Seller selects DP from dropdown → OMS updates → `dp_manually_updated = true`
- **Reverse flow:** After manual update, auto-reassignment is **disabled**.

---

## 8. Order Journey (Self Ship)

### 8.1 Flow Overview

```
CREATED → CONFIRMED → PROCESSING (dp_assigned) → COMPLETED / TRANSIT → DELIVERED
```

### 8.2 Konnect Self-Ship: Forward Orders

| Step | Action | API |
|------|--------|-----|
| 1 | Fetch new orders | `GET /oms/v3/shipment?orderStatus=CREATED` (or CONFIRMED) |
| 2 | Filter `is_self_ship = true` | Check response |
| 3 | Order confirmation | `POST /oms/v3/order/confirmation` |
| 4 | Invoice update | `POST /oms/v3/order/invoice` |
| 5 | Fetch invoice PDF | `POST /oms/v3/order/customer-invoice` |
| 6 | Await physical dispatch | — |
| 7 | Update AWB + courier | `PUT /oms/v3/shipment/awb` |
| 8 | Update status to bag_picked | `PUT /oms/v3/shipment/status` (orderStatus=bag_picked) |
| 9 | Order dispatch | `POST /oms/v3/order/dispatch` |
| 10 | Order pack | `POST /oms/v3/order/pack` |
| 11 | Delivery done | `PUT /oms/v3/shipment/status` (orderStatus=delivery_done) |

### 8.3 Auto Dispatch

- **Update AWB** with `autoDispatch: true` → transitions directly from `dp_assigned` to `bag_picked` in one call.
- Without `autoDispatch`: must call Order Pack, Order Dispatch, then Update Shipment Status separately.

### 8.4 Order Status Mapping

| Konnect `orderStatus` | Fynd OMS State |
|----------------------|---------------|
| `CREATED` | placed, store_reassigned |
| `CONFIRMED` | bag_confirmed |
| `PROCESSING` | bag_invoiced, dp_assigned |
| `COMPLETED` | bag_packed, bag_not_picked |
| `TRANSIT` | bag_picked |
| `HANDED_OVER_TO_CUSTOMER` | handed_over_to_customer |
| `DELIVERED` | delivery_done |

---

## 9. Returns Journey (Self Ship)

### 9.1 Flow Overview

```
return_initiated → return_dp_assigned → return_bag_in_transit → return_bag_delivered → return_accepted → credit_note
```

### 9.2 Konnect Self-Ship: Customer Returns

| Step | Action | API |
|------|--------|-----|
| 1 | Fetch returns | `GET /oms/v3/shipment?orderStatus=RETURN_PROCESSING` |
| 2 | Filter `is_self_ship = true` | Check response |
| 3 | Await physical pickup | — |
| 4 | Update AWB + courier | `PUT /oms/v3/shipment/awb` |
| 5 | Update status | `PUT /oms/v3/shipment/status` (orderStatus=return_bag_in_transit) |
| 6 | Return delivered | `PUT /oms/v3/shipment/status` (orderStatus=return_bag_delivered) |
| 7 | Update Return & QC | `POST /oms/v3/return/qc` (return_accepted) |
| 8 | Credit note | `POST /oms/v3/return/credit-note` or auto-generated |

### 9.3 RTO Flow

| Step | Action | API |
|------|--------|-----|
| 1 | Forward: dp_assigned → bag_picked | `PUT /oms/v3/shipment/status` |
| 2 | RTO delivered | `PUT /oms/v3/shipment/status` (orderStatus=rto_bag_delivered) |
| 3 | Credit note | `POST /oms/v3/return/credit-note` or auto-generated |

---

## 10. API Reference

### 10.1 Authentication

**OAuth Token (Client Credentials):**

```
POST https://api.fynd.com/service/panel/authentication/v1.0/company/{company_id}/oauth/token
```

- **Headers:** `Authorization: Basic {base64(client_id:client_secret)}`, `Content-Type: application/json`
- **Body:** `{"grant_type":"client_credentials"}`
- **Response:** `access_token`, `expires_in`, `scope`

**Reference:** [Platform REST API - Authentication](https://docs.fynd.com/partners/commerce/sdk/latest/platform/client-libraries#getting-access-token-client-cred)

---

### 10.2 Konnect APIs (ERP/WMS)

| API | Method | Endpoint | Doc |
|-----|--------|----------|-----|
| Fetch Orders | GET | `https://{{host}}/oms/v3/shipment` | [Get Orders](https://documentation.fynd.com/konnect/channels/erp-wms/api-documentation/orders/get-orders) |
| Fetch Returns | GET | `https://{{host}}/oms/v3/shipment?orderStatus=RETURN_PROCESSING` | [Get Returns](https://documentation.fynd.com/konnect/channels/erp-wms/api-documentation/returns/get-returns) |
| Update AWB | PUT | `https://{{host}}/oms/v3/shipment/awb` | [Update AWB](https://documentation.fynd.com/konnect/channels/erp-wms/api-documentation/orders/put-update-awb) |
| Update Shipment Status | PUT | `https://{{host}}/oms/v3/shipment/status` | [Update Shipment Status](https://documentation.fynd.com/konnect/channels/erp-wms/api-documentation/orders/put-update-shipment-status) |
| Order Confirmation | POST | `/oms/v3/order/confirmation` | Konnect docs |
| Update Invoice | POST | `/oms/v3/order/invoice` | [Update Invoice](https://documentation.fynd.com/konnect/channels/erp-wms/api-documentation/orders/post-update-invoice) |
| Customer Invoice | POST | `/oms/v3/order/customer-invoice` | [Customer Invoice](https://documentation.fynd.com/konnect/channels/erp-wms/api-documentation/orders/post-customer-invoice) |
| Order Dispatch | POST | `/oms/v3/order/dispatch` | [Order Dispatch](https://documentation.fynd.com/konnect/channels/erp-wms/api-documentation/orders/post-order-dispatch) |
| Order Pack | POST | `/oms/v3/order/pack` | [Order Pack](https://documentation.fynd.com/konnect/channels/erp-wms/api-documentation/orders/post-order-pack) |
| Update Return & QC | POST | `/oms/v3/return/qc` | [Update Return & QC](https://documentation.fynd.com/konnect/channels/erp-wms/api-documentation/returns/post-update-return-qc) |
| Credit Note | POST | `/oms/v3/return/credit-note` | [Credit Note](https://documentation.fynd.com/konnect/channels/erp-wms/api-documentation/returns/post-credit-note) |

**Headers:** `x-access-token` (required for all Konnect)

**Base URLs:**
- **Production:** `https://fyndkonnect.konnect.fynd.com` (or channel-specific)
- **Sandbox/UAT:** `https://fyndkonnect.konnect.uat.fyndx1.de`

---

### 10.3 Platform Order APIs

| API | Method | Path | Doc |
|-----|--------|------|-----|
| Create Order | POST | `/service/platform/order/v1.0/company/{company_id}/orders` | [Platform Order](https://docs.fynd.com/partners/commerce/sdk/latest/platform/company/order) |
| List Orders | GET | `/service/platform/order/v1.0/company/{company_id}/orders-listing` | [Platform Order](https://docs.fynd.com/partners/commerce/sdk/latest/platform/company/order) |
| List Shipments | GET | `/service/platform/order/v1.0/company/{company_id}/shipments-listing` | [Platform Order](https://docs.fynd.com/partners/commerce/sdk/latest/platform/company/order) |
| Order Details | GET | `/service/platform/order/v1.0/company/{company_id}/order-details?order_id={order_id}` | [Platform Order](https://docs.fynd.com/partners/commerce/sdk/latest/platform/company/order) |
| Update Shipment Status | PUT | `/service/platform/order-manage/v1.0/company/{company_id}/shipment/status-internal` | [Platform Order](https://docs.fynd.com/partners/commerce/sdk/latest/platform/company/order) |

**Headers:** `Authorization: Bearer {access_token}`

---

### 10.4 Courier Partner APIs (OMS)

| API | Method | Path | Doc |
|-----|--------|------|-----|
| Assign DP | POST | `company/{company_id}/shipment/{shipment_id}/courier-partner/assign` | [DP Change PDF](https://gofynd.atlassian.net/browse/FPCP-871) |
| Updates | POST | `company/{company_id}/shipment/{shipment_id}/courier-partner/updates` | [DP Change PDF](https://gofynd.atlassian.net/browse/FPCP-871) |
| Cancel | POST | `company/{company_id}/shipment/{shipment_id}/courier-partner/cancel` | [DP Change PDF](https://gofynd.atlassian.net/browse/FPCP-871) |
| Request (Manual) | POST | `company/{company_id}/shipment/{shipment_id}/courier-partner/request` | [DP Change PDF](https://gofynd.atlassian.net/browse/FPCP-871) |
| Preference | POST | `company/{company_id}/shipment/{shipment_id}/courier-partner/preference` | [DP Change PDF](https://gofynd.atlassian.net/browse/FPCP-871) |

**Mandatory keys (Assign):** `extension_id`, `scheme_id`, `courier_partner_name`, `shipper_name`, `delivery_awb_number`  
**Mandatory keys (Request):** `extension_id`, `scheme_id`, `courier_partner_name`, `shipper_name`, `qc_required` (for return)

---

### 10.5 Logistics Extension APIs

| API | Method | Doc |
|-----|--------|-----|
| Create Scheme | POST | [createCourierPartnerScheme](https://docs.fynd.com/partners/commerce/sdk/latest/partner/logistics#createCourierPartnerScheme) |
| Update Scheme | PUT | [updateCourierPartnerScheme](https://docs.fynd.com/partners/commerce/sdk/latest/partner/logistics#updateCourierPartnerScheme) |
| Create Account | POST | [createCourierPartnerAccount](https://docs.fynd.com/partners/commerce/sdk/latest/partner/logistics#createCourierPartnerAccount) |
| Bulk Serviceability | POST | [bulkServiceability](https://docs.fynd.com/partners/commerce/sdk/latest/partner/logistics#bulkServiceability) |
| Sample Serviceability | GET | [sampleFileServiceability](https://docs.fynd.com/partners/commerce/sdk/latest/partner/logistics#sampleFileServiceability) |

**Reference:** [Logistics Extension API Guide](https://docs.fynd.com/partners/commerce/extension/logistics/api-guide/)

---

### 10.6 Webhooks

| Event | Topic | Doc |
|-------|-------|-----|
| Assign Shipment | `application/courier-partners/assign/v1` | [Webhook Payload](https://docs.fynd.com/partners/commerce/webhooks/latest/application#courier-partner) |
| Cancel Shipment | `application/courier-partners/cancel/v1` | [Webhook Payload](https://docs.fynd.com/partners/commerce/webhooks/latest/application#courier-partner) |
| Shipment Status | `shipment/update`, `shipment/data_update` | [Webhooks](https://docs.fynd.com/partners/commerce/webhooks/overview) |

---

## 11. Edge Cases & Negative Scenarios

### 11.1 DP Assignment Conflicts

| Scenario | Behavior | Mitigation |
|----------|----------|------------|
| **Extension + User both assign DP** | First request wins; second discarded | Extension must handle rejection; no race control on OMS |
| **DP operation in progress** | User must wait | Redis lock with TTL (e.g. 5 min); user retries after TTL |
| **Same DP assigned again** | Rejected | Validation on frontend and backend |

### 11.2 Order Creation

| Scenario | Behavior | Mitigation |
|----------|----------|------------|
| **Old create order API** | No self-ship + CP in payload | Use new create order API |
| **DP not serviceable at creation** | Order goes to **DP not assigned** | Auto fallback or manual DP selection |
| **DP becomes not serviceable later** | Auto fallback (if not manually updated) | If `dp_manually_updated = true`, no auto fallback |

### 11.3 Konnect / Extension

| Scenario | Behavior | Mitigation |
|----------|----------|------------|
| **extension_managed_cp = true** | No Stormbreaker call for dropdown | Use courier partners from create order payload |
| **Self-ship order without extension** | No auto hop to dp_assigned | Extension must assign via new API |
| **Missing `is_self_ship`** | Treated as non–self-ship | Ensure flag in order payload |

### 11.4 Returns

| Scenario | Behavior | Mitigation |
|----------|----------|------------|
| **Webhook before sync** | Return not found; ignored | Retry after admin approves/syncs |
| **Duplicate refund_done** | Idempotent; second ignored | No double refund |
| **No matching return** | Webhook returns 200, ignored | Log for debugging |
| **Manual return + refund_done** | Marks complete in app; no Shopify refund | Manual refund outside Shopify |

### 11.5 Marketplace-Managed Logistics

| Scenario | Behavior | Mitigation |
|----------|----------|------------|
| **Marketplace-managed** | No DP selection on Fynd | Skip DP UI/logic for such orders |
| **is_self_ship = false** | CP config irrelevant | Ignore |

### 11.6 LAPA Plan

| Scenario | Behavior | Mitigation |
|----------|----------|------------|
| **DP dropdown** | LAPA required | Frontend/backend validate LAPA before request |
| **Non-LAPA user** | Request rejected | Show message or disable dropdown |

### 11.7 Bulk & Limits

| Scenario | Behavior | Mitigation |
|----------|----------|------------|
| **Update AWB** | Max 20 shipments per request | Batch requests |
| **Cron polling** | Recommended intervals | [Best Practices](https://documentation.fynd.com/konnect/channels/erp-wms/best-practices/cron-timings) |

### 11.8 Authentication & Environment

| Scenario | Behavior | Mitigation |
|----------|----------|------------|
| **403 Forbidden** | Missing scopes | Add `company/orders/read`, `company/orders/write`, `company/settings` |
| **401 Unauthorized** | Invalid credentials | Verify Company ID, Client ID, Secret |
| **Wrong environment** | UAT vs Prod | Use correct base URL (`api.uat.fyndx1.de` vs `api.fynd.com`) |

### 11.9 Location & Channel

| Scenario | Behavior | Mitigation |
|----------|----------|------------|
| **Company auth + missing locationCode** | Fetch fails | Pass `locationCode` in Fetch Orders/Returns |
| **Unknown orderingChannel** | Filter may fail | Use supported values from docs |

### 11.10 Physical & Timing

| Scenario | Behavior | Mitigation |
|----------|----------|------------|
| **Update AWB before dispatch** | Not supported | Use Update AWB only after physical dispatch |
| **Multi-carrier hopping** | Not supported | Single AWB per shipment |
| **Partial AWB** | Not supported | Full AWB assignment |

---

## Appendix A: Quick Reference

### Order Status Flow (Self Ship)

```
CREATED → CONFIRMED → PROCESSING (dp_assigned) → bag_picked → delivery_done
```

### Return Status Flow (Self Ship)

```
return_initiated → return_dp_assigned → return_bag_in_transit → return_bag_delivered → return_accepted → credit_note
```

### Key Flags for Self Ship

| Flag | Location | Purpose |
|------|----------|---------|
| `is_self_ship` | Order/shipment | Identifies self-ship order |
| `extension_managed_cp` | cp_configuration | Extension manages DP |
| `dp_manually_updated` | Shipment | Disable auto reassignment |
| `autoDispatch` | Update AWB request | Skip to bag_picked on Fynd |

---

## Appendix B: Related JIRA / Figma

- **JIRA:** [FPCP-871](https://gofynd.atlassian.net/browse/FPCP-871), [FPCO-33881](https://gofynd.atlassian.net/browse/FPCO-33881)
- **Figma:** [OMS DP Change - File 2](https://www.figma.com/design/gvetvYVHYhUQ1G6saRHF9J/FP---OMS--File-2-?node-id=245-555399)
- **Partner Assignment Status:** [Quip Doc](https://gofynd.quip.com/OuDjAeCELmsK)

---

*Document generated from Fynd Platform, Konnect, and DP Change by Seller Engg Soln documentation.*
