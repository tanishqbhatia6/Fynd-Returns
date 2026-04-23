# Fynd Returns

**Shopify Returns Management with Fynd Logistics Integration**

[![CI](https://github.com/Farhankhan0128/returnpromax/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Farhankhan0128/returnpromax/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Farhankhan0128/returnpromax/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/Farhankhan0128/returnpromax/actions/workflows/codeql.yml)
[![codecov](https://codecov.io/gh/Farhankhan0128/returnpromax/branch/main/graph/badge.svg)](https://codecov.io/gh/Farhankhan0128/returnpromax)
[![License: MIT](https://img.shields.io/github/license/Farhankhan0128/returnpromax?color=blue)](LICENSE)
[![Node](https://img.shields.io/node/v/@shopify/shopify-app-react-router?color=43853D&label=node)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Tests](https://img.shields.io/badge/tests-720%20passing-brightgreen?logo=vitest&logoColor=white)](COVERAGE.md)
[![Coverage Plan](https://img.shields.io/badge/coverage-ratchet-blueviolet)](COVERAGE.md)
[![Dependabot](https://img.shields.io/badge/dependabot-enabled-025E8C?logo=dependabot&logoColor=white)](.github/dependabot.yml)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![GitHub last commit](https://img.shields.io/github/last-commit/Farhankhan0128/returnpromax)](https://github.com/Farhankhan0128/returnpromax/commits/main)
[![GitHub issues](https://img.shields.io/github/issues/Farhankhan0128/returnpromax)](https://github.com/Farhankhan0128/returnpromax/issues)
[![GitHub pull requests](https://img.shields.io/github/issues-pr/Farhankhan0128/returnpromax)](https://github.com/Farhankhan0128/returnpromax/pulls)
[![GitHub stars](https://img.shields.io/github/stars/Farhankhan0128/returnpromax?style=social)](https://github.com/Farhankhan0128/returnpromax/stargazers)

A full-featured returns management platform built for Shopify merchants. Handles the complete return lifecycle — from customer-initiated requests through admin approval, Fynd logistics sync, refund processing, and analytics — with full internationalization support for global commerce.

> **Quality & health**: Continuous integration runs typecheck, tests, coverage, build, and CodeQL security scanning on every push. See [COVERAGE.md](COVERAGE.md) for the coverage ratchet plan and [SECURITY.md](SECURITY.md) for the disclosure policy.

---

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| Framework | React Router v7 | ^7.13.0 |
| Shopify Integration | @shopify/shopify-app-react-router | ^1.1.1 |
| Shopify API | Admin GraphQL | 2025-10 |
| UI Components | Polaris Web Components | Latest |
| Database | PostgreSQL + Prisma | ^6.19.2 |
| Build | Vite | ^6 |
| Runtime | Node.js | >=22.12 |
| Charts | Recharts | ^3.7.0 |
| Email | Nodemailer | ^8.0.1 |
| Logistics | @gofynd/fynd-client-javascript | ^3.18.0 |

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env: DATABASE_URL, SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SCOPES, etc.

# 3. Run database migrations
npx prisma migrate dev

# 4. Start development server
npm run dev
```

See **[SETUP.md](./SETUP.md)** for detailed setup instructions.

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                   Shopify Admin UI                       │
│  Dashboard │ Returns │ Customers │ Reports │ Settings    │
└──────────────┬───────────────────────────────────────────┘
               │
    ┌──────────┴──────────┐
    │   React Router v7   │
    │   (Remix-compatible)│
    └──────────┬──────────┘
               │
  ┌────────────┼────────────┐
  │            │            │
  ▼            ▼            ▼
Shopify     Prisma/       Fynd
Admin API   PostgreSQL    Platform API
              │
     ┌────────┴────────┐
     │  Customer Portal │  (via Shopify App Proxy)
     │  /apps/returns   │
     └─────────────────┘
```

---

## Features

### Admin Dashboard
- **Summary statistics** — Total returns, approval rate, avg processing time, refund rate with period-over-period change indicators
- **Return volume trend** — Time-series area chart
- **Status distribution** — Donut chart with distinct color coding per status
- **Rate gauges** — Approval, rejection, refund, and Fynd sync rates
- **Resolution breakdown** — Refund vs exchange vs store credit vs replacement
- **Revenue impact** — Revenue retained from exchanges/store credits, green returns count
- **Top return reasons** — Ranked bar chart
- **Status breakdown** — Tabular with progress bars
- **AI Suggestions** — Contextual insights based on data patterns

### Returns Management
- **Returns list** — Searchable, filterable table with multi-select bulk actions
- **Bulk operations** — Approve or reject multiple pending returns at once
- **Return detail** — Complete view with Shopify order, Fynd logistics, items, timeline, and actions
- **Status workflow** — Initiated → Approved → Processing → Completed (or Rejected/Cancelled)
- **Refund processing** — Direct Shopify refund with location-aware fulfillment
- **Resolution types** — Refund, Exchange, Store Credit, Replacement
- **Admin notes** — Internal notes and customer-facing messages
- **CSV export** — Full data export with all fields including Fynd IDs and AWBs

### Customer Portal (App Proxy)
- **Multi-lookup** — Find returns by Order #, Return #, AWB, Email, or Phone
- **OTP verification** — Secure email/SMS one-time-password authentication
- **Return creation** — Item selection, reason codes, photo upload, fee display
- **Return tracking** — 6-step visual progress bar with Fynd shipment status
- **Order tracking** — Real-time Fynd shipment tracking with status timeline
- **Responsive design** — Mobile-first with RTL language support

### Fynd Integration
- **Platform API** — Full return lifecycle management (create, track, sync)
- **Webhook processing** — Real-time status updates from Fynd
- **Order mapping** — Automatic Shopify ↔ Fynd order ID resolution
- **Shipment tracking** — Forward and return AWB tracking with timeline
- **Environment support** — UAT and Production with custom base URLs

### Internationalization (i18n)
- **15 languages** — EN, ES, FR, DE, HI, AR, PT, JA, ZH, KO, IT, NL, RU, TR, TH
- **~229 translation keys** — Covering portal UI, emails, and status labels
- **RTL support** — Arabic, Hebrew, Farsi, Urdu with automatic `dir="rtl"`
- **Locale-aware formatting** — `Intl.NumberFormat` for currency, `Intl.DateTimeFormat` for dates
- **Auto-detection** — Shop locale, currency, and timezone synced from Shopify
- **Custom label overrides** — Merchants can customize any translation key

### Reports & Analytics
- **Date range presets** — Last 7/30/90 days, this month, custom range
- **All dashboard metrics** — With period comparison
- **Exportable** — CSV export of returns data

### Customer Management
- **Customer list** — Aggregated view with return count, total refunded, date range
- **Serial returner detection** — Flags customers with 3+ returns
- **Expandable details** — Per-customer return history with items, status, amounts
- **Search & sort** — By email, returns count, refund amount, recency

### Notifications
- **SMTP email** — Configurable SMTP with connection testing
- **4 email events** — New return, approved, rejected, refunded
- **Custom templates** — Per-event subject and HTML body with variable interpolation
- **Localized emails** — Translated using portal language with RTL support
- **Admin alerts** — Sound notifications for new returns

---

## Settings Modules

| Module | Route | Description |
|--------|-------|-------------|
| **Policy Rules** | `/app/settings/rules` | Return reasons, per-category reasons, restricted regions, minimum price, return offers |
| **Return Settings** | `/app/settings/return-settings` | Return window, fees, photo requirements, auto-approve, auto-refund, refund methods, no-return periods, product tag restrictions |
| **Product Policies** | `/app/settings/product-policies` | Per-product return policies by tags, type, or collection with custom windows |
| **Customer Blocklist** | `/app/settings/blocklist` | Block by email, phone, order name, or IP with duplicate detection |
| **Auto-Approve Rules** | `/app/settings/auto-rules` | Conditional rules based on order value, return reason, product tags, customer return count |
| **Fynd Integration** | `/app/settings/integrations` | Credentials, environment, connection testing, credential management |
| **Notifications** | `/app/settings/notifications` | SMTP config, notification toggles, email templates with live preview |
| **Portal Appearance** | `/app/settings/widget` | Theme (colors, fonts, border radius), tab visibility, language selection, label overrides |
| **Permissions** | `/app/settings/permissions` | `read_all_orders` scope management |
| **Setup Wizard** | `/app/settings/setup` | Step-by-step Fynd credential and webhook configuration |

---

## Status Color Coding

Each status has a distinct, clearly differentiable color across all charts, badges, and graphs:

| Status | Color | Hex | Background |
|--------|-------|-----|------------|
| Pending | Amber | `#d97706` | `#fffbeb` |
| Initiated | Yellow | `#f59e0b` | `#fffbeb` |
| Processing | Blue | `#3b82f6` | `#eff6ff` |
| In Progress | Blue | `#3b82f6` | `#eff6ff` |
| Approved | Green | `#059669` | `#ecfdf5` |
| Completed | Indigo | `#1d4ed8` | `#eff6ff` |
| Rejected | Red | `#dc2626` | `#fef2f2` |
| Cancelled | Slate | `#64748b` | `#f8fafc` |

---

## Data Models

### Core Models

- **Shop** — Shopify store identity with settings relation
- **ShopSettings** — All configuration (130+ fields): Fynd credentials, return policies, notification preferences, portal theming, i18n, refund methods
- **ReturnCase** — Individual return request with full lifecycle data
- **ReturnItem** — Line items within a return with Fynd bag IDs
- **ReturnEvent** — Audit trail of all status changes and actions

### Integration Models

- **FyndOrderMapping** — Shopify ↔ Fynd order ID resolution cache
- **FyndWebhookLog** — Incoming webhook audit log
- **LookupSession** — Portal authentication sessions with OTP

### Security Models

- **BlocklistEntry** — Blocked customers with unique constraint on `[settingsId, type, value]`
- **Session** — Shopify OAuth session storage

---

## API Routes

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/portal/order` | GET | Fetch order details for portal |
| `/api/portal/create-return` | POST | Submit new return request |
| `/api/portal/lookup` | POST | Multi-field return lookup |
| `/api/portal/returns` | GET | Fetch return details for portal |
| `/api/portal/otp/send` | POST | Send OTP for verification |
| `/api/portal/otp/verify` | POST | Verify OTP code |
| `/api/portal/fynd-enrich` | POST | Enrich return with Fynd tracking |
| `/api/returns/:id/actions` | POST | Admin return actions (approve/reject/refund) |
| `/api/returns/bulk` | POST | Bulk approve/reject |
| `/api/returns/export` | GET | CSV export |
| `/api/webhooks/fynd` | POST | Fynd webhook receiver |

---

## Webhook Handlers

| Webhook | Handler |
|---------|---------|
| `APP_UNINSTALLED` | Cleanup shop data |
| `APP_SCOPES_UPDATE` | Update OAuth scopes |
| `ORDERS_FULFILLED` | Track fulfillment status |
| `ORDERS_UPDATED` | Sync order changes |

---

## Security

- **Shopify OAuth** — All admin routes authenticated via `authenticate.admin`
- **OTP verification** — Portal access requires email/SMS verification
- **Encrypted credentials** — Fynd API credentials stored encrypted
- **Blocklist enforcement** — Checked during return creation
- **CSRF protection** — Via Shopify session tokens
- **Input validation** — Server-side validation on all form submissions
- **Error handling** — Try/catch on all database operations with structured error responses

---

## Deployment

See **[RENDER_DEPLOYMENT.md](./RENDER_DEPLOYMENT.md)** for Render deployment instructions.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SHOPIFY_API_KEY` | Yes | Shopify app API key |
| `SHOPIFY_API_SECRET` | Yes | Shopify app API secret |
| `SCOPES` | Yes | Shopify OAuth scopes |
| `HOST` | Yes | App host URL |

---

## Documentation

| Document | Description |
|----------|-------------|
| [SETUP.md](./SETUP.md) | Installation and setup guide |
| [SECURITY.md](./SECURITY.md) | Security policies |
| [RENDER_DEPLOYMENT.md](./RENDER_DEPLOYMENT.md) | Deployment guide |
| [docs/FEATURES_AND_CAPABILITIES.md](./docs/FEATURES_AND_CAPABILITIES.md) | Detailed feature documentation |
| [docs/FYND_SETUP_GUIDE.md](./docs/FYND_SETUP_GUIDE.md) | Fynd integration setup |
| [docs/FYND_API_DETAILS.md](./docs/FYND_API_DETAILS.md) | Fynd API reference |
| [docs/FYND_WEBHOOK.md](./docs/FYND_WEBHOOK.md) | Webhook configuration |
| [docs/TEST_CASES.md](./docs/TEST_CASES.md) | Test case documentation |
| [docs/QC_REPORT.md](./docs/QC_REPORT.md) | Quality control report |

---

## License

Proprietary — All rights reserved.
