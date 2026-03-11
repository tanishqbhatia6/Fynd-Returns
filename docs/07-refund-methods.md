# Refund Methods

## Overview

ReturnProMax supports multiple refund methods to accommodate different business models, payment types, and customer preferences. Refunds are processed through Shopify's Admin GraphQL API and can be configured globally or per payment type (prepaid vs. COD).

---

## Refund Method Configuration

Refund methods are configured at the shop level in `ShopSettings`:

| Setting                    | Type     | Default      | Description                                        |
|----------------------------|----------|--------------|----------------------------------------------------|
| `refundPaymentMethod`      | `string` | `"original"` | Default refund method: `original`, `store_credit`, `both` |
| `refundStoreCreditPct`     | `int`    | `100`        | Percentage as store credit when method is `both`   |
| `discountCodeRefundEnabled`| `boolean`| `false`      | Enable discount code as a refund method            |
| `discountCodePrefix`       | `string` | `"RETURN"`   | Prefix for generated discount codes                |
| `discountCodeExpiryDays`   | `int`    | `90`         | Days until discount code expires                   |
| `refundMethodPrepaidJson`  | `string` | `null`       | JSON override for prepaid orders                   |
| `refundMethodCODJson`      | `string` | `null`       | JSON override for COD orders                       |

### RefundMethodConfig Type

The refund method configuration passed to the refund engine:

```typescript
type RefundMethodConfig = {
  method: "original" | "store_credit" | "both" | "discount_code";
  storeCreditPct?: number;      // 0-100, used when method is "both"
  storeCreditAmount?: number;   // Exact amount for amount-based split
  originalAmount?: number;      // Exact amount for amount-based split
};
```

### RefundResult Type

The result returned from any refund operation:

```typescript
type RefundResult = {
  success: boolean;
  error?: string;
  refundId?: string;           // Shopify refund GID
  refundAmount?: string;       // Refunded amount as string
  refundCurrency?: string;     // ISO 4217 currency code
  refundCreatedAt?: string;    // ISO 8601 timestamp
  refundMethod?: string;       // Method that was used
  bonusAmount?: string;        // Bonus credit applied
};
```

---

## Original Payment Refund

The default refund method. Refunds are processed back to the customer's original payment method through Shopify's Refund API.

### How It Works

1. The system queries Shopify's `suggestedRefund` to determine the refundable amount and transaction details.
2. Suggested transactions (gateway, parent transaction ID, amount) are used to construct the refund.
3. Shopify creates the refund and returns the money to the customer's original payment instrument.

### Shopify GraphQL Flow

```
1. suggestRefund(orderId, refundLineItems)
   → Returns: amountSet, suggestedTransactions[]

2. refundCreate(input: { orderId, refundLineItems, transactions[] })
   → Returns: refund { id, totalRefundedSet, createdAt }
```

### Restocking Behavior

| Mode              | Setting                      | Behavior                                   |
|-------------------|------------------------------|--------------------------------------------|
| **Auto restock**  | `refundLocationMode: "auto"` | Uses the order's fulfillment location      |
| **Manual select** | `refundLocationMode: "manual"` | Admin selects location in the refund modal |
| **Skip restock**  | `skipLocation: true`         | Items marked `NO_RESTOCK`                  |

If no location is specified and the mode is `auto`, the system fetches the shop's primary location via `fetchPrimaryLocationId()`.

### Error Scenarios

| Error Pattern                               | Enriched Message                                                   |
|---------------------------------------------|--------------------------------------------------------------------|
| `no transactions` / `transactions empty`    | Suggests using store credit or discount code (likely COD order)    |
| `customer not found` / `store_credit`       | Suggests discount code method (customer needs Shopify account)     |
| `already been refunded`                     | Directs admin to check Shopify Admin for order status              |
| `location` / `restock`                      | Suggests trying different location or disabling restocking         |
| `gift card` / `store_credit amount`         | Suggests discount code method for gift card orders                 |

---

## Store Credit Refund (Gift Card)

Issues the refund as Shopify store credit, which creates a gift card associated with the customer's account.

### How It Works

1. The system queries `suggestedRefund` to determine the total refundable amount.
2. Instead of refunding to the original transaction, it creates a `storeCreditRefund` via the `refundMethods` input.
3. Shopify creates a gift card and associates it with the customer.

### Refund Input Structure

```typescript
{
  orderId: "gid://shopify/Order/12345",
  refundLineItems: [...],
  transactions: [],  // Empty: no original payment refund
  refundMethods: [{
    storeCreditRefund: {
      amount: { amount: "50.00", currencyCode: "INR" }
    }
  }]
}
```

### Prerequisites

- The customer must have a Shopify customer account.
- If the customer does not have an account, the refund will fail with an error suggesting the discount code method instead.

### With Bonus Credit

When bonus credit is enabled, the store credit amount is increased:

```
Store Credit = Refundable Amount + Bonus Amount
```

For example, if the refundable amount is $50.00 and the bonus is $5.00, the gift card is created for $55.00.

---

## Discount Code Refund

Generates a single-use Shopify discount code instead of processing a monetary refund. This is useful for COD orders, gift card orders, or when the merchant wants to retain revenue while offering credit.

### How It Works

1. The system queries `suggestedRefund` to determine the refund amount.
2. A unique discount code is generated with the format: `{PREFIX}-{RETURN_REQUEST_NO}`.
3. A Shopify discount code is created via the `discountCodeBasicCreate` GraphQL mutation.
4. The discount is configured as a one-time-use, fixed-amount discount applicable to all products.

### Code Generation

| Component       | Source                                              | Example            |
|-----------------|-----------------------------------------------------|--------------------|
| **Prefix**      | `discountCodePrefix` setting (default: `RETURN`)    | `RETURN`           |
| **Separator**   | Hyphen                                              | `-`                |
| **Suffix**      | Return request number (RPM-XXXXXXXX)                | `RPM-A1B2C3D4`     |
| **Full Code**   | Combined                                            | `RETURN-RPM-A1B2C3D4` |

### Discount Configuration

```typescript
{
  title: "Return refund RETURN-RPM-A1B2C3D4",
  code: "RETURN-RPM-A1B2C3D4",
  startsAt: "2026-03-12T00:00:00Z",       // Immediately active
  endsAt: "2026-06-10T00:00:00Z",         // 90 days from creation
  usageLimit: 1,                           // Single use only
  customerSelection: { all: true },        // Any customer can use it
  customerGets: {
    value: {
      discountAmount: {
        amount: "50.00",                   // Refund amount
        appliesOnEachItem: false           // Total order discount
      }
    },
    items: { all: true }                   // Applies to all products
  }
}
```

### DiscountCodeRefundResult Type

```typescript
type DiscountCodeRefundResult = {
  success: boolean;
  error?: string;
  discountCode?: string;       // The generated code
  discountValue?: string;      // Discount amount
  discountCurrency?: string;   // Currency code
};
```

### Settings

| Setting                      | Default    | Description                              |
|------------------------------|------------|------------------------------------------|
| `discountCodeRefundEnabled`  | `false`    | Must be enabled to use this method       |
| `discountCodePrefix`         | `"RETURN"` | Customizable prefix for codes            |
| `discountCodeExpiryDays`     | `90`       | Days until the code expires              |

---

## Split Refund

Splits the refund between the original payment method and store credit. This allows merchants to partially retain revenue while still providing customer value.

### Split Modes

#### Percentage-Based Split

The refund is divided by a percentage. The `storeCreditPct` value determines how much goes to store credit.

```
Store Credit Amount = Total Refund * (storeCreditPct / 100) + Bonus
Original Refund     = Total Refund - (Total Refund * storeCreditPct / 100)
```

**Example:** Total refund = $100, `storeCreditPct` = 60

| Component         | Amount |
|--------------------|--------|
| Store Credit       | $60.00 |
| Original Payment   | $40.00 |

**Request:**
```json
{
  "action": "process_refund",
  "refundMethod": "both",
  "storeCreditPct": 60
}
```

#### Amount-Based Split

Exact amounts are specified for each component.

**Request:**
```json
{
  "action": "process_refund",
  "refundMethod": "both",
  "splitMode": "amount",
  "splitScAmount": 65.00,
  "splitOrigAmount": 35.00
}
```

**Validation:** The sum of `splitScAmount` and `splitOrigAmount` must not exceed the Shopify-reported refundable amount. If it does, the refund fails with an error message showing both amounts.

### Split Refund Implementation

The split refund constructs a Shopify refund with both `transactions` (for the original payment portion) and `refundMethods` (for the store credit portion):

```typescript
// Original payment portion
refundInput.transactions = [{
  orderId: gid,
  kind: "REFUND",
  gateway: suggestedTransaction.gateway,
  amount: originalAmount.toFixed(2),
  parentId: suggestedTransaction.parentTransaction.id
}];

// Store credit portion
refundInput.refundMethods = [{
  storeCreditRefund: {
    amount: {
      amount: storeCreditAmount.toFixed(2),
      currencyCode: currency
    }
  }
}];
```

---

## Bonus Credit Incentive

Bonus credit rewards customers who accept store credit instead of an original payment refund. It adds an extra percentage on top of the refund amount.

### Configuration

| Setting              | Type      | Default | Description                                         |
|----------------------|-----------|---------|-----------------------------------------------------|
| `bonusCreditEnabled` | `boolean` | `false` | Enable bonus credit feature                         |
| `bonusCreditPct`     | `int`     | `10`    | Extra percentage bonus for store credit/exchange     |

### How It Works

When a refund is processed with `store_credit` or `both` method and bonus credit is enabled:

```
Bonus Amount   = Refundable Amount * (bonusCreditPct / 100)
Total Credit   = Refundable Amount + Bonus Amount
```

**Example:** Refundable amount = $100, `bonusCreditPct` = 10

| Component       | Amount  |
|-----------------|---------|
| Base Refund     | $100.00 |
| Bonus (10%)     | $10.00  |
| Total Credit    | $110.00 |

The bonus amount is:
- Added to the store credit gift card value.
- Stored in `bonusCreditAmount` on the `ReturnCase`.
- Included in the `RefundResult` as `bonusAmount`.
- Displayed to the customer in the refund notification email.

### Override at Action Time

The bonus amount can be overridden per refund via the `bonusAmount` parameter:

```json
{
  "action": "process_refund",
  "refundMethod": "store_credit",
  "bonusAmount": 15.00
}
```

---

## Green Returns (Keep Item + Refund)

Green returns allow customers to keep the item while still receiving a refund. This is economical for low-value items where reverse shipping costs exceed the product value.

### Configuration

| Setting                    | Type      | Default | Description                                   |
|----------------------------|-----------|---------|-----------------------------------------------|
| `greenReturnsEnabled`      | `boolean` | `false` | Enable green returns feature                  |
| `greenReturnsThreshold`    | `decimal` | `null`  | Price threshold: items below this qualify      |
| `greenReturnsProductTags`  | `string`  | `null`  | JSON array of product tags eligible for green  |

### How It Works

1. During return creation, the system checks if the item qualifies for green return:
   - Item price is below `greenReturnsThreshold`, OR
   - Item has a matching tag from `greenReturnsProductTags`.
2. If eligible, the return is flagged with `isGreenReturn: true`.
3. On approval, Fynd sync is skipped entirely (no reverse shipment needed).
4. Refund is processed normally through the chosen refund method.
5. The customer keeps the item.

### Impact on Workflow

| Standard Return                     | Green Return                          |
|-------------------------------------|---------------------------------------|
| Fynd return created on approval     | Fynd sync skipped                     |
| Reverse shipment assigned           | No shipment                           |
| Customer ships item back            | Customer keeps item                   |
| Refund after item received          | Refund processed immediately          |

---

## Per-Payment-Type Configuration

ReturnProMax supports different refund methods for prepaid and COD (Cash on Delivery) orders.

### Configuration Fields

| Setting                  | Type     | Description                                            |
|--------------------------|----------|--------------------------------------------------------|
| `refundMethodPrepaidJson`| `string` | JSON config for prepaid orders                         |
| `refundMethodCODJson`    | `string` | JSON config for COD orders                             |

### JSON Format

Each JSON field stores a `RefundMethodConfig` object:

```json
{
  "method": "original",
  "storeCreditPct": 100
}
```

**Prepaid orders** typically use `"original"` or `"both"` since there is a payment transaction to refund.

**COD orders** typically use `"store_credit"` or `"discount_code"` since there is no original payment transaction to reverse.

### Resolution Logic

When processing a refund, the system determines the refund method in this order of precedence:

1. **Action-level override:** If the admin specifies `refundMethod` in the action body, it takes priority.
2. **Payment-type config:** If the order is identified as COD and `refundMethodCODJson` is set, use that config. If prepaid and `refundMethodPrepaidJson` is set, use that config.
3. **Shop default:** Fall back to `refundPaymentMethod` from `ShopSettings`.

### Common Configurations

**Online payments (prepaid):**
```json
{
  "method": "original"
}
```

**Cash on delivery:**
```json
{
  "method": "discount_code"
}
```

**Split with 70% store credit:**
```json
{
  "method": "both",
  "storeCreditPct": 70
}
```

---

## Return Fees

Return fees allow merchants to deduct a processing or restocking fee from the refund.

### Configuration

| Setting             | Type      | Description                              |
|---------------------|-----------|------------------------------------------|
| `returnFeeAmount`   | `decimal` | Fee amount to deduct from refund         |
| `returnFeeCurrency` | `string`  | Currency code for the fee (e.g., `"USD"`)|

### How It Works

The return fee is retrieved via `getReturnFee(settings)`:

```typescript
function getReturnFee(settings: ShopSettings | null): {
  amount: number;
  currency: string;
} {
  if (!settings || settings.returnFeeAmount == null)
    return { amount: 0, currency: "USD" };
  return {
    amount: Number(settings.returnFeeAmount),
    currency: settings.returnFeeCurrency ?? "USD",
  };
}
```

The fee is:
- Displayed to the customer in the portal during return creation.
- Deducted from the refund amount before processing.
- Shown in the return detail page and refund notification.

---

## Refund Processing Summary

| Method           | Shopify API Used                  | Customer Receives                 | Best For                         |
|------------------|-----------------------------------|-----------------------------------|----------------------------------|
| **Original**     | `refundCreate` + transactions     | Money to original payment         | Standard prepaid orders          |
| **Store Credit** | `refundCreate` + refundMethods    | Shopify gift card                 | Customer retention               |
| **Discount Code**| `discountCodeBasicCreate`         | Single-use discount code          | COD orders, gift card orders     |
| **Split**        | `refundCreate` + both             | Partial original + partial credit | Balanced retention strategy      |
| **Green Return** | Any of the above                  | Refund + keeps item               | Low-value items                  |

### Refund Amount Calculation

For all methods, the refundable amount is determined by Shopify's `suggestedRefund` query:

```graphql
query suggestRefund($orderId: ID!, $refundLineItems: [RefundLineItemInput!]!) {
  order(id: $orderId) {
    suggestedRefund(refundLineItems: $refundLineItems) {
      amountSet { shopMoney { amount currencyCode } }
      subtotalSet { shopMoney { amount currencyCode } }
      suggestedTransactions {
        gateway
        parentTransaction { id }
        amountSet { shopMoney { amount currencyCode } }
        kind
      }
    }
  }
}
```

This ensures the refund amount accounts for:
- Previously refunded amounts
- Proportional tax and shipping adjustments
- Discount allocations
