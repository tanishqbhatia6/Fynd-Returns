# ReturnProMax Documentation

**Enterprise Returns Management for Shopify**

ReturnProMax is a full-featured Shopify embedded app that manages product returns end-to-end — from customer-initiated return requests through approval, logistics, and refund processing. It supports Shopify native orders, Fynd marketplace integration, multiple refund methods, automation rules, multi-language portals, and external API access for ERP/system integration.

---

## Quick Start

```bash
git clone <repo-url> && cd returnpromax
npm install
cp .env.example .env  # Configure DATABASE_URL, SHOPIFY_API_KEY, etc.
npx prisma migrate dev
npm run dev
```

See [Getting Started](./01-getting-started.md) for the full setup guide.

---

## Documentation Map

### Setup & Architecture
| Section | Description |
|---------|-------------|
| [01 - Getting Started](./01-getting-started.md) | Prerequisites, installation, environment setup, first run |
| [02 - Architecture Overview](./02-architecture-overview.md) | Tech stack, system design, routing, authentication, multi-tenancy |
| [03 - Database Schema Reference](./03-database-schema-reference.md) | All 14 models documented field-by-field with ER diagram |
| [19 - Deployment](./19-deployment.md) | Render deployment, Shopify Partner config, migrations, backfills |

### Core Features
| Section | Description |
|---------|-------------|
| [04 - Admin Dashboard](./04-admin-dashboard.md) | Metrics, charts, date ranges, status color coding |
| [05 - Returns Management](./05-returns-management.md) | Returns list, detail page, all actions, status workflow, bulk ops |
| [06 - Customer Portal](./06-customer-portal.md) | Portal tabs, return creation flow, OTP auth, tracking, eligibility |
| [07 - Refund Methods](./07-refund-methods.md) | Original, store credit, discount code, split refund, bonus, green returns |
| [08 - Fynd Integration](./08-fynd-integration.md) | Credentials, sync flow, retry engine, consolidation, webhooks |

### Configuration
| Section | Description |
|---------|-------------|
| [09 - Settings Reference](./09-settings-reference.md) | All 80+ settings organized by category with defaults |
| [10 - Notifications](./10-notifications.md) | SMTP email, templates, WhatsApp, admin alerts |
| [11 - Automation Rules](./11-automation-rules.md) | Auto-approve, auto-refund, green returns, offers, blocklist |
| [12 - Customer Management](./12-customer-management.md) | Customer page, serial returner detection |
| [13 - Reports & Analytics](./13-reports-analytics.md) | Charts, date presets, CSV export |
| [14 - Internationalization](./14-internationalization.md) | 15 languages, RTL support, label overrides |
| [17 - Portal Customization](./17-portal-customization.md) | Theme, branding, fonts, tab toggles |

### Technical Reference
| Section | Description |
|---------|-------------|
| [15 - API Reference](./15-api-reference.md) | All endpoints: Portal, Admin, Fynd, External API |
| [16 - Webhook Reference](./16-webhook-reference.md) | Shopify, Fynd, and outbound webhooks |
| [18 - Security](./18-security.md) | Auth, encryption, rate limiting, CORS, production checklist |

### Operations
| Section | Description |
|---------|-------------|
| [20 - Troubleshooting](./20-troubleshooting.md) | Common issues, debug tools, error reference |
| [21 - Glossary](./21-glossary.md) | All domain terms defined A-Z |

### Diagrams
| Diagram | Description |
|---------|-------------|
| [Return Lifecycle](./diagrams/return-lifecycle.md) | Status state machine with transitions |
| [Data Flow](./diagrams/data-flow.md) | System architecture diagram |
| [Portal Auth Flow](./diagrams/portal-auth-flow.md) | OTP verification sequence |
| [Fynd Sync Flow](./diagrams/fynd-sync-flow.md) | Return creation + webhook cycle |

---

## What Are You Looking For?

| Goal | Go To |
|------|-------|
| Setting up for the first time | [01 - Getting Started](./01-getting-started.md) |
| Understanding how the app works | [02 - Architecture Overview](./02-architecture-overview.md) |
| Managing returns in the admin panel | [05 - Returns Management](./05-returns-management.md) |
| Setting up the customer portal | [06 - Customer Portal](./06-customer-portal.md) |
| Configuring refund methods | [07 - Refund Methods](./07-refund-methods.md) |
| Connecting Fynd marketplace | [08 - Fynd Integration](./08-fynd-integration.md) |
| Setting up email notifications | [10 - Notifications](./10-notifications.md) |
| Building an API integration (ERP) | [15 - API Reference](./15-api-reference.md) |
| Generating API keys | [15 - API Reference](./15-api-reference.md#external-api) |
| Debugging a Fynd error | [20 - Troubleshooting](./20-troubleshooting.md#fynd-integration-issues) |
| Deploying to production | [19 - Deployment](./19-deployment.md) |
| Understanding a term | [21 - Glossary](./21-glossary.md) |

---

## Key Numbers

- **14 database models** (including ApiKey, WebhookSubscription)
- **48+ route files** handling admin, portal, Fynd, and external API
- **30+ server utilities** in `app/lib/`
- **9 external API endpoints** with Postman collection export
- **15 portal languages** with RTL support
- **80+ configurable settings**
- **249 automated tests** across 18 test files
