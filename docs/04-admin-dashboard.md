# 04 — Admin Dashboard

> Real-time overview of return operations with interactive charts, metric cards, and actionable suggestions.

---

## Overview

The ReturnProMax admin dashboard (`/app`) is the primary landing page after authentication. It aggregates return data across configurable date ranges and presents KPIs, trends, and actionable suggestions to help merchants manage returns efficiently.

The dashboard is built with React Router (SSR loader) and Recharts for visualization.

---

## Date Range Controls

A date-range selector at the top of the dashboard lets merchants filter all metrics and charts to a specific time window.

### Preset Options

| Preset              | Description                             |
|---------------------|-----------------------------------------|
| `today`             | Current day (00:00 to 23:59)            |
| `yesterday`         | Previous day                            |
| `last_7_days`       | Rolling 7-day window                    |
| `current_week`      | Monday through today                    |
| `last_week`         | Previous Monday through Sunday          |
| `current_month`     | 1st of month through today              |
| `last_month`        | Full previous calendar month            |
| `last_30_days`      | Rolling 30-day window (default)         |
| `current_quarter`   | Start of quarter through today          |
| `last_quarter`      | Full previous calendar quarter          |
| `last_90_days`      | Rolling 90-day window                   |
| `all_time`          | All data since installation             |
| `custom`            | User-specified start and end dates      |

Custom ranges use `<input type="date">` pickers. Invalid ranges fall back to "Last 30 days".

Implementation: `app/lib/dashboard-date-utils.ts` (`parseDateRange`, `DATE_RANGE_OPTIONS`).

---

## Metric Cards

The dashboard renders summary cards at the top, each showing a headline number with contextual color and optional trend indicator.

### Primary Metrics

| Metric                  | Description                                                         |
|-------------------------|---------------------------------------------------------------------|
| **Total Returns**       | Count of all return cases in the selected range                     |
| **Pending Review**      | Returns with `status = "pending"` awaiting admin action             |
| **Approved**            | Returns with `status` in `["approved", "completed"]`               |
| **Rejected**            | Returns with `status = "rejected"`                                  |
| **Refunded**            | Approved returns where `refundStatus = "refunded"`                  |
| **Fynd Synced**         | Approved returns that have a Fynd return/shipment ID                |

### Financial Metrics

| Metric                  | Description                                                         |
|-------------------------|---------------------------------------------------------------------|
| **Revenue at Risk**     | Sum of `price * qty` for items in `initiated/pending/approved` returns (last 30 days) |
| **Revenue Retained**    | Sum of refund amounts for exchange/store-credit resolutions         |
| **Exchange Rate**       | Percentage of returns resolved via exchange                         |

### Operational Metrics

| Metric                     | Description                                                      |
|----------------------------|------------------------------------------------------------------|
| **Avg. Processing Days**   | Mean time from return creation to approval/completion             |
| **Overdue Returns**        | Pending/initiated returns older than 3 days                      |
| **Green Returns**          | Returns where `isGreenReturn = true` (customer keeps item)       |
| **Blocklist Entries**      | Number of active customer blocklist entries                      |
| **Period Change**          | Percentage change in total returns vs. the equivalent prior period|

---

## Charts

### Returns Over Time (Area Chart)

A Recharts `<AreaChart>` plots daily return volume over the selected date range.

- **X-axis**: Date labels formatted with `Intl.DateTimeFormat` using the shop locale.
- **Y-axis**: Return count per day.
- **Fill**: Gradient blue (`#3b82f6`).
- **Limit**: Up to 90 data points (days). Ranges longer than 90 days show the most recent 90 days.

### Status Distribution (Donut Chart)

A donut/pie visualization breaks down returns by status within the selected range.

| Status        | Color     |
|---------------|-----------|
| Pending       | `#d97706` |
| Processing    | `#3b82f6` |
| In Progress   | `#3b82f6` |
| Approved      | `#059669` |
| Completed     | `#1d4ed8` |
| Rejected      | `#dc2626` |
| Cancelled     | `#64748b` |
| Initiated     | `#f59e0b` |

Colors are sourced from `app/lib/status-colors.ts` (single source of truth).

### Resolution Type Distribution

A secondary donut chart shows the breakdown of resolution types:

| Resolution    | Color     |
|---------------|-----------|
| Refund        | `#8B5CF6` |
| Exchange      | `#3B82F6` |
| Store Credit  | `#14b8a6` |
| Replacement   | `#F59E0B` |

### Top Return Reasons

A ranked list (top 10) of the most common return reason codes, aggregated from `ReturnItem.reasonCode`.

---

## Status Colors Module

All status colors are defined in `app/lib/status-colors.ts`:

```typescript
import { getStatusColor, getStatusBg, STATUS_COLORS, STATUS_BG } from "~/lib/status-colors";

getStatusColor("pending");   // "#d97706"
getStatusBg("approved");     // "#ecfdf5"
```

### Exports

| Export            | Type                          | Purpose                              |
|-------------------|-------------------------------|--------------------------------------|
| `STATUS_COLORS`   | `Record<string, string>`      | Text/foreground color per status     |
| `STATUS_BG`       | `Record<string, string>`      | Background color per status          |
| `STATUS_LABELS`   | `Record<string, string>`      | Display label per status             |
| `getStatusColor`  | `(status: string) => string`  | Case-insensitive lookup, fallback `#64748b` |
| `getStatusBg`     | `(status: string) => string`  | Case-insensitive lookup, fallback `#f8fafc` |

---

## Actionable Suggestions

The dashboard computes up to 3 contextual suggestions based on current data:

| Condition                                    | Type      | Message                                            | Action Link              |
|----------------------------------------------|-----------|----------------------------------------------------|--------------------------|
| Pending returns > 0                          | `warning` | "N return(s) pending review"                       | `/app/returns?status=pending` |
| Fynd configured but unsynced approved returns| `warning` | "N approved return(s) not synced to Fynd"          | `/app/returns`           |
| Approved returns awaiting refund             | `info`    | "N approved return(s) awaiting refund"             | `/app/returns?status=approved` |
| Avg processing > 5 days (2+ approved)        | `warning` | "Average processing time is N days"                | `/app/returns?status=pending` |
| Top reason is "Other" (2+ returns)           | `info`    | "Many returns use 'Other' as reason"               | `/app/settings/return-settings` |

Suggestion cards are color-coded:
- `success` = green (`#ECFDF5` / `#A7F3D0`)
- `warning` = amber (`#FFFBEB` / `#FDE68A`)
- `info`    = blue  (`#EFF6FF` / `#BFDBFE`)

---

## Background Tasks

On each dashboard load the following background tasks are triggered (throttled):

1. **Fynd Retry Queue** (`fynd-retry.server.ts`): Retries failed Fynd syncs with exponential backoff.
2. **Fynd Status Polling** (`fynd-status-poll.server.ts`): Polls Fynd for stale return statuses.
3. **Session Cleanup**: Deletes expired `LookupSession` records older than 7 days.
4. **Webhook Log Cleanup**: Deletes `FyndWebhookLog` records older than 90 days.

---

## Recent Returns Feed

The dashboard shows the 8 most recent return cases with:

| Column        | Description                                      |
|---------------|--------------------------------------------------|
| Order Name    | Shopify order name (e.g., `#1001`)               |
| Customer      | Customer email (truncated)                       |
| Status        | Color-coded status badge                         |
| Resolution    | Resolution type (refund, exchange, store credit) |
| Items         | First 3 item titles with count                   |
| Date          | Relative time (e.g., "2 hours ago")              |

Each row links to the full return detail page at `/app/returns/{id}`.

---

## Data Loading

The dashboard loader (`app/routes/app._index.tsx`) performs 16+ parallel database queries to minimize load time:

```typescript
const [
  totalReturns, returnsByStatus, recentReturns, reasonAggregation,
  refundedCount, fyndSyncedCount, pendingCount, rejectedCount,
  allTimeReturns, approvedWithEvents, returnsForDaily, approvedNotRefundedCount,
  greenReturnCount, resolutionAgg, retainedCases, blocklistCount,
] = await Promise.all([...]);
```

Additional sequential queries:
- Revenue at risk (last 30 days)
- Period-over-period comparison
- Overdue returns count (>3 days pending)

### Performance

- All queries are scoped to the shop's `shopId` and date range.
- Daily chart data is capped at 90 points.
- Background tasks (retry, polling, cleanup) are throttled to prevent overhead.

---

## Error Handling

If the dashboard loader fails (database unavailable, etc.), it returns a safe fallback with all metrics zeroed and an error message displayed at the top of the page. The dashboard remains usable in this degraded state.

---

## Navigation Links

The dashboard provides quick links to other pages:

| Link                | Destination                  | Description                    |
|---------------------|------------------------------|--------------------------------|
| Full reports        | `/app/reports`               | Detailed analytics             |
| Review now          | `/app/returns?status=pending`| Pending returns list           |
| View returns        | `/app/returns`               | All returns list               |
| Settings            | `/app/settings/return-settings` | Return policy configuration |

---

## Related Files

| File | Purpose |
|------|---------|
| `app/routes/app._index.tsx` | Dashboard route (loader + component) |
| `app/lib/dashboard-date-utils.ts` | Date range parsing and preset definitions |
| `app/lib/status-colors.ts` | Status color constants |
| `app/routes/app.reports.tsx` | Full reports page (extended analytics) |
