# 11 — Automation Rules

> Auto-approve, auto-refund, green returns, return offers, blocklist, and product-level return policies.

---

## Overview

ReturnProMax provides a layered automation system that can handle return requests without manual intervention. Rules are evaluated in a specific priority order:

```
1. Blocklist check (highest priority — blocks submission)
2. Return eligibility check (product policies, window, region, price)
3. Auto-approve rules (global toggle or advanced rules)
4. Green returns (customer keeps item)
5. Auto-refund (triggered by Fynd webhook)
```

---

## Auto-Approve

### Global Auto-Approve

When `autoApproveEnabled = true`, **all** return requests are automatically approved immediately upon submission, bypassing the "pending" state.

**Settings:**

| Field                | Type      | Default | Description                    |
|----------------------|-----------|---------|--------------------------------|
| `autoApproveEnabled` | `Boolean` | `false` | Approve all returns instantly  |

### Advanced Auto-Approve Rules

For granular control, merchants can define conditional rules via `autoApproveRulesJson`. Rules are evaluated in order; the first matching rule's action is applied.

**Settings:**

| Field                  | Type       | Default | Description                              |
|------------------------|------------|---------|------------------------------------------|
| `autoApproveRulesJson` | `String?`  | `null`  | JSON array of `AutoApproveRule` objects   |

### Rule Schema

```typescript
type AutoApproveRule = {
  field: "orderValue" | "returnReason" | "productTag" | "customerReturnCount";
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "contains" | "not_contains";
  value: string;
  action: "approve" | "manual_review";
};
```

### Rule Fields

| Field                   | Type      | Description                                     | Valid Operators                                |
|-------------------------|-----------|-------------------------------------------------|------------------------------------------------|
| `orderValue`            | Numeric   | Total order value                               | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`         |
| `returnReason`          | String    | The return reason code selected by customer     | `eq`, `neq`, `contains`, `not_contains`        |
| `productTag`            | String    | Shopify product tags on the returned items      | `eq`, `neq`, `contains`, `not_contains`        |
| `customerReturnCount`   | Numeric   | Number of previous returns by this customer     | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`         |

### Rule Actions

| Action           | Behavior                                                    |
|------------------|-------------------------------------------------------------|
| `approve`        | Automatically approve the return                            |
| `manual_review`  | Force manual review (overrides global auto-approve)         |

### Evaluation Logic

```
For each rule in order:
  1. Extract the relevant value from the return context
  2. Compare using the specified operator
  3. If match: return the rule's action ("approve" or "manual_review")
  4. If no match: continue to next rule
If no rule matches: return null (use default behavior)
```

### Operator Behavior

**Numeric operators** (`orderValue`, `customerReturnCount`):

| Operator | Meaning                 |
|----------|-------------------------|
| `eq`     | Equals                  |
| `neq`    | Not equals              |
| `gt`     | Greater than            |
| `gte`    | Greater than or equal   |
| `lt`     | Less than               |
| `lte`    | Less than or equal      |

**String operators** (`returnReason`, `productTag`):

| Operator       | Meaning                                  |
|----------------|------------------------------------------|
| `eq`           | Exact match (case-insensitive)           |
| `neq`          | Does not match (case-insensitive)        |
| `contains`     | Contains substring (case-insensitive)    |
| `not_contains` | Does not contain substring               |

For `productTag`, operators check against **any** tag in the product's tag array.

### Example Rules

```json
[
  {
    "field": "orderValue",
    "operator": "lt",
    "value": "50",
    "action": "approve"
  },
  {
    "field": "customerReturnCount",
    "operator": "gt",
    "value": "5",
    "action": "manual_review"
  },
  {
    "field": "returnReason",
    "operator": "eq",
    "value": "wrong_size",
    "action": "approve"
  },
  {
    "field": "productTag",
    "operator": "contains",
    "value": "fragile",
    "action": "manual_review"
  }
]
```

This ruleset:
1. Auto-approves orders under $50
2. Flags frequent returners (>5 returns) for manual review
3. Auto-approves "wrong size" returns
4. Flags fragile items for manual review
5. All other returns: default behavior (pending or global auto-approve)

Implementation: `app/lib/auto-approve.server.ts`.

---

## Auto-Refund

Auto-refund is triggered by Fynd webhook events, not by admin action.

### Trigger

When `autoRefundEnabled = true` and a Fynd webhook reports one of these statuses:
- `credit_note_generated`
- `credit_note`

The system automatically:
1. Looks up the Shopify order
2. Calculates the refund amount
3. Calls the Shopify Refund API
4. Updates `refundStatus = "refunded"`
5. Sends refund notification (email + WhatsApp)

### Restrictions

The `allowedFyndStatusesForRefund` setting can further restrict auto-refund to only fire when the return's Fynd status matches an allowed value:

```json
["delivery_done", "handed_over_to_customer"]
```

---

## Green Returns

Green returns allow customers to keep their items while still receiving a refund. This reduces reverse logistics costs for low-value items.

### Settings

| Field                     | Type         | Default | Description                                    |
|---------------------------|--------------|---------|------------------------------------------------|
| `greenReturnsEnabled`     | `Boolean`    | `false` | Enable green returns                           |
| `greenReturnsThreshold`   | `Decimal?`   | `null`  | Price threshold: items below this qualify       |
| `greenReturnsProductTags` | `String?`    | `null`  | JSON array of product tags eligible for green returns |

### Eligibility Logic

An item qualifies for green return when:
1. `greenReturnsEnabled = true`
2. Item price is below `greenReturnsThreshold` (if set)
3. Item has a matching product tag (if `greenReturnsProductTags` is set)

When a return is marked as green:
- `ReturnCase.isGreenReturn = true`
- No shipping label is generated
- Customer is instructed to keep or donate the item
- Refund proceeds normally

---

## Return Offers

Return offers incentivize customers to keep their items by offering a discount instead of processing the return.

### Settings

| Field                 | Type       | Default | Description                                     |
|-----------------------|------------|---------|--------------------------------------------------|
| `returnOffersEnabled` | `Boolean`  | `false` | Enable return offer system                       |
| `returnOffersJson`    | `String?`  | `null`  | JSON configuration for offer rules               |

### Customer Experience

When enabled, after a customer selects items to return on the portal:
1. An offer card is displayed: "Special offer for you!"
2. Customer can choose "Accept Offer" or "Continue with Return"
3. If accepted: A discount code is generated and displayed
4. The return is not created; the customer keeps the item

---

## Customer Blocklist

The blocklist prevents known abusive customers from creating returns.

### Settings

| Field              | Type       | Default | Description                    |
|--------------------|------------|---------|--------------------------------|
| `blocklistEnabled` | `Boolean`  | `false` | Enable blocklist enforcement   |

### Blocklist Entry Types

| Type         | Description                       | Example                    |
|--------------|-----------------------------------|----------------------------|
| `email`      | Customer email address            | `abuser@example.com`       |
| `phone`      | Customer phone number             | `+911234567890`            |
| `order_name` | Specific Shopify order name       | `#1042`                    |
| `ip`         | IP address                        | `192.168.1.100`            |

### Schema

```prisma
model BlocklistEntry {
  id         String   @id @default(cuid())
  settingsId String
  type       String   // "email" | "phone" | "order_name" | "ip"
  value      String   // normalized value
  reason     String?
  blockedBy  String?  // admin who added the entry
  createdAt  DateTime @default(now())

  @@unique([settingsId, type, value])
}
```

When a customer attempts to create a return and their email, phone, order name, or IP matches an active blocklist entry, the request is rejected with a generic "not eligible" message (no indication of blocklist).

---

## Product Policies

Product-level policies override the global return window for specific products based on tags, product type, or collection.

### Schema

```typescript
type ProductPolicyRule = {
  id: string;
  matchType: "tags" | "product_type" | "collection";
  matchValue: string;       // comma-separated values for tags
  windowDays: number;       // 0 = not returnable
  policyText?: string;      // custom message shown to customer
  returnable: boolean;      // false = completely block returns
};
```

### Matching Logic

1. Rules are evaluated in order (first match wins).
2. `tags`: Matches if any of the comma-separated values match any product tag (case-insensitive).
3. `product_type`: Exact match on the Shopify product type (case-insensitive).
4. `collection`: Matches if the collection handle appears in the product's tags.

### Behavior When Matched

| `returnable` | `windowDays` | Behavior                                                  |
|--------------|--------------|-----------------------------------------------------------|
| `false`      | any          | Return blocked. Show `policyText` or default message.     |
| `true`       | > 0          | Use this window instead of global `returnWindowDays`.     |
| `true`       | 0            | Return allowed with no time restriction.                  |

When a product matches a policy, the global return window check is skipped entirely.

---

## Return Eligibility Checks

The `checkReturnEligibility()` function runs all eligibility checks in order:

```
1. Product-level policy (first match wins)
   → If not returnable: BLOCK
   → If returnable with custom window: check custom window
   → If no match: continue to global window
2. Global return window (returnWindowDays)
3. No-return period (noReturnPeriodEnabled + date range)
4. Minimum price (minimumReturnPrice)
5. Restricted product tags (restrictedProductTagsJson)
6. Restricted regions (restrictedRegionsJson)
```

Each check returns `{ eligible: boolean, reason?: string }`.

Implementation: `app/lib/return-rules.server.ts`.

---

## Related Files

| File                                    | Purpose                                  |
|-----------------------------------------|------------------------------------------|
| `app/lib/auto-approve.server.ts`        | Auto-approve rule engine                 |
| `app/lib/return-rules.server.ts`        | Return eligibility and policy checks     |
| `app/lib/fynd-webhook.server.ts`        | Auto-refund trigger from Fynd webhooks   |
| `app/routes/app.settings.auto-rules.tsx`| Admin UI for auto-approve rules          |
| `app/routes/app.settings.return-settings.tsx` | Return policy settings UI          |
| `prisma/schema.prisma`                  | BlocklistEntry, ShopSettings models      |
