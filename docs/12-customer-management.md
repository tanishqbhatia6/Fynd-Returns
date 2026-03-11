# 12 — Customer Management

> Customer profiles, return history, risk scoring, and blocklist management.

---

## Overview

The Customer Management page (`/app/customers`) provides a centralized view of all customers who have submitted returns, enriched with Shopify order data for a complete picture of customer behavior.

---

## Customer Profiles

### Data Aggregation

Customer profiles are built by grouping return cases by normalized email address. For each customer, the system aggregates:

| Metric                | Source                                      | Description                              |
|-----------------------|---------------------------------------------|------------------------------------------|
| **Return Count**      | Count of `ReturnCase` records               | Total returns submitted                  |
| **Total Refund Amount**| Sum of `refundJson.amount`                 | Total refunds processed                  |
| **Total Item Count**  | Sum of `ReturnItem.qty`                     | Total items returned                     |
| **Status Breakdown**  | Group by `ReturnCase.status`                | Count per status (pending, approved, etc)|
| **Resolution Breakdown**| Group by `ReturnCase.resolutionType`      | Count per type (refund, exchange, etc)   |
| **First/Last Return** | Min/max `ReturnCase.createdAt`              | Date range of return activity            |

### Shopify Enrichment

Customer profiles are enriched with Shopify data via the Admin GraphQL API:

| Metric                 | Source                    | Description                              |
|------------------------|---------------------------|------------------------------------------|
| **Lifetime Order Count**| Shopify Customer API     | Total orders placed by this customer     |
| **Lifetime Spend**     | Shopify Customer API      | Total amount spent across all orders     |
| **Total Order Value**  | Shopify Order API         | Sum of order totals for return-related orders |

Shopify data is fetched in batches of 20 customers to avoid timeouts.

### Missing Data Backfill

When customer data is incomplete on return cases (missing name, city, country), the system automatically backfills from Shopify order data in the background.

---

## Search and Filtering

The customer list supports searching by:

| Field            | Match Type              |
|------------------|-------------------------|
| Customer email   | Partial, case-insensitive |
| Customer phone   | Partial, case-insensitive |
| Customer name    | Partial, case-insensitive |
| Order name       | Partial, case-insensitive |

### Sorting

| Sort Option      | Description                                |
|------------------|--------------------------------------------|
| `count`          | Sort by return count (most returns first)  |
| `amount`         | Sort by total refund amount (highest first)|
| `recent`         | Sort by most recent return date            |

---

## Customer Detail View

Clicking a customer row shows:

1. **Summary Card**: Name, email, phone, city, country, return count, total refund, currency.
2. **Return History Table**: All returns for this customer with:
   - Return request number
   - Order name
   - Status (with color badge)
   - Resolution type
   - Refund amount
   - Item count and titles
   - Green return indicator
   - Date
3. **Shopify Data**: Lifetime orders, lifetime spend (when available).

---

## Customer Blocklist

### Purpose

The blocklist prevents customers from creating new returns. This is useful for managing return fraud or abuse.

### Managing the Blocklist

Blocklist entries are managed in **Settings > Blocklist** when `blocklistEnabled = true`.

### Entry Types

| Type         | Value Format                | Example               |
|--------------|-----------------------------|-----------------------|
| `email`      | Email address (normalized)  | `abuser@example.com`  |
| `phone`      | Phone number (normalized)   | `+911234567890`       |
| `order_name` | Shopify order name          | `#1042`               |
| `ip`         | IP address                  | `192.168.1.100`       |

### Blocklist Fields

| Field       | Description                                    |
|-------------|------------------------------------------------|
| `type`      | Entry type (email, phone, order_name, ip)      |
| `value`     | Normalized identifier value                    |
| `reason`    | Optional reason for blocking                   |
| `blockedBy` | Admin who added the entry                      |
| `createdAt` | When the entry was created                     |

### Enforcement

When a customer attempts to create a return on the portal:
1. The system checks if their email, phone, order name, or IP matches any active blocklist entry.
2. If matched, the return is rejected with a generic "not eligible" message.
3. No indication is given that the customer is blocklisted (prevents gaming).

### Unique Constraint

Each combination of `settingsId + type + value` is unique. Attempting to add a duplicate entry is silently ignored.

---

## Return Rate Analysis

The customer management page surfaces repeat returners who may warrant attention:

- Customers are sorted by return count by default.
- High return counts relative to order counts may indicate abuse.
- Status breakdown shows if returns are being approved or rejected.
- Resolution breakdown shows preference for refund vs. exchange vs. store credit.

---

## Related Files

| File                                | Purpose                                   |
|-------------------------------------|-------------------------------------------|
| `app/routes/app.customers.tsx`      | Customer management page                  |
| `app/lib/shopify-admin.server.ts`   | Shopify customer/order data fetching      |
| `prisma/schema.prisma`             | BlocklistEntry, ReturnCase models          |
| `app/routes/app.settings.return-settings.tsx` | Blocklist settings UI           |
