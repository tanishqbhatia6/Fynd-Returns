# Architecture Overview

## High-Level System Components

ReturnProMax is a Shopify embedded application built on React Router v7 with server-side rendering. It integrates with the Shopify Admin API for order and refund management, Fynd Platform API for logistics operations, and serves a customer-facing portal through Shopify's App Proxy mechanism.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           SHOPIFY PLATFORM                              │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────────┐    │
│  │ Shopify Admin │  │  App Proxy   │  │   Shopify Webhooks         │    │
│  │   (iframe)    │  │  (storefront)│  │ (orders, fulfillment, etc.)│    │
│  └──────┬───────┘  └──────┬───────┘  └─────────────┬──────────────┘    │
│         │                 │                         │                    │
└─────────┼─────────────────┼─────────────────────────┼───────────────────┘
          │ OAuth           │ HTTP                    │ POST
          ▼                 ▼                         ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                      RETURNPROMAX APPLICATION                           │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    React Router v7 Server                       │    │
│  │                                                                 │    │
│  │  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐     │    │
│  │  │  Admin Routes │  │ Portal Routes│  │  Webhook Routes   │     │    │
│  │  │  app.*.tsx    │  │ api.portal.* │  │  webhooks.*       │     │    │
│  │  └──────┬───────┘  └──────┬───────┘  └────────┬──────────┘     │    │
│  │         │                 │                    │                │    │
│  │  ┌──────┴─────────────────┴────────────────────┴──────────┐    │    │
│  │  │                   Business Logic Layer                  │    │    │
│  │  │  shopify-admin.server.ts  │  fynd-returns.server.ts     │    │    │
│  │  │  return-rules.server.ts   │  auto-approve.server.ts     │    │    │
│  │  │  notification.server.ts   │  portal-auth.server.ts      │    │    │
│  │  └──────────────────────────┬──────────────────────────────┘    │    │
│  │                             │                                   │    │
│  │  ┌──────────────────────────┴──────────────────────────────┐    │    │
│  │  │                    Data Layer (Prisma)                   │    │    │
│  │  │  Shop │ ShopSettings │ ReturnCase │ ReturnItem │ Events  │    │    │
│  │  └──────────────────────────┬──────────────────────────────┘    │    │
│  │                             │                                   │    │
│  └─────────────────────────────┼───────────────────────────────────┘    │
│                                │                                        │
└────────────────────────────────┼────────────────────────────────────────┘
                                 │
                    ┌────────────┴────────────┐
                    │      PostgreSQL          │
                    │   (Multi-tenant data)    │
                    └─────────────────────────┘

External Services:
  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
  │ Shopify Admin│   │  Fynd APIs   │   │ SMTP / SMS   │
  │  GraphQL +   │   │  Platform +  │   │  Providers   │
  │  REST APIs   │   │  Storefront  │   │              │
  └──────────────┘   └──────────────┘   └──────────────┘
```

---

## Tech Stack

| Layer               | Technology                              | Version   |
|---------------------|-----------------------------------------|-----------|
| **Runtime**         | Node.js                                 | >= 22.12  |
| **Language**        | TypeScript                              | 5.9+      |
| **Framework**       | React Router v7 (file-based routing)    | 7.13+     |
| **UI Framework**    | React 19 + Shopify Polaris (admin)      | 19.2+     |
| **Build Tool**      | Vite 7                                  | 7.3+      |
| **ORM**             | Prisma 6                                | 6.19+     |
| **Database**        | PostgreSQL                              | 14+       |
| **Shopify SDK**     | @shopify/shopify-app-react-router       | 1.1+      |
| **Fynd SDK**        | @gofynd/fdk-client-javascript           | 3.18+     |
| **Charts**          | Recharts                                | 3.7+      |
| **Auth (Portal)**   | jsonwebtoken + bcryptjs                 | 9.0+ / 3.0+ |
| **Email**           | Nodemailer                              | 8.0+      |
| **Testing**         | Vitest                                  | 4.0+      |

---

## File-Based Routing Convention

ReturnProMax uses React Router v7's file-system routing via `@react-router/fs-routes`. Every file in `app/routes/` becomes a route. The naming convention uses dots (`.`) as path separators:

### Route Naming Patterns

| File Name                              | HTTP Path                            | Purpose                       |
|----------------------------------------|--------------------------------------|-------------------------------|
| `app._index.tsx`                       | `/app`                               | Admin dashboard (home)        |
| `app.returns._index.tsx`               | `/app/returns`                       | Returns list page             |
| `app.returns.$id.tsx`                  | `/app/returns/:id`                   | Return detail page            |
| `app.settings._index.tsx`              | `/app/settings`                      | Settings hub                  |
| `app.settings.return-settings.tsx`     | `/app/settings/return-settings`      | Return policy settings        |
| `api.portal.lookup.ts`                 | `/api/portal/lookup`                 | Portal order lookup API       |
| `api.portal.otp.send.ts`              | `/api/portal/otp/send`              | Portal OTP send API           |
| `api.returns.$id.actions.ts`           | `/api/returns/:id/actions`           | Return action dispatcher      |
| `api.v1.external.returns.ts`           | `/api/v1/external/returns`           | External API: list returns    |
| `webhooks.orders.create.tsx`           | `/webhooks/orders/create`            | Shopify order create webhook  |

### Route Categories

**Admin Pages (`app.*.tsx`):** Shopify embedded app pages rendered inside an iframe. These use Shopify's App Bridge and Polaris components. Authenticated via Shopify OAuth.

**Portal API (`api.portal.*.ts`):** RESTful endpoints serving the customer-facing portal. Authenticated via JWT tokens issued after OTP verification. All responses include CORS headers for cross-origin App Proxy requests.

**Return Actions (`api.returns.*.ts`):** Internal API endpoints for return management. Authenticated via Shopify Admin session. The central dispatcher is `api.returns.$id.actions.ts`.

**External API (`api.v1.external.*.ts`):** Public REST API for third-party integrations. Authenticated via API keys (`X-API-Key` header) with granular permissions.

**Webhooks (`webhooks.*.tsx` and `api.webhooks.*.ts`):** Receive events from Shopify (order creation, fulfillment, app lifecycle) and Fynd (shipment status updates).

---

## Business Logic Layer

All server-side business logic resides in `app/lib/`. Files follow the `.server.ts` convention to ensure they are never bundled into client-side code.

### Core Modules

| Module                          | Responsibility                                                  |
|---------------------------------|-----------------------------------------------------------------|
| `shopify-admin.server.ts`       | Shopify Admin API wrapper: order fetching, refund creation, discount codes, gift cards, location lookup |
| `fynd.server.ts`                | Fynd API client factory (Platform and Storefront modes)         |
| `fynd-returns.server.ts`        | Create returns on Fynd, map Shopify orders to Fynd shipments    |
| `fynd-webhook.server.ts`        | Process Fynd shipment status webhooks                           |
| `fynd-retry.server.ts`          | Automatic retry mechanism for failed Fynd syncs                 |
| `fynd-consolidation.server.ts`  | Batch multiple returns into single Fynd operations              |
| `return-rules.server.ts`        | Return eligibility engine (window, price, tags, regions)        |
| `auto-approve.server.ts`        | Rule-based automatic approval (order value, reason, tags, etc.) |
| `notification.server.ts`        | Email (SMTP) and SMS/WhatsApp notifications                     |
| `portal-auth.server.ts`         | JWT token creation and verification for portal sessions         |
| `portal-config.server.ts`       | Portal configuration loading and theme resolution               |
| `portal-theme.server.ts`        | Portal CSS variable injection from shop settings                |
| `api-key-auth.server.ts`        | External API key generation, hashing, and verification          |
| `encryption.server.ts`          | AES encryption for Fynd credentials at rest                     |
| `rate-limit.server.ts`          | In-memory rate limiting for portal and webhook endpoints        |
| `return-request-id.ts`          | User-friendly return ID generation (RPM-XXXXXXXX format)        |
| `webhook-dispatch.server.ts`    | Dispatch events to registered external webhook subscribers      |

---

## Data Layer

### Prisma ORM

ReturnProMax uses Prisma ORM with PostgreSQL. The schema is defined in `prisma/schema.prisma`. Migrations are stored in `prisma/migrations/`.

### Core Models

```
┌──────────┐       ┌──────────────┐
│  Session  │       │     Shop     │
│ (Shopify) │       │              │
└──────────┘       └──────┬───────┘
                          │ 1:1
                   ┌──────┴───────┐
                   │ ShopSettings  │
                   │ (config JSON) │
                   └──────────────┘
                          │ 1:N
           ┌──────────────┼──────────────┐
           │              │              │
    ┌──────┴──────┐ ┌─────┴─────┐ ┌─────┴──────┐
    │ ReturnCase  │ │  ApiKey   │ │  Webhook   │
    │             │ │           │ │Subscription│
    └──────┬──────┘ └───────────┘ └────────────┘
           │ 1:N           1:N
    ┌──────┼──────────────┐
    │      │              │
┌───┴────┐ ┌──────┴──────┐
│Return  │ │ ReturnEvent │
│ Item   │ │ (timeline)  │
└────────┘ └─────────────┘
```

| Model                 | Purpose                                                            |
|-----------------------|--------------------------------------------------------------------|
| `Session`             | Shopify OAuth session storage (managed by Shopify SDK)             |
| `Shop`                | Installed shop record. All data scoped by `shopId`.                |
| `ShopSettings`        | Per-shop configuration: Fynd credentials, return policies, notification settings, portal theme, refund methods, blocklist settings |
| `ReturnCase`          | Individual return request with customer info, order references, Fynd sync state, refund status, resolution type |
| `ReturnItem`          | Line items within a return (product title, SKU, price, quantity, reason, condition) |
| `ReturnEvent`         | Immutable event log / timeline (status changes, notes, Fynd sync events, refund events) |
| `ApiKey`              | External API keys with prefix-based lookup and bcrypt-hashed storage |
| `WebhookSubscription` | External webhook endpoints registered by API consumers             |
| `LookupSession`       | Portal session for OTP verification flow                           |
| `BlocklistEntry`      | Blocked customers (email/phone) who cannot create returns          |

### Key Indexes

ReturnCase has composite indexes on `shopId` + common lookup fields for query performance:

- `[shopId, shopifyOrderName]` -- Order name lookup
- `[shopId, forwardAwb]` -- AWB tracking lookup
- `[shopId, returnAwb]` -- Return AWB lookup
- `[shopId, fyndReturnId]` -- Fynd return correlation
- `[shopId, fyndShipmentId]` -- Fynd shipment correlation
- `[shopId, returnRequestNo]` -- User-facing return ID lookup
- `[shopId, customerEmailNorm]` -- Customer email lookup
- `[shopId, customerPhoneNorm]` -- Customer phone lookup
- `[fyndSyncStatus, fyndSyncNextRetry]` -- Retry queue processing

---

## Authentication Architecture

ReturnProMax employs three distinct authentication mechanisms, each for a different access context:

### 1. Shopify OAuth (Admin Panel)

Used by: All `app.*` routes and `api.returns.*` routes.

```
Merchant → Shopify Admin → iframe → ReturnProMax
                                        │
                                   authenticate.admin(request)
                                        │
                                   Session validated
                                   Shop context resolved
```

- Managed by `@shopify/shopify-app-react-router`.
- Sessions stored in the `Session` table via `@shopify/shopify-app-session-storage-prisma`.
- Every admin request calls `authenticate.admin(request)` which validates the session and provides the `admin` GraphQL client and `session` object.

### 2. JWT + OTP (Customer Portal)

Used by: All `api.portal.*` routes.

```
Customer → Storefront (App Proxy) → Portal SPA
                                        │
                                   1. POST /api/portal/lookup
                                      (email + order#)
                                        │
                                   2. POST /api/portal/otp/send
                                      (6-digit OTP via email)
                                        │
                                   3. POST /api/portal/otp/verify
                                      (OTP verification → JWT issued)
                                        │
                                   4. Subsequent requests carry
                                      JWT in Authorization header
```

- JWT tokens are signed with `PORTAL_JWT_SECRET` and expire after 1 hour.
- OTP is a 6-digit numeric code, bcrypt-hashed before storage.
- Rate limited: 60-second cooldown between OTP sends, max 5 attempts per session.
- Phone OTP starts fail closed until a real SMS/WhatsApp OTP delivery path is implemented and verified.

### 3. API Key (External API)

Used by: All `api.v1.external.*` routes.

```
External System → HTTPS → ReturnProMax External API
                              │
                         X-API-Key: rpm_<40-hex-chars>
                              │
                         Prefix lookup → bcrypt verify
                              │
                         Permission check
```

- Keys use `rpm_` prefix followed by 40 hex characters (160-bit entropy).
- Stored as bcrypt hashes; lookup by 8-character prefix + shopId, then bcrypt verify.
- Granular permissions: `read_returns`, `write_returns`, `read_settings`, `manage_webhooks`.
- Keys are shown exactly once at generation time.

---

## Multi-Tenancy

ReturnProMax is a multi-tenant application. Every data record is scoped to a specific shop:

1. **Shop Model:** Each Shopify store that installs the app gets a `Shop` record with a unique `shopDomain`.
2. **Query Scoping:** All database queries include a `shopId` filter. For example:
   ```typescript
   const returnCase = await prisma.returnCase.findFirst({
     where: { id, shopId: shop.id },
     include: { items: true },
   });
   ```
3. **Settings Isolation:** Each shop has its own `ShopSettings` record containing Fynd credentials, return policies, notification configuration, portal theme, and refund methods.
4. **Session Binding:** The Shopify OAuth session binds to a specific shop domain. The `session.shop` value is used to look up the `Shop` record in every admin request.
5. **API Key Scoping:** External API keys are linked to a specific `shopId`. Requests authenticated with an API key can only access that shop's data.

---

## Data Flow Diagrams

### Return Creation Flow (Customer Portal)

1. Customer visits the storefront return portal (served via Shopify App Proxy).
2. Portal SPA loads and presents three tabs: Create Return, Track Return, Track Order.
3. Customer enters order number and email, triggering a lookup against Shopify orders.
4. A 6-digit code is sent via email. Customer verifies before sensitive order or return data is returned.
5. Portal displays eligible line items. Customer selects items, reasons, uploads photos.
6. Portal submits the return request to `POST /api/portal/create-return`.
7. Server creates a `ReturnCase` record with `ReturnItem` entries and a `ReturnEvent`.
8. Auto-approve rules are evaluated. If matched, the return is automatically approved and synced to Fynd.
9. Email notification is sent to the merchant and (optionally) the customer.

### Return Processing Flow (Admin)

1. Merchant views the return in the admin panel (`/app/returns/:id`).
2. Merchant performs an action (approve, reject, process refund) via `POST /api/returns/:id/actions`.
3. On approval, the server creates a return on Fynd via Platform API (unless it is a green return).
4. Fynd assigns a reverse shipment with AWB tracking. Shipping details auto-populate.
5. On refund, the server calls Shopify's Refund API (original payment, store credit, or discount code).
6. Each action creates a `ReturnEvent` record for the timeline.
7. Email notifications are dispatched at each status transition.

### Fynd Webhook Flow

1. Fynd sends shipment status updates to `POST /api/webhooks/fynd`.
2. The webhook handler matches the shipment to a `ReturnCase` by `fyndShipmentId` or `fyndOrderId`.
3. The `fyndCurrentStatus` field is updated on the `ReturnCase`.
4. A `ReturnEvent` is created to log the status change.
5. If auto-refund is enabled and the status matches the allowed list, a refund is automatically triggered.
6. Failed webhook deliveries are logged and can be retried via `POST /api/webhooks/fynd/retry`.

### External API Flow

1. External system sends a request with `X-API-Key` header.
2. The API key is verified via prefix lookup and bcrypt comparison.
3. Permissions are checked against the required permission for the endpoint.
4. The request is processed within the scope of the API key's shop.
5. Webhook subscriptions can be registered to receive real-time event notifications.

---

## Error Handling Patterns

The application uses several error handling patterns consistently across the codebase:

### Error Enrichment

Domain-specific error enrichment functions add actionable guidance to raw error messages:

- `enrichFyndError()` -- Adds context for Fynd 403 errors, suggesting permission checks.
- `enrichRefundError()` -- Suggests alternative refund methods for COD orders, missing customers, or already-refunded orders.

### Graceful Degradation

- If Fynd sync fails during approval, the return is still approved with `fyndSyncStatus: "failed"`. The admin can retry later.
- If line item IDs are Fynd bag IDs (not Shopify GIDs), the system falls back to SKU-based matching against the Shopify order.
- PCDA-safe (Protected Customer Data Access) query strategies are used to avoid permission errors when accessing Shopify order data.

### Rate Limiting

In-memory rate limiting is applied to portal endpoints (`portal.otp.send`, `portal.lookup`) to prevent abuse. Limits are enforced per IP address with configurable windows.

---

## Deployment Architecture

ReturnProMax is designed to run as a single Node.js process serving both the admin panel and portal API. It is suitable for deployment on:

- **Fly.io** -- Recommended. Single-region or multi-region with a shared PostgreSQL database.
- **Railway / Render** -- Single-container deployment with managed PostgreSQL.
- **Docker** -- Containerized deployment with external PostgreSQL.
- **Any Node.js host** -- Any platform that supports Node.js 22+ and PostgreSQL connectivity.

The production start command runs data backfill scripts before launching the server:

```bash
node scripts/backfill-shopify-order-ids.mjs && \
node scripts/backfill-webhook-logs.mjs && \
node scripts/backfill-customer-info.mjs && \
react-router-serve ./build/server/index.js
```
