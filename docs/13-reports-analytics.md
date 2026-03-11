# 13 — Reports & Analytics

> Advanced reporting and analytics for return operations, revenue impact, and product insights.

---

## Overview

The Reports page (`/app/reports`) extends the dashboard with deeper analytics, more chart types, and additional data dimensions. It shares the same date range controls and data infrastructure as the dashboard.

---

## Date Range Controls

Reports use the same date range system as the dashboard:

| Preset            | Description                                |
|-------------------|--------------------------------------------|
| Today             | Current day                                |
| Yesterday         | Previous day                               |
| Last 7 days       | Rolling 7-day window                       |
| Current week      | Monday through today                       |
| Last week         | Previous full week                         |
| Current month     | 1st through today                          |
| Last month        | Previous full calendar month               |
| Last 30 days      | Rolling 30-day window (default)            |
| Current quarter   | Start of quarter through today             |
| Last quarter      | Previous full quarter                      |
| Last 90 days      | Rolling 90-day window                      |
| All time          | Since installation                         |
| Custom            | User-specified start and end dates         |

---

## Charts and Visualizations

### Returns Over Time (Area Chart)

Daily return volume plotted as a Recharts `<AreaChart>` with gradient fill. Locale-aware date formatting on the X-axis.

### Status Distribution (Pie Chart)

A `<PieChart>` with `<Cell>` elements color-coded by status using the `CHART_PALETTE`:

```
#3b82f6, #10b981, #f59e0b, #ef4444, #94a3b8, #8b5cf6, #06b6d4, #f43f5e
```

### Resolution Type Breakdown

Pie chart showing the distribution of resolution types:

| Resolution     | Color     |
|----------------|-----------|
| Refund         | `#8B5CF6` |
| Exchange       | `#3B82F6` |
| Store Credit   | `#14b8a6` |
| Replacement    | `#F59E0B` |

### Top Return Reasons

Ranked bar/list chart of the top 10 return reason codes by frequency.

### Top Products by Returns

The 10 most-returned products, aggregated from `ReturnItem.title`:

```sql
GROUP BY title
ORDER BY count DESC
LIMIT 10
```

### Customer Return Frequency

Distribution of how many returns each customer has submitted, identifying repeat returners.

---

## Key Metrics

### Volume Metrics

| Metric                | Description                                    |
|-----------------------|------------------------------------------------|
| Total Returns         | Count in selected range                        |
| Total Items           | Sum of `ReturnItem` quantities                 |
| All-Time Returns      | Total across all time                          |
| Pending Count         | Returns awaiting review                        |
| Approved Count        | Approved + completed returns                   |
| Rejected Count        | Rejected returns                               |
| Refunded Count        | Returns with completed refunds                 |
| Fynd Synced Count     | Returns synced to Fynd Platform                |

### Processing Metrics

| Metric                    | Description                                      |
|---------------------------|--------------------------------------------------|
| Avg. Processing Days      | Mean time from creation to approval              |
| Approved Not Refunded     | Approved returns still awaiting refund           |

### Financial Metrics

| Metric                | Description                                          |
|-----------------------|------------------------------------------------------|
| Revenue Retained      | Refund amount diverted to exchange/store credit      |
| Green Return Count    | Returns where customer keeps the item                |

### Revenue Analytics

The reports page performs additional revenue analysis:

| Analysis                | Data Source                                      |
|-------------------------|--------------------------------------------------|
| Total Refund Value      | Sum of `refundJson.amount` for approved/completed cases |
| Currency Distribution   | Group refund amounts by currency                  |

---

## Data Export

### CSV Export

Returns can be exported as CSV via the admin API:

```
GET /api/returns/export?status=approved&from=2026-01-01&to=2026-03-31&format=csv
```

The CSV includes all return case fields, item details, and refund information.

### Exported Fields

| Field              | Description                    |
|--------------------|--------------------------------|
| Return Request No  | RPM-XXXXXXXX identifier        |
| Order Name         | Shopify order name             |
| Customer Name      | Customer full name             |
| Customer Email     | Customer email address         |
| Status             | Current return status          |
| Resolution Type    | refund/exchange/store_credit   |
| Refund Amount      | Amount refunded (if any)       |
| Currency           | Order currency                 |
| Item Titles        | Comma-separated item names     |
| Item Count         | Number of items in return      |
| Fynd Sync Status   | Fynd synchronization state     |
| Created At         | Return submission date         |
| Updated At         | Last update date               |

---

## Suggestions Engine

The reports page inherits the dashboard's suggestion engine, which generates actionable recommendations:

| Condition                               | Suggestion                                    |
|-----------------------------------------|-----------------------------------------------|
| Pending returns exist                   | "N returns pending review"                    |
| Approved returns not synced to Fynd     | "N returns not synced to Fynd"                |
| Approved returns awaiting refund        | "N returns awaiting refund"                   |
| Avg processing > 5 days                 | "Average processing time is N days"           |
| Top reason is "Other"                   | "Many returns use 'Other' -- add specific reasons" |

---

## Performance Considerations

- All queries use date range filters to limit data scanned.
- Daily data is capped at 90 data points for chart rendering.
- Customer return frequency uses `groupBy` aggregation (not N+1 queries).
- Top products aggregation is limited to 10 results.

---

## Related Files

| File                              | Purpose                                     |
|-----------------------------------|---------------------------------------------|
| `app/routes/app.reports.tsx`      | Reports page (loader + component)           |
| `app/routes/app._index.tsx`       | Dashboard (shares data infrastructure)      |
| `app/lib/dashboard-date-utils.ts` | Date range parsing                          |
| `app/lib/status-colors.ts`        | Chart color definitions                     |
| `app/routes/api.returns.export.ts`| CSV export endpoint                         |
