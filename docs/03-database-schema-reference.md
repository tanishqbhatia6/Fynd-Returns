# Database Schema Reference

ReturnProMax uses PostgreSQL as its primary data store, managed through Prisma ORM. This document covers every model, field, relationship, and index defined in the schema.

**Prisma schema location:** `prisma/schema.prisma`

---

## Table of Contents

1. [Entity-Relationship Diagram](#entity-relationship-diagram)
2. [Session](#session)
3. [Shop](#shop)
4. [ShopSettings](#shopsettings)
5. [ReturnCase](#returncase)
6. [ReturnItem](#returnitem)
7. [ReturnEvent](#returnevent)
8. [FyndWebhookLog](#fyndwebhooklog)
9. [FyndOrderMapping](#fyndordermapping)
10. [LookupSession](#lookupsession)
11. [BlocklistEntry](#blocklistentry)
12. [NotificationLog](#notificationlog)
13. [ApiKey](#apikey)
14. [WebhookSubscription](#webhooksubscription)

---

## Entity-Relationship Diagram

```
+-------------------+          +-------------------+
|     Session       |          |  FyndWebhookLog   |
| (Shopify OAuth)   |          | (audit, no FK)    |
+-------------------+          +-------------------+

+-------------------+          +-------------------+
|  FyndOrderMapping |          |  NotificationLog  |
| (cache, no FK)    |          | (audit, no FK)    |
+-------------------+          +-------------------+

+-------------------+          +-------------------+
|   LookupSession   |          |                   |
| (portal auth)     |          |                   |
+-------------------+          +-------------------+

                    +----------+
                    |   Shop   |
                    +----------+
                    | id (PK)  |
                    | shopDomain (unique) |
                    +----+-----+
                         |
          +--------------+--------------+-----------------+
          |              |              |                  |
          v              v              v                  v
  +---------------+ +----------+ +-----------+ +-------------------+
  | ShopSettings  | | ApiKey   | | Webhook   | |   ReturnCase      |
  | (1:1)         | | (1:N)   | | Subscription| |   (1:N)          |
  +-------+-------+ +----------+ | (1:N)     | +--------+----------+
          |                       +-----------+          |
          v                                    +---------+---------+
  +----------------+                           |                   |
  | BlocklistEntry |                           v                   v
  | (1:N)          |                   +------------+     +-------------+
  +----------------+                   | ReturnItem |     | ReturnEvent |
                                       | (1:N)      |     | (1:N)       |
                                       +------------+     +-------------+
```

**Legend:**
- `1:1` -- One-to-one relationship (e.g., Shop has one ShopSettings)
- `1:N` -- One-to-many relationship (e.g., Shop has many ReturnCases)
- `PK` -- Primary key
- `FK` -- Foreign key (enforced with `onDelete: Cascade`)
- Models without FK arrows (Session, FyndWebhookLog, FyndOrderMapping, NotificationLog, LookupSession) are standalone or linked by application logic only

---

## Session

Shopify OAuth session storage. Managed automatically by `@shopify/shopify-app-session-storage-prisma`. Supports both online (user-scoped) and offline (shop-scoped) sessions.

| Field                | Type       | Nullable | Default       | Description                                      |
|----------------------|------------|----------|---------------|--------------------------------------------------|
| `id`                 | `String`   | No       | --            | Primary key. Shopify-assigned session ID.        |
| `shop`               | `String`   | No       | --            | Shopify shop domain (e.g., `store.myshopify.com`)|
| `state`              | `String`   | No       | --            | OAuth state parameter for CSRF protection        |
| `isOnline`           | `Boolean`  | No       | `false`       | `true` for online (user) sessions                |
| `scope`              | `String`   | Yes      | `null`        | Granted OAuth scopes (comma-separated)           |
| `expires`            | `DateTime` | Yes      | `null`        | Session expiry timestamp                         |
| `accessToken`        | `String`   | No       | --            | Shopify Admin API access token                   |
| `userId`             | `BigInt`   | Yes      | `null`        | Shopify user ID (online sessions only)           |
| `firstName`          | `String`   | Yes      | `null`        | User's first name                                |
| `lastName`           | `String`   | Yes      | `null`        | User's last name                                 |
| `email`              | `String`   | Yes      | `null`        | User's email address                             |
| `accountOwner`       | `Boolean`  | No       | `false`       | Whether user is the store owner                  |
| `locale`             | `String`   | Yes      | `null`        | User's locale preference                         |
| `collaborator`       | `Boolean`  | Yes      | `false`       | Whether user is a collaborator account           |
| `emailVerified`      | `Boolean`  | Yes      | `false`       | Whether the user's email is verified             |
| `refreshToken`       | `String`   | Yes      | `null`        | OAuth refresh token (expiring tokens flow)       |
| `refreshTokenExpires`| `DateTime` | Yes      | `null`        | Refresh token expiry timestamp                   |

**Indexes:** None (primary key lookup only).

---

## Shop

Top-level tenant entity. Each installed Shopify store is one `Shop` record. All other tenant-scoped data references this model.

| Field         | Type       | Nullable | Default  | Description                                      |
|---------------|------------|----------|----------|--------------------------------------------------|
| `id`          | `String`   | No       | `cuid()` | Primary key (CUID)                               |
| `shopDomain`  | `String`   | No       | --       | Shopify domain, unique. E.g., `store.myshopify.com` |
| `installedAt` | `DateTime` | No       | `now()`  | When the app was installed                       |
| `updatedAt`   | `DateTime` | No       | `@updatedAt` | Last modification timestamp (auto-managed)   |

**Relations:**

| Relation               | Target Model          | Cardinality | On Delete |
|------------------------|-----------------------|-------------|-----------|
| `settings`             | `ShopSettings`        | 1:1         | Cascade   |
| `returnCases`          | `ReturnCase[]`        | 1:N         | Cascade   |
| `apiKeys`              | `ApiKey[]`            | 1:N         | Cascade   |
| `webhookSubscriptions` | `WebhookSubscription[]`| 1:N        | Cascade   |

**Indexes:** `shopDomain` has a unique constraint.

---

## ShopSettings

Per-shop configuration. One-to-one with `Shop`. Contains 60+ fields covering return policies, Fynd integration, notifications, portal customization, refund methods, and feature toggles.

### Fynd Integration

| Field                  | Type      | Nullable | Default  | Description                                               |
|------------------------|-----------|----------|----------|-----------------------------------------------------------|
| `id`                   | `String`  | No       | `cuid()` | Primary key                                               |
| `shopId`               | `String`  | No       | --       | FK to `Shop.id` (unique, 1:1)                            |
| `fyndApiType`          | `String`  | Yes      | `null`   | `"platform"` or `"storefront"`                            |
| `fyndEnvironment`      | `String`  | Yes      | `null`   | `"uat"` or `"prod"`                                       |
| `fyndCustomBaseUrl`    | `String`  | Yes      | `null`   | Optional base URL override for Fynd API                   |
| `appMode`              | `String`  | Yes      | `null`   | `"dev"` or `"prod"` -- app operating mode                 |
| `fyndCompanyId`        | `String`  | Yes      | `null`   | Fynd company identifier                                   |
| `fyndApplicationId`    | `String`  | Yes      | `null`   | Fynd application identifier                               |
| `fyndCredentials`      | `String`  | Yes      | `null`   | AES-256-GCM encrypted Fynd API credentials                |
| `fyndConsolidateReturns`| `Boolean`| No       | `false`  | Batch multiple returns into one Fynd return                |
| `fyndConsolidateWindowHours`| `Int` | No       | `4`      | Hours to wait before sending batch (1, 4, 8, 24)          |

### Return Policy

| Field                        | Type       | Nullable | Default  | Description                                               |
|------------------------------|------------|----------|----------|-----------------------------------------------------------|
| `returnWindowDays`           | `Int`      | No       | `30`     | Days after fulfillment returns are accepted                |
| `returnReasonsJson`          | `String`   | Yes      | `null`   | JSON array of available return reason codes                |
| `returnReasonsByCategoryJson`| `String`   | Yes      | `null`   | JSON: reason codes organized by product category           |
| `returnPolicyText`           | `String`   | Yes      | `null`   | Free-text return policy displayed on portal                |
| `policyJson`                 | `String`   | Yes      | `null`   | Structured policy rules in JSON                            |
| `minimumReturnPrice`         | `Decimal(12,2)` | Yes | `null`   | Minimum item price eligible for return                     |
| `returnFeeAmount`            | `Decimal(12,2)` | Yes | `null`   | Deducted from refund for return shipping                   |
| `returnFeeCurrency`          | `String`   | Yes      | `null`   | Currency of the return fee                                 |
| `restrictedProductTagsJson`  | `String`   | Yes      | `null`   | JSON array of product tags ineligible for return           |
| `restrictedRegionsJson`      | `String`   | Yes      | `null`   | JSON array of regions where returns are blocked            |
| `noReturnPeriodEnabled`      | `Boolean`  | No       | `false`  | Enable blackout period for returns                         |
| `noReturnPeriodStart`        | `DateTime` | Yes      | `null`   | Blackout period start                                      |
| `noReturnPeriodEnd`          | `DateTime` | Yes      | `null`   | Blackout period end                                        |
| `productPoliciesJson`        | `String`   | Yes      | `null`   | JSON array of per-product/category policy overrides        |
| `photoRequired`              | `Boolean`  | No       | `false`  | Require photo upload with return submission                |
| `defaultReturnInstructions`  | `String`   | Yes      | `null`   | Instructions shown to customer after approval              |

### Fulfillment & Status Configuration

| Field                               | Type     | Nullable | Default  | Description                                              |
|--------------------------------------|----------|----------|----------|----------------------------------------------------------|
| `statusMappingJson`                  | `String` | Yes      | `null`   | JSON mapping of internal to display statuses              |
| `portalAllowedFulfillmentStatuses`   | `String` | Yes      | `null`   | JSON array of Shopify fulfillment statuses eligible for return |
| `allowedFyndStatusesForRefund`       | `String` | Yes      | `null`   | JSON array of Fynd statuses that permit refund creation   |

### Auto-Approve

| Field                  | Type      | Nullable | Default  | Description                                               |
|------------------------|-----------|----------|----------|-----------------------------------------------------------|
| `autoApproveEnabled`   | `Boolean` | No       | `false`  | Enable automatic approval of new returns                  |
| `autoRefundEnabled`    | `Boolean` | No       | `false`  | Auto-trigger Shopify refund on Fynd `credit_note_generated` |
| `autoApproveRulesJson` | `String`  | Yes      | `null`   | JSON array of conditional auto-approve rules              |

### Refund Configuration

| Field                   | Type      | Nullable | Default      | Description                                              |
|-------------------------|-----------|----------|--------------|----------------------------------------------------------|
| `refundLocationMode`    | `String`  | No       | `"auto"`     | `"auto"` uses fulfillment location; `"manual"` admin picks |
| `refundLocationId`      | `String`  | Yes      | `null`       | Shopify location GID fallback for auto mode              |
| `refundPaymentMethod`   | `String`  | No       | `"original"` | `"original"`, `"store_credit"`, or `"both"`              |
| `refundStoreCreditPct`  | `Int`     | Yes      | `100`        | % of refund as store credit when method is `"both"`      |
| `refundMethodPrepaidJson`| `String` | Yes      | `null`       | JSON refund method config for prepaid orders              |
| `refundMethodCODJson`   | `String`  | Yes      | `null`       | JSON refund method config for COD orders                 |

### Discount Code Refund

| Field                       | Type      | Nullable | Default    | Description                                           |
|-----------------------------|-----------|----------|------------|-------------------------------------------------------|
| `discountCodeRefundEnabled` | `Boolean` | No       | `false`    | Issue discount codes instead of monetary refunds      |
| `discountCodePrefix`        | `String`  | Yes      | `"RETURN"` | Prefix for generated discount codes                   |
| `discountCodeExpiryDays`    | `Int`     | No       | `90`       | Days until discount code expires                      |

### Bonus Credit & Green Returns

| Field                    | Type           | Nullable | Default  | Description                                           |
|--------------------------|----------------|----------|----------|-------------------------------------------------------|
| `bonusCreditEnabled`     | `Boolean`      | No       | `false`  | Enable bonus credit incentive                         |
| `bonusCreditPct`         | `Int`          | No       | `10`     | Extra % bonus for store credit / exchange             |
| `greenReturnsEnabled`    | `Boolean`      | No       | `false`  | Enable green returns (customer keeps item)            |
| `greenReturnsThreshold`  | `Decimal(12,2)`| Yes      | `null`   | Items below this value qualify for green return       |
| `greenReturnsProductTags`| `String`       | Yes      | `null`   | JSON array of product tags eligible for green returns |

### Return Offers

| Field                 | Type      | Nullable | Default  | Description                                           |
|-----------------------|-----------|----------|----------|-------------------------------------------------------|
| `returnOffersEnabled` | `Boolean` | No       | `false`  | Offer discounts to keep item instead of returning     |
| `returnOffersJson`    | `String`  | Yes      | `null`   | JSON array of offer rules                             |

### Portal Exchange

| Field                   | Type      | Nullable | Default  | Description                                           |
|-------------------------|-----------|----------|----------|-------------------------------------------------------|
| `portalExchangeEnabled` | `Boolean` | No       | `false`  | Allow customers to request exchange via portal        |

### Notification Settings

| Field                      | Type      | Nullable | Default  | Description                                          |
|----------------------------|-----------|----------|----------|------------------------------------------------------|
| `notificationToggles`      | `String`  | Yes      | `null`   | JSON toggle overrides for notification types         |
| `notificationNewReturn`    | `Boolean` | No       | `true`   | Send notification on new return                      |
| `notificationApproved`     | `Boolean` | No       | `true`   | Send notification on approval                        |
| `notificationRejected`     | `Boolean` | No       | `true`   | Send notification on rejection                       |
| `notificationRefunded`     | `Boolean` | No       | `true`   | Send notification on refund                          |
| `adminNotifyEmail`         | `String`  | Yes      | `null`   | Admin email for return notifications                 |
| `adminSoundEnabled`        | `Boolean` | No       | `true`   | Play sound on new return in admin dashboard          |

### SMTP Configuration

| Field            | Type      | Nullable | Default  | Description                                          |
|------------------|-----------|----------|----------|------------------------------------------------------|
| `smtpHost`       | `String`  | Yes      | `null`   | SMTP server hostname                                 |
| `smtpPort`       | `Int`     | Yes      | `587`    | SMTP server port                                     |
| `smtpUser`       | `String`  | Yes      | `null`   | SMTP username                                        |
| `smtpPass`       | `String`  | Yes      | `null`   | SMTP password                                        |
| `smtpFromEmail`  | `String`  | Yes      | `null`   | Sender email address                                 |
| `smtpFromName`   | `String`  | Yes      | `null`   | Sender display name                                  |
| `smtpSecure`     | `Boolean` | No       | `false`  | Use TLS for SMTP connection                          |

### WhatsApp / SMS

| Field                   | Type      | Nullable | Default  | Description                                          |
|-------------------------|-----------|----------|----------|------------------------------------------------------|
| `whatsappEnabled`       | `Boolean` | No       | `false`  | Enable WhatsApp notifications                        |
| `whatsappProvider`      | `String`  | Yes      | `null`   | `"meta_cloud"`, `"twilio"`, `"wati"`, `"interakt"`   |
| `whatsappApiKey`        | `String`  | Yes      | `null`   | WhatsApp provider API key                            |
| `whatsappPhoneNumberId` | `String`  | Yes      | `null`   | Meta Cloud phone number ID                           |
| `whatsappFromNumber`    | `String`  | Yes      | `null`   | Sender number (E.164 format)                         |

### Portal OTP

| Field                   | Type      | Nullable | Default  | Description                                          |
|-------------------------|-----------|----------|----------|------------------------------------------------------|
| `portalOtpEmailEnabled` | `Boolean` | No       | `false`  | Require OTP for email-based portal lookups           |
| `portalOtpSmsEnabled`   | `Boolean` | No       | `false`  | Require OTP for phone-based portal lookups           |

### Portal Customization

| Field              | Type      | Nullable | Default  | Description                                          |
|--------------------|-----------|----------|----------|------------------------------------------------------|
| `portalThemeJson`  | `String`  | Yes      | `null`   | JSON theme configuration (colors, fonts, layout)     |
| `portalConfigJson` | `String`  | Yes      | `null`   | JSON portal behavior configuration                   |
| `brandLogoUrl`     | `String`  | Yes      | `null`   | Base64 data URI or HTTPS URL for portal header logo  |
| `brandFaviconUrl`  | `String`  | Yes      | `null`   | Base64 data URI or HTTPS URL for portal favicon      |
| `portalLanguage`   | `String`  | No       | `"en"`   | Default portal language code                         |
| `portalLabelsJson` | `String`  | Yes      | `null`   | JSON `{ key: translatedLabel }` overrides            |
| `emailTemplatesJson`| `String` | Yes      | `null`   | JSON `{ eventType: { subject, bodyHtml } }` templates|

### Shop Locale

| Field           | Type     | Nullable | Default  | Description                                          |
|-----------------|----------|----------|----------|------------------------------------------------------|
| `shopLocale`    | `String` | Yes      | `"en"`   | Shop locale (auto-detected from Shopify)             |
| `shopCurrency`  | `String` | Yes      | `"USD"`  | Shop currency (auto-detected from Shopify)           |
| `shopTimezone`  | `String` | Yes      | `"UTC"`  | Shop timezone (auto-detected from Shopify)           |

### Blocklist & Permissions

| Field                  | Type      | Nullable | Default  | Description                                          |
|------------------------|-----------|----------|----------|------------------------------------------------------|
| `blocklistEnabled`     | `Boolean` | No       | `false`  | Enable customer blocklist feature                    |
| `readAllOrdersEnabled` | `Boolean` | No       | `false`  | Request `read_all_orders` scope from Shopify         |

### Timestamps

| Field       | Type       | Nullable | Default      | Description              |
|-------------|------------|----------|--------------|--------------------------|
| `createdAt` | `DateTime` | No       | `now()`      | Record creation time     |
| `updatedAt` | `DateTime` | No       | `@updatedAt` | Last modification time   |

**Relations:** `blocklist` -> `BlocklistEntry[]` (1:N, cascade delete).

---

## ReturnCase

The central domain entity. Each record represents one return request from a customer.

| Field                | Type           | Nullable | Default      | Description                                               |
|----------------------|----------------|----------|--------------|-----------------------------------------------------------|
| `id`                 | `String`       | No       | `cuid()`     | Primary key (CUID)                                        |
| `returnRequestNo`    | `String`       | Yes      | `null`       | Human-readable ID, e.g., `RPM-A1B2C3D4`                  |
| `shopId`             | `String`       | No       | --           | FK to `Shop.id`                                           |
| `shopifyOrderId`     | `String`       | No       | --           | Shopify order GID                                         |
| `shopifyOrderName`   | `String`       | No       | --           | Shopify order name (e.g., `#1001`)                        |
| `shopifyReturnId`    | `String`       | Yes      | `null`       | Shopify Return API ID (if native return created)          |
| `fyndReturnId`       | `String`       | Yes      | `null`       | Fynd return ID                                            |
| `fyndReturnNo`       | `String`       | Yes      | `null`       | Fynd return number                                        |
| `fyndOrderId`        | `String`       | Yes      | `null`       | Fynd affiliate_order_id (from order customAttributes)     |
| `fyndShipmentId`     | `String`       | Yes      | `null`       | Main shipment ID from Fynd                                |
| `fyndPayloadJson`    | `String`       | Yes      | `null`       | Full Fynd order/shipment payload (invoice, AWB, DP, etc.) |
| `fyndCurrentStatus`  | `String`       | Yes      | `null`       | Latest Fynd shipment status from webhook                  |
| `forwardAwb`         | `String`       | Yes      | `null`       | Forward (outbound) air waybill number                     |
| `returnAwb`          | `String`       | Yes      | `null`       | Return (reverse) air waybill number                       |
| `customerEmailNorm`  | `String`       | Yes      | `null`       | Normalized customer email (lowercase, trimmed)            |
| `customerPhoneNorm`  | `String`       | Yes      | `null`       | Normalized customer phone number                          |
| `customerName`       | `String`       | Yes      | `null`       | Customer full name                                        |
| `customerCity`       | `String`       | Yes      | `null`       | Customer city                                             |
| `customerCountry`    | `String`       | Yes      | `null`       | Customer country                                          |
| `customerAddress1`   | `String`       | Yes      | `null`       | Street address line 1 (for return pickup)                 |
| `customerAddress2`   | `String`       | Yes      | `null`       | Street address line 2 / apartment                         |
| `customerProvince`   | `String`       | Yes      | `null`       | State / province code                                     |
| `customerZip`        | `String`       | Yes      | `null`       | Postal code / ZIP / pincode                               |
| `customerLandmark`   | `String`       | Yes      | `null`       | Landmark (important for India logistics)                  |
| `status`             | `String`       | No       | --           | Return status (see Return Lifecycle doc)                  |
| `refundStatus`       | `String`       | Yes      | `null`       | Refund lifecycle status                                   |
| `refundJson`         | `String (Text)`| Yes      | `null`       | JSON: `{ refundId, amount, currency, createdAt, method }` |
| `adminNotes`         | `String`       | Yes      | `null`       | Internal admin notes (not visible to customer)            |
| `notesForCustomer`   | `String`       | Yes      | `null`       | Published notes visible to customer in portal             |
| `customerNotes`      | `String`       | Yes      | `null`       | Notes submitted by the customer                           |
| `customerMediaJson`  | `String (Text)`| Yes      | `null`       | JSON array of `{ name, mimeType, dataUrl }` uploads      |
| `rejectionReason`    | `String`       | Yes      | `null`       | Reason provided when rejecting the return                 |
| `resolutionType`     | `String`       | No       | `"refund"`   | `"refund"`, `"exchange"`, `"store_credit"`, `"replacement"` |
| `exchangeOrderId`    | `String`       | Yes      | `null`       | Shopify order ID for exchange order                       |
| `exchangeOrderName`  | `String`       | Yes      | `null`       | Shopify order name for exchange order                     |
| `exchangeItemsJson`  | `String (Text)`| Yes      | `null`       | JSON array of exchanged item details                      |
| `returnLabelUrl`     | `String`       | Yes      | `null`       | URL to return shipping label                              |
| `returnLabelJson`    | `String (Text)`| Yes      | `null`       | JSON: `{ carrier, trackingNumber, labelUrl, qrCodeUrl }`  |
| `isGreenReturn`      | `Boolean`      | No       | `false`      | Customer keeps item (green return)                        |
| `bonusCreditAmount`  | `String`       | Yes      | `null`       | Extra bonus credit applied                                |
| `discountCode`       | `String`       | Yes      | `null`       | Generated discount code for refund                        |
| `discountCodeValue`  | `String`       | Yes      | `null`       | Monetary value of the discount code                       |
| `currency`           | `String`       | Yes      | `null`       | ISO 4217 currency code (e.g., `"INR"`, `"USD"`)          |
| `orderProcessedAt`   | `DateTime`     | Yes      | `null`       | Original order processed date (deadline calculation)      |
| `exchangePreference` | `String (Text)`| Yes      | `null`       | Customer's free-text exchange request from portal         |
| `fyndSyncStatus`     | `String`       | Yes      | `null`       | Fynd sync state: `pending`, `synced`, `failed`, `retry_scheduled`, `processing`, `pending_consolidation` |
| `fyndSyncRetries`    | `Int`          | No       | `0`          | Number of Fynd sync retry attempts                        |
| `fyndSyncError`      | `String (Text)`| Yes      | `null`       | Last Fynd sync error message                              |
| `fyndSyncNextRetry`  | `DateTime`     | Yes      | `null`       | Scheduled time for next Fynd sync retry                   |
| `lastFyndStatusCheck`| `DateTime`     | Yes      | `null`       | Last time Fynd status was polled                          |
| `createdAt`          | `DateTime`     | No       | `now()`      | Record creation time                                      |
| `updatedAt`          | `DateTime`     | No       | `@updatedAt` | Last modification time                                    |

**Relations:**

| Relation | Target Model     | Cardinality | On Delete |
|----------|------------------|-------------|-----------|
| `shop`   | `Shop`           | N:1         | Cascade   |
| `items`  | `ReturnItem[]`   | 1:N         | Cascade   |
| `events` | `ReturnEvent[]`  | 1:N         | Cascade   |

**Indexes:**

| Fields                              | Type      |
|-------------------------------------|-----------|
| `(shopId, shopifyOrderName)`        | Composite |
| `(shopId, forwardAwb)`              | Composite |
| `(shopId, returnAwb)`               | Composite |
| `(shopId, fyndReturnId)`            | Composite |
| `(shopId, fyndShipmentId)`          | Composite |
| `(shopId, fyndOrderId)`             | Composite |
| `(shopId, returnRequestNo)`         | Composite |
| `(shopId, customerEmailNorm)`       | Composite |
| `(shopId, customerPhoneNorm)`       | Composite |
| `(fyndSyncStatus, fyndSyncNextRetry)` | Composite |

---

## ReturnItem

Individual product line items within a return case.

| Field               | Type       | Nullable | Default  | Description                                          |
|---------------------|------------|----------|----------|------------------------------------------------------|
| `id`                | `String`   | No       | `cuid()` | Primary key                                          |
| `returnCaseId`      | `String`   | No       | --       | FK to `ReturnCase.id`                                |
| `shopifyLineItemId` | `String`   | No       | --       | Shopify line item identifier                         |
| `title`             | `String`   | Yes      | `null`   | Product title                                        |
| `variantTitle`      | `String`   | Yes      | `null`   | Variant title (e.g., "Size L / Blue")                |
| `sku`               | `String`   | Yes      | `null`   | Stock keeping unit                                   |
| `price`             | `String`   | Yes      | `null`   | Unit price (string for precision)                    |
| `imageUrl`          | `String`   | Yes      | `null`   | Product image URL                                    |
| `qty`               | `Int`      | No       | `1`      | Quantity being returned                              |
| `reasonCode`        | `String`   | Yes      | `null`   | Return reason code                                   |
| `notes`             | `String`   | Yes      | `null`   | Customer notes for this specific item                |
| `condition`         | `String`   | Yes      | `null`   | `"unused"`, `"used_good"`, `"used_damaged"`, `"defective"` |
| `fyndShipmentId`    | `String`   | Yes      | `null`   | Fynd shipment ID for this item                       |
| `fyndBagId`         | `String`   | Yes      | `null`   | Fynd bag ID for this item                            |
| `createdAt`         | `DateTime` | No       | `now()`  | Record creation time                                 |

**Relations:** `returnCase` -> `ReturnCase` (N:1, cascade delete).

**Indexes:** `(returnCaseId)`.

---

## ReturnEvent

Immutable audit log of every action taken on a return case.

| Field          | Type       | Nullable | Default  | Description                                          |
|----------------|------------|----------|----------|------------------------------------------------------|
| `id`           | `String`   | No       | `cuid()` | Primary key                                          |
| `returnCaseId` | `String`   | No       | --       | FK to `ReturnCase.id`                                |
| `source`       | `String`   | No       | --       | Who performed the action: `"admin"`, `"customer"`, `"system"`, `"fynd"` |
| `eventType`    | `String`   | No       | --       | Event type, e.g., `initiated`, `auto_approved`, `status_updated`, `refund_issued`, `note_added`, `notes_for_customer_published` |
| `payloadJson`  | `String`   | Yes      | `null`   | JSON payload with event-specific details             |
| `happenedAt`   | `DateTime` | No       | `now()`  | When the event occurred                              |

**Relations:** `returnCase` -> `ReturnCase` (N:1, cascade delete).

**Indexes:** `(returnCaseId)`.

---

## FyndWebhookLog

Audit log for every inbound webhook received from Fynd. Not foreign-keyed to other models; stores denormalized data for debugging and traceability.

| Field              | Type           | Nullable | Default  | Description                                          |
|--------------------|----------------|----------|----------|------------------------------------------------------|
| `id`               | `String`       | No       | `cuid()` | Primary key                                          |
| `shipmentId`       | `String`       | Yes      | `null`   | Fynd shipment ID from payload                        |
| `orderId`          | `String`       | Yes      | `null`   | Fynd order ID from payload                           |
| `affiliateOrderId` | `String`       | Yes      | `null`   | Affiliate order ID from payload                      |
| `refundStatus`     | `String`       | Yes      | `null`   | Refund status from payload                           |
| `fyndStatus`       | `String`       | Yes      | `null`   | Fynd shipment status from payload                    |
| `eventType`        | `String`       | Yes      | `null`   | Webhook event type                                   |
| `action`           | `String`       | Yes      | `null`   | Action taken: `ignored`, `refund_in_progress`, `refund_completed`, `status_updated`, `error`, `duplicate_ignored` |
| `returnCaseId`     | `String`       | Yes      | `null`   | Matched ReturnCase ID (if found)                     |
| `carrier`          | `String`       | Yes      | `null`   | Logistics carrier name                               |
| `awbNumber`        | `String`       | Yes      | `null`   | AWB number from payload                              |
| `trackingUrl`      | `String (Text)`| Yes      | `null`   | Tracking URL from payload                            |
| `customerName`     | `String`       | Yes      | `null`   | Customer name from payload                           |
| `customerEmail`    | `String`       | Yes      | `null`   | Customer email from payload                          |
| `customerPhone`    | `String`       | Yes      | `null`   | Customer phone from payload                          |
| `shopDomain`       | `String`       | Yes      | `null`   | Shop domain that received the webhook                |
| `rawPayload`       | `String (Text)`| Yes      | `null`   | Full raw JSON payload                                |
| `error`            | `String (Text)`| Yes      | `null`   | Error message if processing failed                   |
| `createdAt`        | `DateTime`     | No       | `now()`  | Record creation time                                 |

**Indexes:** `(shipmentId)`, `(orderId)`, `(affiliateOrderId)`, `(returnCaseId)`, `(createdAt)`.

---

## FyndOrderMapping

Cache table mapping Shopify orders to Fynd order/shipment IDs. Avoids repeated Fynd API lookups.

| Field              | Type       | Nullable | Default      | Description                                          |
|--------------------|------------|----------|--------------|------------------------------------------------------|
| `id`               | `String`   | No       | `cuid()`     | Primary key                                          |
| `shopId`           | `String`   | No       | --           | Shop identifier                                      |
| `shopifyOrderName` | `String`   | No       | --           | Shopify order name (e.g., `#1001`)                   |
| `shopifyOrderId`   | `String`   | Yes      | `null`       | Shopify order GID                                    |
| `fyndOrderId`      | `String`   | Yes      | `null`       | Fynd order ID                                        |
| `fyndShipmentId`   | `String`   | Yes      | `null`       | Fynd shipment ID                                     |
| `searchStrategy`   | `String`   | Yes      | `null`       | Which lookup strategy found this mapping              |
| `createdAt`        | `DateTime` | No       | `now()`      | Record creation time                                 |
| `updatedAt`        | `DateTime` | No       | `@updatedAt` | Last modification time                               |

**Unique constraint:** `(shopId, shopifyOrderName)`.

**Indexes:** `(shopId, fyndOrderId)`, `(shopId, fyndShipmentId)`.

---

## LookupSession

Temporary sessions created during customer portal order lookups. Handles OTP verification flow and JWT token issuance.

| Field              | Type       | Nullable | Default  | Description                                          |
|--------------------|------------|----------|----------|------------------------------------------------------|
| `id`               | `String`   | No       | `cuid()` | Primary key                                          |
| `shopId`           | `String`   | No       | --       | Shop identifier                                      |
| `lookupType`       | `String`   | No       | --       | `"order_name"`, `"email"`, `"phone"`, `"return_no"`  |
| `lookupValueHash`  | `String`   | No       | --       | SHA-256 hash of the normalized lookup value          |
| `lookupValueNorm`  | `String`   | Yes      | `null`   | Normalized lookup value (optional, for debugging)    |
| `matchedReturnIds` | `String`   | Yes      | `null`   | Comma-separated matched return case IDs              |
| `otpTarget`        | `String`   | Yes      | `null`   | Email or phone the OTP was sent to                   |
| `otpSentAt`        | `DateTime` | Yes      | `null`   | When OTP was sent                                    |
| `verifiedAt`       | `DateTime` | Yes      | `null`   | When OTP was verified                                |
| `expiresAt`        | `DateTime` | No       | --       | Session expiry timestamp                             |
| `attemptsCount`    | `Int`      | No       | `0`      | Number of OTP verification attempts                  |
| `portalToken`      | `String`   | Yes      | `null`   | JWT issued after successful verification             |
| `createdAt`        | `DateTime` | No       | `now()`  | Record creation time                                 |

**Indexes:** `(shopId, lookupValueHash)`.

---

## BlocklistEntry

Individual entries in the per-shop customer blocklist.

| Field        | Type       | Nullable | Default  | Description                                          |
|--------------|------------|----------|----------|------------------------------------------------------|
| `id`         | `String`   | No       | `cuid()` | Primary key                                          |
| `settingsId` | `String`   | No       | --       | FK to `ShopSettings.id`                              |
| `type`       | `String`   | No       | --       | `"email"`, `"phone"`, `"order_name"`, `"ip"`         |
| `value`      | `String`   | No       | --       | Normalized blocked value                             |
| `reason`     | `String`   | Yes      | `null`   | Reason for blocking                                  |
| `blockedBy`  | `String`   | Yes      | `null`   | Admin who added the entry                            |
| `createdAt`  | `DateTime` | No       | `now()`  | Record creation time                                 |

**Relations:** `settings` -> `ShopSettings` (N:1, cascade delete).

**Unique constraint:** `(settingsId, type, value)`.

**Indexes:** `(settingsId, type)`.

---

## NotificationLog

Audit log of all notifications sent by the system.

| Field          | Type           | Nullable | Default  | Description                                          |
|----------------|----------------|----------|----------|------------------------------------------------------|
| `id`           | `String`       | No       | `cuid()` | Primary key                                          |
| `shopId`       | `String`       | No       | --       | Shop identifier                                      |
| `returnCaseId` | `String`       | Yes      | `null`   | Associated return case (if applicable)               |
| `channel`      | `String`       | No       | --       | `"email"`, `"whatsapp"`, `"sms"`                     |
| `recipient`    | `String`       | No       | --       | Recipient address (email, phone number)              |
| `eventType`    | `String`       | No       | --       | `"new_return"`, `"approved"`, `"rejected"`, `"refunded"`, `"otp"`, `"custom_note"` |
| `subject`      | `String`       | Yes      | `null`   | Email subject line (email channel only)              |
| `status`       | `String`       | No       | `"sent"` | Delivery status: `"sent"` or `"failed"`              |
| `error`        | `String (Text)`| Yes      | `null`   | Error message if delivery failed                     |
| `createdAt`    | `DateTime`     | No       | `now()`  | Record creation time                                 |

**Indexes:** `(shopId, createdAt)`, `(returnCaseId)`.

---

## ApiKey

API keys for programmatic access to the external REST API.

| Field        | Type       | Nullable | Default      | Description                                          |
|--------------|------------|----------|--------------|------------------------------------------------------|
| `id`         | `String`   | No       | `cuid()`     | Primary key                                          |
| `shopId`     | `String`   | No       | --           | FK to `Shop.id`                                      |
| `name`       | `String`   | No       | --           | Human-readable key name                              |
| `keyHash`    | `String`   | No       | --           | bcrypt hash of the full API key                      |
| `keyPrefix`  | `String`   | No       | --           | First 8 characters for identification (e.g., `rpm_a1b2`) |
| `permissions`| `String`   | No       | --           | JSON array: `["read_returns", "write_returns", "read_settings", "manage_webhooks"]` |
| `isActive`   | `Boolean`  | No       | `true`       | Whether key is active                                |
| `lastUsedAt` | `DateTime` | Yes      | `null`       | Last time key was used for authentication            |
| `revokedAt`  | `DateTime` | Yes      | `null`       | When key was revoked (soft delete)                   |
| `createdAt`  | `DateTime` | No       | `now()`      | Record creation time                                 |
| `updatedAt`  | `DateTime` | No       | `@updatedAt` | Last modification time                               |

**Relations:** `shop` -> `Shop` (N:1, cascade delete).

**Indexes:** `(shopId)`, `(keyPrefix)`.

---

## WebhookSubscription

Registered endpoints for outbound webhook event delivery.

| Field       | Type       | Nullable | Default      | Description                                          |
|-------------|------------|----------|--------------|------------------------------------------------------|
| `id`        | `String`   | No       | `cuid()`     | Primary key                                          |
| `shopId`    | `String`   | No       | --           | FK to `Shop.id`                                      |
| `url`       | `String`   | No       | --           | Destination URL for webhook delivery                 |
| `events`    | `String`   | No       | --           | JSON array of subscribed event types                 |
| `secret`    | `String`   | No       | --           | HMAC-SHA256 secret for payload signing               |
| `isActive`  | `Boolean`  | No       | `true`       | Whether subscription is active                       |
| `createdAt` | `DateTime` | No       | `now()`      | Record creation time                                 |
| `updatedAt` | `DateTime` | No       | `@updatedAt` | Last modification time                               |

**Available event types:** `return.created`, `return.approved`, `return.rejected`, `return.refunded`, `return.status_changed`.

**Relations:** `shop` -> `Shop` (N:1, cascade delete).

**Indexes:** `(shopId)`.

---

## Notes on Data Types

- **`String @db.Text`**: Used for fields that may exceed the default 255-character limit (e.g., JSON payloads, error messages, URLs). Maps to PostgreSQL `TEXT` type.
- **`Decimal @db.Decimal(12, 2)`**: Fixed-precision decimal for monetary values. 12 digits total, 2 decimal places. Avoids floating-point rounding errors.
- **`BigInt`**: Used for Shopify user IDs which may exceed JavaScript's `Number.MAX_SAFE_INTEGER`.
- **`cuid()`**: Collision-resistant unique identifiers. URL-safe, monotonically sortable.
- **`@updatedAt`**: Prisma auto-updates this field on every `update()` call.

---

*Last updated: 2026-03-12*
