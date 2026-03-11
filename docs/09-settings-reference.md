# 09 — Settings Reference

> Complete reference for all ShopSettings fields in ReturnProMax. Every field, its type, default value, and behavior.

---

## Overview

The `ShopSettings` model (`prisma/schema.prisma`) stores all per-shop configuration. Each Shopify store has exactly one `ShopSettings` record linked via the `Shop` model.

Settings are managed through the admin UI at:
- `/app/settings` -- General settings
- `/app/settings/return-settings` -- Return policies and rules
- `/app/settings/auto-rules` -- Advanced auto-approve rules
- `/app/settings/widget` -- Portal widget customization
- `/app/settings/setup` -- Fynd integration setup

---

## Field Count Summary

The `ShopSettings` model contains **65+ fields** organized into the following categories:

| Category                        | Field Count | Description                              |
|---------------------------------|-------------|------------------------------------------|
| Fynd Integration                | 7           | API credentials and connection settings  |
| Return Window & Eligibility     | 6           | Time windows and eligibility rules       |
| Return Reasons                  | 2           | Configurable reason lists                |
| Return Policy                   | 2           | Policy text and structured rules         |
| Product-Level Policies          | 1           | Per-product return rules                 |
| Restricted Products & Regions   | 2           | Tag and region blocklists                |
| Auto-Approve & Automation       | 2           | Automatic approval settings              |
| Refund Configuration            | 7           | Refund methods, locations, splits        |
| Fynd Refund Restrictions        | 1           | Status-based refund gating               |
| Fees & Charges                  | 2           | Return fees                              |
| Store Credit & Bonus            | 2           | Bonus credit incentives                  |
| Discount Code Refund            | 3           | Discount code generation                 |
| Green Returns                   | 3           | Keep-item return settings                |
| Return Offers & Incentives      | 2           | Offer-to-keep-item settings              |
| Portal Exchange                 | 1           | Exchange request toggle                  |
| Fulfillment Status Restrictions | 1           | Eligible fulfillment statuses            |
| Fynd Consolidation              | 2           | Batch return settings                    |
| Status Mapping                  | 1           | Custom status labels                     |
| Email Notifications             | 5           | Notification toggle switches             |
| SMTP Configuration              | 7           | Email server connection                  |
| Admin Notifications             | 2           | Admin alert settings                     |
| WhatsApp / SMS                  | 5           | WhatsApp provider and credentials        |
| Portal OTP Verification         | 2           | OTP requirement toggles                  |
| Customer Blocklist              | 1           | Blocklist enable/disable                 |
| Portal Customization            | 4           | Theme, config, branding                  |
| Portal Language & Labels        | 2           | i18n language and overrides              |
| Shop Locale & Formatting        | 3           | Auto-detected locale settings            |
| Email Templates                 | 1           | Custom email template overrides          |
| Return Instructions             | 1           | Post-approval instructions               |
| Order Access                    | 1           | Read all orders toggle                   |
| Timestamps                      | 2           | Created/updated timestamps               |

---

## Fynd Integration

Settings that control the Fynd Platform connection. See [08-fynd-integration.md](./08-fynd-integration.md) for detailed setup instructions.

| Field                   | Type       | Default  | Description                                                |
|-------------------------|------------|----------|------------------------------------------------------------|
| `fyndApiType`           | `String?`  | `null`   | API type: `"platform"` or `"storefront"`. Platform is required for return operations. |
| `fyndEnvironment`       | `String?`  | `null`   | Fynd environment: `"uat"` or `"prod"`.                     |
| `fyndCustomBaseUrl`     | `String?`  | `null`   | Optional override for the Fynd API base URL. Takes precedence over environment. |
| `appMode`               | `String?`  | `null`   | Application mode: `"dev"` or `"prod"`.                     |
| `fyndCompanyId`         | `String?`  | `null`   | Fynd Platform Company ID.                                  |
| `fyndApplicationId`     | `String?`  | `null`   | Fynd Platform Application (Sales Channel) ID.              |
| `fyndCredentials`       | `String?`  | `null`   | Encrypted JSON containing Platform client ID/secret and/or Storefront application token. Encrypted with AES using `ENCRYPTION_KEY`. |

### Credential JSON Structure

When decrypted, the credentials JSON has this structure:

```json
{
  "platform": {
    "clientId": "64a1b2c3d4e5f6a7b8c9d0e1",
    "clientSecret": "sk_live_abc123def456..."
  },
  "storefront": {
    "applicationToken": "app_tok_xyz..."
  }
}
```

The system also accepts legacy flat formats (`clientId`, `clientSecret` at the top level) and normalizes them automatically.

### Environment URLs

| `fyndEnvironment` | Resolved Base URL                |
|-------------------|----------------------------------|
| `"uat"`           | `https://api.fynd.com` (UAT)    |
| `"prod"`          | `https://api.fynd.com` (Prod)   |
| `null` + custom   | Value of `fyndCustomBaseUrl`     |

---

## Return Window & Eligibility

Settings that control when and how customers can submit returns.

| Field                       | Type         | Default  | Description                                                |
|-----------------------------|--------------|----------|------------------------------------------------------------|
| `returnWindowDays`          | `Int`        | `30`     | Number of days after order date within which returns are accepted. |
| `minimumReturnPrice`        | `Decimal?`   | `null`   | Minimum product price (in shop currency) required for return eligibility. Items below this price are blocked. |
| `noReturnPeriodEnabled`     | `Boolean`    | `false`  | Enable a blackout period during which returns are blocked (e.g., sale periods). |
| `noReturnPeriodStart`       | `DateTime?`  | `null`   | Start date of the no-return blackout period.               |
| `noReturnPeriodEnd`         | `DateTime?`  | `null`   | End date of the no-return blackout period.                 |
| `photoRequired`             | `Boolean`    | `false`  | Require customers to upload product images when creating a return. |

---

## Return Reasons

Settings for configuring available return reasons.

| Field                          | Type       | Default  | Description                                                |
|--------------------------------|------------|----------|------------------------------------------------------------|
| `returnReasonsJson`            | `String?`  | `null`   | JSON array of return reason strings. Example: `["Wrong size","Defective","Changed mind"]`. Shown in the portal dropdown. |
| `returnReasonsByCategoryJson`  | `String?`  | `null`   | JSON mapping of product categories/tags to specific return reasons. Allows different reasons for different product types. |

---

## Return Policy

| Field                | Type       | Default  | Description                                                |
|----------------------|------------|----------|------------------------------------------------------------|
| `policyJson`         | `String?`  | `null`   | JSON object containing structured return policy rules.     |
| `returnPolicyText`   | `String?`  | `null`   | Free-text return policy displayed on the customer portal.  |

---

## Product-Level Policies

| Field                  | Type       | Default  | Description                                                |
|------------------------|------------|----------|------------------------------------------------------------|
| `productPoliciesJson`  | `String?`  | `null`   | JSON array of product-specific return policy rules. Each rule contains: `id`, `matchType` (`tags`, `product_type`, `collection`), `matchValue`, `windowDays`, `policyText`, `returnable` (boolean). First matching rule wins. |

**Example:**

```json
[
  {
    "id": "policy-1",
    "matchType": "tags",
    "matchValue": "electronics,gadgets",
    "windowDays": 15,
    "returnable": true,
    "policyText": "Electronics must be returned within 15 days in original packaging."
  },
  {
    "id": "policy-2",
    "matchType": "product_type",
    "matchValue": "undergarments",
    "windowDays": 0,
    "returnable": false,
    "policyText": "This product category is not eligible for return."
  }
]
```

---

## Restricted Products & Regions

| Field                       | Type       | Default  | Description                                                |
|-----------------------------|------------|----------|------------------------------------------------------------|
| `restrictedProductTagsJson` | `String?`  | `null`   | JSON array of product tags that are blocked from returns. Items with any of these tags cannot be returned. |
| `restrictedRegionsJson`     | `String?`  | `null`   | JSON array of region objects `[{ country, province }]`. Customers from matching regions are blocked from creating returns. |

### Restricted Tags Example

```json
["final-sale", "non-returnable", "clearance"]
```

Any product with one of these Shopify tags will be rejected during eligibility checks. Matching is case-insensitive.

### Restricted Regions Example

```json
[
  { "country": "US", "province": "HI" },
  { "country": "US", "province": "AK" },
  { "country": "IN", "province": "" }
]
```

- If only `country` is set, all provinces in that country are blocked.
- If both `country` and `province` are set, only that specific province is blocked.
- Empty `province` or `country` acts as a wildcard for that dimension.

---

## Auto-Approve & Automation

| Field                  | Type       | Default  | Description                                                |
|------------------------|------------|----------|------------------------------------------------------------|
| `autoApproveEnabled`   | `Boolean`  | `false`  | Enable automatic approval of all return requests. When enabled, returns skip the "pending" state. |
| `autoApproveRulesJson` | `String?`  | `null`   | JSON array of advanced auto-approve rule objects. Each rule has: `field`, `operator`, `value`, `action`. Rules are evaluated in order; first match wins. See [11-automation-rules.md](./11-automation-rules.md). |

---

## Refund Configuration

| Field                     | Type       | Default      | Description                                                |
|---------------------------|------------|--------------|-----------------------------------------------------------|
| `autoRefundEnabled`       | `Boolean`  | `false`      | Automatically trigger Shopify refund when Fynd reports `credit_note_generated`. |
| `refundLocationMode`      | `String`   | `"auto"`     | `"auto"`: Use the order's fulfillment location. `"manual"`: Admin picks location in refund modal. |
| `refundLocationId`        | `String?`  | `null`       | Shopify location GID used as fallback when fulfillment location is unavailable (auto mode only). |
| `refundPaymentMethod`     | `String`   | `"original"` | Default refund method: `"original"` (original payment), `"store_credit"`, or `"both"` (split refund). |
| `refundStoreCreditPct`    | `Int?`     | `100`        | Percentage of refund issued as store credit when `refundPaymentMethod` is `"both"`. |
| `refundMethodPrepaidJson` | `String?`  | `null`       | JSON config for refund methods on prepaid orders.          |
| `refundMethodCODJson`     | `String?`  | `null`       | JSON config for refund methods on COD orders.              |

### Refund Payment Method Options

| Value           | Behavior                                                                |
|-----------------|-------------------------------------------------------------------------|
| `"original"`    | Refund to the original payment method (credit card, PayPal, etc.)       |
| `"store_credit"`| Issue the full refund as Shopify store credit (gift card)               |
| `"both"`        | Split refund: `refundStoreCreditPct`% as store credit, rest as original |

### Refund Location Mode

| Mode       | Behavior                                                                         |
|------------|----------------------------------------------------------------------------------|
| `"auto"`   | Automatically use the fulfillment location from the Shopify order. Falls back to `refundLocationId` if unavailable. |
| `"manual"` | Admin must select a restock location in the refund modal for each return.        |

### Prepaid vs. COD Refund Methods

For markets with both prepaid and COD orders, separate refund method configurations can be set:

```json
// refundMethodPrepaidJson
{
  "methods": ["original", "store_credit"],
  "default": "original"
}

// refundMethodCODJson
{
  "methods": ["store_credit", "bank_transfer"],
  "default": "store_credit"
}
```

---

## Fynd Refund Restrictions

| Field                           | Type       | Default  | Description                                                |
|---------------------------------|------------|----------|------------------------------------------------------------|
| `allowedFyndStatusesForRefund`  | `String?`  | `null`   | JSON array of Fynd statuses that allow refund. Example: `["delivery_done","handed_over_to_customer"]`. Empty/null disables the restriction. |

---

## Fees & Charges

| Field               | Type         | Default  | Description                                                |
|---------------------|--------------|----------|------------------------------------------------------------|
| `returnFeeAmount`   | `Decimal?`   | `null`   | Flat fee charged per return (deducted from refund amount). |
| `returnFeeCurrency` | `String?`    | `null`   | ISO 4217 currency code for the return fee. Defaults to shop currency. |

---

## Store Credit & Bonus

| Field                | Type       | Default  | Description                                                |
|----------------------|------------|----------|------------------------------------------------------------|
| `bonusCreditEnabled` | `Boolean`  | `false`  | Enable bonus credit incentive: offer extra credit when customer chooses store credit or exchange. |
| `bonusCreditPct`     | `Int`      | `10`     | Percentage of extra bonus credit (e.g., 10 means customer gets 110% of refund value as store credit). |

---

## Discount Code Refund

| Field                       | Type       | Default     | Description                                                |
|-----------------------------|------------|-------------|------------------------------------------------------------|
| `discountCodeRefundEnabled` | `Boolean`  | `false`     | Enable refund via auto-generated Shopify discount codes.   |
| `discountCodePrefix`        | `String?`  | `"RETURN"`  | Prefix for generated discount codes (e.g., `RETURN-A1B2C3`). |
| `discountCodeExpiryDays`    | `Int`      | `90`        | Number of days before the discount code expires.           |

---

## Green Returns

| Field                      | Type         | Default  | Description                                                |
|----------------------------|--------------|----------|------------------------------------------------------------|
| `greenReturnsEnabled`      | `Boolean`    | `false`  | Enable green returns: customer keeps the item and receives a refund for low-value items. |
| `greenReturnsThreshold`    | `Decimal?`   | `null`   | Items priced below this value qualify for green returns.   |
| `greenReturnsProductTags`  | `String?`    | `null`   | JSON array of product tags eligible for green returns. Only items with matching tags qualify. |

---

## Return Offers & Incentives

| Field                  | Type       | Default  | Description                                                |
|------------------------|------------|----------|------------------------------------------------------------|
| `returnOffersEnabled`  | `Boolean`  | `false`  | Enable return offers: show customers a discount to keep the item instead of returning. |
| `returnOffersJson`     | `String?`  | `null`   | JSON configuration for return offer rules (discount percentage, eligible products, messaging). |

---

## Portal Exchange

| Field                  | Type       | Default  | Description                                                |
|------------------------|------------|----------|------------------------------------------------------------|
| `portalExchangeEnabled`| `Boolean`  | `false`  | Allow customers to request an exchange directly on the portal. |

---

## Fulfillment Status Restrictions

| Field                              | Type       | Default  | Description                                                |
|------------------------------------|------------|----------|------------------------------------------------------------|
| `portalAllowedFulfillmentStatuses` | `String?`  | `null`   | JSON array of Shopify fulfillment statuses that are eligible for returns. Example: `["FULFILLED","PARTIALLY_FULFILLED"]`. Null means all statuses allowed. |

---

## Fynd Consolidation

| Field                        | Type       | Default  | Description                                                |
|------------------------------|------------|----------|------------------------------------------------------------|
| `fyndConsolidateReturns`     | `Boolean`  | `false`  | Batch multiple return cases into one Fynd return.          |
| `fyndConsolidateWindowHours` | `Int`      | `4`      | Hours to wait before sending the consolidated batch. Options: 1, 4, 8, 24. |

---

## Status Mapping

| Field                | Type       | Default  | Description                                                |
|----------------------|------------|----------|------------------------------------------------------------|
| `statusMappingJson`  | `String?`  | `null`   | JSON object mapping internal statuses to custom display labels. |

---

## Email Notifications

| Field                      | Type       | Default  | Description                                                |
|----------------------------|------------|----------|------------------------------------------------------------|
| `notificationNewReturn`    | `Boolean`  | `true`   | Send email when a new return is created.                   |
| `notificationApproved`     | `Boolean`  | `true`   | Send email when a return is approved.                      |
| `notificationRejected`     | `Boolean`  | `true`   | Send email when a return is rejected.                      |
| `notificationRefunded`     | `Boolean`  | `true`   | Send email when a refund is processed.                     |
| `notificationToggles`      | `String?`  | `null`   | JSON object for additional notification toggle overrides.  |

---

## SMTP Configuration

| Field            | Type       | Default  | Description                                                |
|------------------|------------|----------|------------------------------------------------------------|
| `smtpHost`       | `String?`  | `null`   | SMTP server hostname (e.g., `smtp.gmail.com`).             |
| `smtpPort`       | `Int?`     | `587`    | SMTP server port. Common values: 587 (STARTTLS), 465 (SSL), 25 (plain). |
| `smtpUser`       | `String?`  | `null`   | SMTP username (usually the email address).                 |
| `smtpPass`       | `String?`  | `null`   | SMTP password or app-specific password.                    |
| `smtpFromEmail`  | `String?`  | `null`   | "From" email address. Defaults to `smtpUser` if not set.   |
| `smtpFromName`   | `String?`  | `null`   | "From" display name. Defaults to `"Fynd Returns"`.         |
| `smtpSecure`     | `Boolean`  | `false`  | Use SSL/TLS for the SMTP connection (port 465). Set false for STARTTLS (port 587). |

---

## Admin Notifications

| Field               | Type       | Default  | Description                                                |
|---------------------|------------|----------|------------------------------------------------------------|
| `adminNotifyEmail`  | `String?`  | `null`   | Email address for admin notifications (new returns, alerts). |
| `adminSoundEnabled` | `Boolean`  | `true`   | Play a notification sound in the admin UI for new returns. |

---

## WhatsApp / SMS Notifications

| Field                  | Type       | Default  | Description                                                |
|------------------------|------------|----------|------------------------------------------------------------|
| `whatsappEnabled`      | `Boolean`  | `false`  | Enable WhatsApp notifications for return status updates.   |
| `whatsappProvider`     | `String?`  | `null`   | Provider: `"meta_cloud"`, `"twilio"`, `"wati"`, `"interakt"`. |
| `whatsappApiKey`       | `String?`  | `null`   | API key or access token for the WhatsApp provider.         |
| `whatsappPhoneNumberId`| `String?`  | `null`   | Meta Cloud API: Phone Number ID from Meta Business Manager. |
| `whatsappFromNumber`   | `String?`  | `null`   | Sender phone number in E.164 format (e.g., `"+911234567890"`). |

---

## Portal OTP Verification

| Field                  | Type       | Default  | Description                                                |
|------------------------|------------|----------|------------------------------------------------------------|
| `portalOtpEmailEnabled`| `Boolean`  | `false`  | Require OTP verification for email-based portal lookups.   |
| `portalOtpSmsEnabled`  | `Boolean`  | `false`  | Require OTP verification for phone-based portal lookups.   |

---

## Customer Blocklist

| Field              | Type       | Default  | Description                                                |
|--------------------|------------|----------|------------------------------------------------------------|
| `blocklistEnabled` | `Boolean`  | `false`  | Enable the customer blocklist. Blocked customers cannot create returns. |

Blocklist entries are stored in the `BlocklistEntry` model (linked via `settingsId`). Entry types: `email`, `phone`, `order_name`, `ip`.

---

## Portal Customization

| Field              | Type       | Default      | Description                                                |
|--------------------|------------|--------------|-----------------------------------------------------------|
| `portalThemeJson`  | `String?`  | `null`       | JSON theme configuration: colors, fonts, border radius, shadows. See [17-portal-customization.md](./17-portal-customization.md). |
| `portalConfigJson` | `String?`  | `null`       | JSON portal configuration: which tabs to show, default tab, media uploads toggle. |
| `brandLogoUrl`     | `String?`  | `null`       | Base64 data URI or HTTPS URL for the portal header logo.   |
| `brandFaviconUrl`  | `String?`  | `null`       | Base64 data URI or HTTPS URL for the portal favicon.       |

---

## Portal Language & Labels

| Field              | Type       | Default  | Description                                                |
|--------------------|------------|----------|------------------------------------------------------------|
| `portalLanguage`   | `String`   | `"en"`   | Portal UI language code. Supported: `en`, `es`, `fr`, `de`, `hi`, `ar`, `pt`, `ja`, `zh`, `ko`, `it`, `nl`, `ru`, `tr`, `th`. |
| `portalLabelsJson` | `String?`  | `null`   | JSON object of label key overrides. Merchant can override any of the ~120 i18n keys. |

---

## Shop Locale & Formatting

Auto-detected from Shopify and used for currency, date, and number formatting.

| Field            | Type       | Default  | Description                                                |
|------------------|------------|----------|------------------------------------------------------------|
| `shopLocale`     | `String?`  | `"en"`   | Shop locale (BCP 47 tag, e.g., `"en"`, `"hi"`, `"fr"`).   |
| `shopCurrency`   | `String?`  | `"USD"`  | ISO 4217 currency code (e.g., `"INR"`, `"EUR"`, `"USD"`).  |
| `shopTimezone`   | `String?`  | `"UTC"`  | IANA timezone (e.g., `"Asia/Kolkata"`, `"America/New_York"`). |

---

## Email Templates

| Field                | Type       | Default  | Description                                                |
|----------------------|------------|----------|------------------------------------------------------------|
| `emailTemplatesJson` | `String?`  | `null`   | JSON map of custom email templates by event type. Keys: `new_return`, `approved`, `rejected`, `refunded`. Each value has `subject` and `bodyHtml` with `{{variable}}` placeholders. |

### Email Template JSON Structure

```json
{
  "new_return": {
    "subject": "New return {{returnId}} for order {{orderName}}",
    "bodyHtml": "<h1>New Return Request</h1><p>Order: {{orderName}}</p><p>Customer: {{customerEmail}}</p>"
  },
  "approved": {
    "subject": "Your return for order {{orderName}} is approved",
    "bodyHtml": "<p>Great news! Your return request has been approved.</p>"
  },
  "rejected": {
    "subject": "Update on your return for order {{orderName}}",
    "bodyHtml": "<p>Unfortunately, your return was declined.</p><p>Reason: {{rejectionReason}}</p>"
  },
  "refunded": {
    "subject": "Refund processed for order {{orderName}}",
    "bodyHtml": "<p>Your refund of {{refundAmount}} has been processed.</p>"
  }
}
```

### Available Template Variables

| Variable              | Available In        | Description                                |
|-----------------------|---------------------|--------------------------------------------|
| `{{orderName}}`       | All                 | Shopify order name (e.g., `#1001`)         |
| `{{customerEmail}}`   | All                 | Customer email                             |
| `{{shopName}}`        | All                 | Shop display name                          |
| `{{returnId}}`        | All                 | Return request ID (e.g., `RPM-A1B2C3D4`)  |
| `{{status}}`          | All                 | Current return status                      |
| `{{refundAmount}}`    | `refunded`          | Formatted refund amount with currency      |
| `{{rejectionReason}}` | `rejected`          | Reason the return was declined             |

When a custom template is set for an event type, it completely replaces the built-in template for that event. If either `subject` or `bodyHtml` is missing, the built-in template is used instead.

---

## Return Instructions

| Field                        | Type       | Default  | Description                                                |
|------------------------------|------------|----------|------------------------------------------------------------|
| `defaultReturnInstructions`  | `String?`  | `null`   | Default instructions shown to the customer after return approval (e.g., shipping address, packaging guidelines). |

---

## Order Access

| Field                    | Type       | Default  | Description                                                |
|--------------------------|------------|----------|------------------------------------------------------------|
| `readAllOrdersEnabled`   | `Boolean`  | `false`  | When enabled, the app reads all orders (not just those in the return window) for order lookup and customer management features. |

---

## Timestamps

| Field       | Type       | Description                          |
|-------------|------------|--------------------------------------|
| `createdAt` | `DateTime` | Record creation timestamp.           |
| `updatedAt` | `DateTime` | Last update timestamp (auto-managed).|

---

## Return Case Fields Reference

For completeness, these are the key fields on the `ReturnCase` model that are influenced by settings:

| Field                | Influenced By Setting                          | Description                              |
|----------------------|------------------------------------------------|------------------------------------------|
| `status`             | `autoApproveEnabled`, `autoApproveRulesJson`   | Auto-approve can skip "pending" state    |
| `refundStatus`       | `autoRefundEnabled`, `allowedFyndStatusesForRefund` | Auto-refund from Fynd webhooks     |
| `resolutionType`     | `portalExchangeEnabled`, `refundPaymentMethod` | Available resolution options             |
| `isGreenReturn`      | `greenReturnsEnabled`, `greenReturnsThreshold` | Green return qualification               |
| `bonusCreditAmount`  | `bonusCreditEnabled`, `bonusCreditPct`         | Extra credit for exchanges               |
| `discountCode`       | `discountCodeRefundEnabled`, `discountCodePrefix` | Generated discount codes              |
| `fyndSyncStatus`     | `fyndConsolidateReturns`                       | Consolidation delays sync                |
| `currency`           | `shopCurrency`                                 | Inherited from shop                      |

---

## Settings JSON Field Schemas

### returnReasonsJson

```json
[
  "Wrong size",
  "Defective / damaged",
  "Not as described",
  "Changed my mind",
  "Received wrong item",
  "Quality not as expected",
  "Arrived too late",
  "Other"
]
```

### returnReasonsByCategoryJson

```json
{
  "electronics": ["Defective", "Not compatible", "Wrong item", "Other"],
  "clothing": ["Wrong size", "Wrong color", "Quality issue", "Other"],
  "default": ["Changed mind", "Not needed", "Other"]
}
```

### portalThemeJson

```json
{
  "primaryColor": "#008060",
  "primaryHoverColor": "#006e52",
  "backgroundColor": "#faf9f7",
  "surfaceColor": "#ffffff",
  "textColor": "#202223",
  "textMutedColor": "#6d7175",
  "borderColor": "#e1e3e5",
  "fontFamily": "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  "headingFont": "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  "borderRadius": "12px",
  "shadow": "0 4px 24px rgba(0,0,0,0.06)"
}
```

### portalConfigJson

```json
{
  "showOrderTracking": true,
  "showReturnTracking": true,
  "showCreateReturnTab": true,
  "defaultTab": "return",
  "allowMediaUploads": true
}
```

### statusMappingJson

```json
{
  "pending": "Under Review",
  "approved": "Return Accepted",
  "rejected": "Return Denied",
  "completed": "Closed",
  "processing": "In Progress"
}
```

### returnOffersJson

```json
[
  {
    "id": "offer-1",
    "discountPct": 15,
    "message": "Keep your item and get 15% off your next order!",
    "eligibleTags": ["clothing", "accessories"],
    "minOrderValue": 20
  }
]
```

### portalAllowedFulfillmentStatuses

```json
["FULFILLED", "PARTIALLY_FULFILLED"]
```

Valid Shopify fulfillment statuses: `FULFILLED`, `PARTIALLY_FULFILLED`, `UNFULFILLED`, `RESTOCKED`, `PENDING_FULFILLMENT`, `OPEN`, `IN_PROGRESS`, `ON_HOLD`, `SCHEDULED`.

### autoApproveRulesJson

```json
[
  { "field": "orderValue", "operator": "lt", "value": "50", "action": "approve" },
  { "field": "customerReturnCount", "operator": "gt", "value": "5", "action": "manual_review" },
  { "field": "returnReason", "operator": "eq", "value": "wrong_size", "action": "approve" }
]
```

### allowedFyndStatusesForRefund

```json
["delivery_done", "handed_over_to_customer", "return_bag_delivered", "return_accepted"]
```

### greenReturnsProductTags

```json
["small-item", "sample", "promotional"]
```

---

## Complete Alphabetical Field Index

| # | Field                              | Type         | Default       | Category              |
|---|------------------------------------|--------------|---------------|-----------------------|
| 1 | `adminNotifyEmail`                 | `String?`    | `null`        | Admin Notifications   |
| 2 | `adminSoundEnabled`                | `Boolean`    | `true`        | Admin Notifications   |
| 3 | `allowedFyndStatusesForRefund`     | `String?`    | `null`        | Fynd Refund           |
| 4 | `appMode`                          | `String?`    | `null`        | Fynd Integration      |
| 5 | `autoApproveEnabled`               | `Boolean`    | `false`       | Automation            |
| 6 | `autoApproveRulesJson`             | `String?`    | `null`        | Automation            |
| 7 | `autoRefundEnabled`                | `Boolean`    | `false`       | Refund                |
| 8 | `blocklistEnabled`                 | `Boolean`    | `false`       | Blocklist             |
| 9 | `bonusCreditEnabled`               | `Boolean`    | `false`       | Store Credit          |
| 10| `bonusCreditPct`                   | `Int`        | `10`          | Store Credit          |
| 11| `brandFaviconUrl`                  | `String?`    | `null`        | Portal                |
| 12| `brandLogoUrl`                     | `String?`    | `null`        | Portal                |
| 13| `defaultReturnInstructions`        | `String?`    | `null`        | Return Policy         |
| 14| `discountCodeExpiryDays`           | `Int`        | `90`          | Discount Code         |
| 15| `discountCodePrefix`               | `String?`    | `"RETURN"`    | Discount Code         |
| 16| `discountCodeRefundEnabled`        | `Boolean`    | `false`       | Discount Code         |
| 17| `emailTemplatesJson`               | `String?`    | `null`        | Email                 |
| 18| `fyndApplicationId`                | `String?`    | `null`        | Fynd Integration      |
| 19| `fyndCompanyId`                    | `String?`    | `null`        | Fynd Integration      |
| 20| `fyndConsolidateReturns`           | `Boolean`    | `false`       | Fynd Consolidation    |
| 21| `fyndConsolidateWindowHours`       | `Int`        | `4`           | Fynd Consolidation    |
| 22| `fyndCredentials`                  | `String?`    | `null`        | Fynd Integration      |
| 23| `fyndCustomBaseUrl`                | `String?`    | `null`        | Fynd Integration      |
| 24| `fyndEnvironment`                  | `String?`    | `null`        | Fynd Integration      |
| 25| `fyndApiType`                      | `String?`    | `null`        | Fynd Integration      |
| 26| `greenReturnsEnabled`              | `Boolean`    | `false`       | Green Returns         |
| 27| `greenReturnsProductTags`          | `String?`    | `null`        | Green Returns         |
| 28| `greenReturnsThreshold`            | `Decimal?`   | `null`        | Green Returns         |
| 29| `minimumReturnPrice`               | `Decimal?`   | `null`        | Eligibility           |
| 30| `noReturnPeriodEnabled`            | `Boolean`    | `false`       | Eligibility           |
| 31| `noReturnPeriodEnd`                | `DateTime?`  | `null`        | Eligibility           |
| 32| `noReturnPeriodStart`              | `DateTime?`  | `null`        | Eligibility           |
| 33| `notificationApproved`             | `Boolean`    | `true`        | Email Toggles         |
| 34| `notificationNewReturn`            | `Boolean`    | `true`        | Email Toggles         |
| 35| `notificationRefunded`             | `Boolean`    | `true`        | Email Toggles         |
| 36| `notificationRejected`             | `Boolean`    | `true`        | Email Toggles         |
| 37| `notificationToggles`              | `String?`    | `null`        | Email Toggles         |
| 38| `photoRequired`                    | `Boolean`    | `false`       | Eligibility           |
| 39| `policyJson`                       | `String?`    | `null`        | Return Policy         |
| 40| `portalAllowedFulfillmentStatuses` | `String?`    | `null`        | Fulfillment           |
| 41| `portalConfigJson`                 | `String?`    | `null`        | Portal                |
| 42| `portalExchangeEnabled`            | `Boolean`    | `false`       | Portal                |
| 43| `portalLabelsJson`                 | `String?`    | `null`        | Portal Language       |
| 44| `portalLanguage`                   | `String`     | `"en"`        | Portal Language       |
| 45| `portalOtpEmailEnabled`            | `Boolean`    | `false`       | Portal OTP            |
| 46| `portalOtpSmsEnabled`              | `Boolean`    | `false`       | Portal OTP            |
| 47| `portalThemeJson`                  | `String?`    | `null`        | Portal                |
| 48| `productPoliciesJson`              | `String?`    | `null`        | Product Policies      |
| 49| `readAllOrdersEnabled`             | `Boolean`    | `false`       | Order Access          |
| 50| `refundLocationId`                 | `String?`    | `null`        | Refund                |
| 51| `refundLocationMode`               | `String`     | `"auto"`      | Refund                |
| 52| `refundMethodCODJson`              | `String?`    | `null`        | Refund                |
| 53| `refundMethodPrepaidJson`          | `String?`    | `null`        | Refund                |
| 54| `refundPaymentMethod`              | `String`     | `"original"`  | Refund                |
| 55| `refundStoreCreditPct`             | `Int?`       | `100`         | Refund                |
| 56| `restrictedProductTagsJson`        | `String?`    | `null`        | Restrictions          |
| 57| `restrictedRegionsJson`            | `String?`    | `null`        | Restrictions          |
| 58| `returnFeeAmount`                  | `Decimal?`   | `null`        | Fees                  |
| 59| `returnFeeCurrency`                | `String?`    | `null`        | Fees                  |
| 60| `returnOffersEnabled`              | `Boolean`    | `false`       | Return Offers         |
| 61| `returnOffersJson`                 | `String?`    | `null`        | Return Offers         |
| 62| `returnPolicyText`                 | `String?`    | `null`        | Return Policy         |
| 63| `returnReasonsJson`                | `String?`    | `null`        | Return Reasons        |
| 64| `returnReasonsByCategoryJson`      | `String?`    | `null`        | Return Reasons        |
| 65| `returnWindowDays`                 | `Int`        | `30`          | Eligibility           |
| 66| `shopCurrency`                     | `String?`    | `"USD"`       | Shop Locale           |
| 67| `shopLocale`                       | `String?`    | `"en"`        | Shop Locale           |
| 68| `shopTimezone`                     | `String?`    | `"UTC"`       | Shop Locale           |
| 69| `smtpFromEmail`                    | `String?`    | `null`        | SMTP                  |
| 70| `smtpFromName`                     | `String?`    | `null`        | SMTP                  |
| 71| `smtpHost`                         | `String?`    | `null`        | SMTP                  |
| 72| `smtpPass`                         | `String?`    | `null`        | SMTP                  |
| 73| `smtpPort`                         | `Int?`       | `587`         | SMTP                  |
| 74| `smtpSecure`                       | `Boolean`    | `false`       | SMTP                  |
| 75| `smtpUser`                         | `String?`    | `null`        | SMTP                  |
| 76| `statusMappingJson`                | `String?`    | `null`        | Status Mapping        |
| 77| `whatsappApiKey`                   | `String?`    | `null`        | WhatsApp              |
| 78| `whatsappEnabled`                  | `Boolean`    | `false`       | WhatsApp              |
| 79| `whatsappFromNumber`               | `String?`    | `null`        | WhatsApp              |
| 80| `whatsappPhoneNumberId`            | `String?`    | `null`        | WhatsApp              |
| 81| `whatsappProvider`                 | `String?`    | `null`        | WhatsApp              |

---

## Related Files

| File                                     | Purpose                                  |
|------------------------------------------|------------------------------------------|
| `prisma/schema.prisma`                   | Database schema with all field definitions|
| `app/routes/app.settings._index.tsx`     | General settings UI                      |
| `app/routes/app.settings.return-settings.tsx` | Return policy settings UI           |
| `app/routes/app.settings.auto-rules.tsx` | Auto-approve rules UI                    |
| `app/routes/app.settings.widget.tsx`     | Portal widget settings UI                |
| `app/routes/app.settings.setup.tsx`      | Fynd integration setup UI                |
