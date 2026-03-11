# Data Flow Architecture

## System Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                         EXTERNAL SYSTEMS                            │
├──────────────────┬──────────────────┬───────────────────────────────┤
│  Shopify Admin   │  Customer Browser│  Fynd Platform    │  ERP/     │
│  (Embedded App)  │  (Portal SPA)    │  (Logistics)      │  External │
└────────┬─────────┴────────┬─────────┴────────┬──────────┴─────┬────┘
         │                  │                  │                │
         │ Shopify OAuth    │ App Proxy        │ Webhook POST   │ X-API-Key
         │                  │ (HTTPS)          │ (HMAC signed)  │ (bcrypt)
         ▼                  ▼                  ▼                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    REACT ROUTER v7 SERVER                           │
├──────────────────┬──────────────────┬──────────────────┬────────────┤
│  Admin Routes    │  Portal Routes   │  Fynd Routes     │  External  │
│  app.*.tsx       │  api.portal.*.ts │  api.webhooks.*  │  API v1    │
│                  │                  │                  │  Routes    │
│  authenticate.   │  JWT + OTP       │  HMAC verify     │  API key   │
│  admin(request)  │  verification    │  + replay check  │  auth      │
├──────────────────┴──────────────────┴──────────────────┴────────────┤
│                      BUSINESS LOGIC LAYER                           │
│  app/lib/                                                           │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐          │
│  │ shopify-admin  │ │ fynd-returns   │ │ notification   │          │
│  │ .server.ts     │ │ .server.ts     │ │ .server.ts     │          │
│  │ (Refunds,      │ │ (Sync, Retry,  │ │ (Email, SMS,   │          │
│  │  Orders, GQL)  │ │  Consolidation)│ │  WhatsApp)     │          │
│  └────────────────┘ └────────────────┘ └────────────────┘          │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐          │
│  │ return-rules   │ │ portal-auth    │ │ api-key-auth   │          │
│  │ .server.ts     │ │ .server.ts     │ │ .server.ts     │          │
│  │ (Eligibility,  │ │ (JWT, OTP,     │ │ (Key gen,      │          │
│  │  Auto-approve) │ │  Hash)         │ │  bcrypt verify)│          │
│  └────────────────┘ └────────────────┘ └────────────────┘          │
│  ┌────────────────┐ ┌────────────────┐ ┌────────────────┐          │
│  │ encryption     │ │ webhook-       │ │ rate-limit     │          │
│  │ .server.ts     │ │ dispatch.ts    │ │ .server.ts     │          │
│  │ (AES-256-GCM)  │ │ (Outbound,     │ │ (Sliding       │          │
│  │                │ │  HMAC signing) │ │  window)       │          │
│  └────────────────┘ └────────────────┘ └────────────────┘          │
├─────────────────────────────────────────────────────────────────────┤
│                        DATA LAYER                                   │
│  Prisma ORM → PostgreSQL                                           │
│  ┌──────────┐ ┌──────────────┐ ┌────────────┐ ┌──────────────┐    │
│  │ Shop     │ │ ShopSettings │ │ ReturnCase │ │ ReturnItem   │    │
│  │          │ │ (80+ fields) │ │            │ │              │    │
│  └──────────┘ └──────────────┘ └────────────┘ └──────────────┘    │
│  ┌──────────┐ ┌──────────────┐ ┌────────────┐ ┌──────────────┐    │
│  │ ApiKey   │ │ WebhookSub   │ │ ReturnEvent│ │ BlocklistEnt │    │
│  └──────────┘ └──────────────┘ └────────────┘ └──────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

## Request Flow by Client Type

### Admin (Shopify Embedded App)
```
Browser → Shopify Admin iframe → React Router route (app.*.tsx)
  → authenticate.admin(request) → Shopify OAuth session validated
  → Prisma query (scoped by shopId) → React component rendered
```

### Customer Portal
```
Browser → Shopify store URL/a/returns → App Proxy → apps.returns.tsx
  → Serves index.html SPA with shop config injected
  → SPA makes API calls to /api/portal/* endpoints
  → JWT token from OTP verification used for auth
```

### Fynd Webhook
```
Fynd Platform → POST /api/webhooks/fynd
  → HMAC signature verification (when secret configured)
  → Replay protection (5-minute timestamp window)
  → Idempotency check (dedup by shipment_id + status)
  → Status mapping → ReturnCase update → Auto-refund trigger
```

### External API (ERP/Third-party)
```
ERP System → GET/POST /api/v1/external/*
  → X-API-Key header → Prefix lookup → bcrypt verify
  → Permission check → Rate limit check
  → Business logic → Response envelope { data, meta, errors }
  → Outbound webhook dispatch (fire-and-forget)
```

## Data Relationships

```
Shop (1) ──── (1) ShopSettings
  │                   │
  │                   └── (*) BlocklistEntry
  │
  ├── (*) ReturnCase
  │        │
  │        ├── (*) ReturnItem
  │        └── (*) ReturnEvent
  │
  ├── (*) ApiKey
  └── (*) WebhookSubscription

FyndOrderMapping (standalone, indexed by shopId + shopifyOrderName)
FyndWebhookLog   (standalone, indexed by shipmentId + orderId)
LookupSession    (standalone, indexed by shopId + lookupValueHash)
NotificationLog  (standalone, indexed by shopId + createdAt)
Session          (Shopify OAuth sessions, standalone)
```
