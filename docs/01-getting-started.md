# Getting Started with ReturnProMax

## What is ReturnProMax?

ReturnProMax is an enterprise-grade return management application for Shopify merchants. It provides a complete returns workflow -- from customer-facing return portals and OTP-verified order lookups to admin dashboards with advanced refund methods, Fynd logistics integration, automated approval rules, and multi-channel notifications. Built on React Router v7 with Prisma ORM and PostgreSQL, ReturnProMax installs as a Shopify app and extends your storefront with a branded customer portal served via Shopify App Proxy.

---

## Prerequisites

Before installing ReturnProMax, ensure you have the following:

| Requirement             | Minimum Version | Notes                                                      |
|-------------------------|-----------------|------------------------------------------------------------|
| **Node.js**             | 22.12+          | Required by `engines` field in `package.json`              |
| **PostgreSQL**          | 14+             | Used via Prisma ORM for all persistent data                |
| **Shopify Partner Account** | --          | Needed to create and install custom apps                   |
| **Shopify CLI**         | Latest          | Used for `shopify app dev`, deployment, and config linking |
| **npm**                 | 9+              | Bundled with Node.js 22+                                   |
| **Git**                 | 2.30+           | For cloning the repository                                 |

### Optional Requirements

| Requirement             | Purpose                                                     |
|-------------------------|-------------------------------------------------------------|
| **Fynd Partner Account**| Logistics integration (reverse pickups, AWB tracking)       |
| **SMTP Server**         | Email notifications (approval, rejection, refund, OTP)      |
| **WhatsApp Provider**   | SMS/WhatsApp notifications (Meta Cloud, Twilio, WATI, etc.) |

---

## Installation

### 1. Clone the Repository

```bash
git clone <repository-url> returnpromax
cd returnpromax
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Configure Environment Variables

Create a `.env` file in the project root:

```bash
cp .env.example .env
```

Edit `.env` with your values (see [Environment Variables](#environment-variables) below).

### 4. Set Up the Database

Generate the Prisma client and run migrations:

```bash
npx prisma generate
npx prisma migrate deploy
```

Or use the convenience script:

```bash
npm run setup
```

### 5. Start the Development Server

**With Shopify CLI (recommended for development):**

```bash
npm run dev
```

This runs `npx shopify app dev`, which starts the app with Shopify's development tunnel and OAuth flow.

**Without Shopify CLI (local-only development):**

```bash
npm run dev:local
```

This runs Prisma generation, database push, and the React Router dev server directly.

### 6. Deploy

```bash
npm run deploy
```

This runs `shopify app deploy` to push your app configuration to Shopify.

---

## Available Scripts

| Script               | Command                                              | Description                                                  |
|----------------------|------------------------------------------------------|--------------------------------------------------------------|
| `npm run dev`        | `npx shopify app dev`                                | Start dev server with Shopify CLI tunnel                     |
| `npm run dev:local`  | `prisma generate && prisma db push && react-router dev` | Start dev server without Shopify CLI                      |
| `npm run build`      | Portal build + `react-router build`                  | Build for production                                         |
| `npm run start`      | Validate env + migrate + startup backfills + serve   | Start production server                                      |
| `npm run setup`      | `prisma generate && prisma migrate deploy`           | Generate client and run migrations                           |
| `npm run deploy`     | `shopify app deploy`                                 | Deploy app configuration to Shopify                          |
| `npm run config:link`| `shopify app config link`                            | Link local config to Shopify Partner dashboard               |
| `npm run validate:key`| `node scripts/validate-encryption-key.js`           | Validate the `ENCRYPTION_KEY` environment variable           |
| `npm run test`       | `vitest run`                                         | Run test suite once                                          |
| `npm run test:watch` | `vitest`                                             | Run tests in watch mode                                      |
| `npm run test:fynd-api` | `node scripts/test-fynd-apis.mjs`                 | Test Fynd API connectivity                                   |

> **Note:** The `start` script validates required production environment values,
> applies Prisma migrations, runs idempotent startup backfills, and then starts
> `react-router-serve`.

---

## Environment Variables

### Required Variables

| Variable             | Description                                                | Example                                      |
|----------------------|------------------------------------------------------------|----------------------------------------------|
| `DATABASE_URL`       | PostgreSQL connection string                               | `postgresql://user:pass@localhost:5432/returnpromax` |
| `SHOPIFY_APP_URL`    | Public URL of the app (used for OAuth redirect, App Proxy) | `https://your-app.fly.dev`                   |
| `SHOPIFY_API_KEY`    | Shopify app API key from Partner Dashboard                 | `abc123def456...`                            |
| `SHOPIFY_API_SECRET` | Shopify app API secret from Partner Dashboard              | `shpss_abc123...`                            |
| `SCOPES`             | Shopify OAuth scopes                                       | `read_orders,write_orders`                   |
| `REDIS_URL`          | Redis connection string for production rate limiting       | `rediss://default:...@redis.example.com:6379` |
| `CRON_SECRET`        | Secret for scheduled/cron endpoints                        | `32+ random characters`                      |
| `PORTAL_JWT_SECRET`  | Secret for signing portal JWT tokens (min 32 chars)        | `a-secure-random-string-at-least-32-chars`   |
| `FYND_WEBHOOK_SECRET`| Secret for legacy/global Fynd webhook authentication       | `32+ random characters`                      |
| `ENCRYPTION_KEY`     | Key for encrypting sensitive data (Fynd credentials)       | `32-byte-hex-string`                         |

### Optional Variables

| Variable             | Description                                                | Default     |
|----------------------|------------------------------------------------------------|-------------|
| `NODE_ENV`           | Runtime environment                                        | `development` |
| `PORT`               | Server port                                                | `3000`      |

### Security Notes

- `PORTAL_JWT_SECRET` must be at least 32 characters in production. In development, a fallback is used with a structured warning.
- `ENCRYPTION_KEY` is used to encrypt Fynd API credentials at rest and must be exactly 64 hex characters in production. Run `npm run validate:key` to verify it is configured correctly.
- `SHOPIFY_APP_URL` must be an origin-only `https://` URL on a stable public hostname in production.
- `REDIS_URL` is mandatory in production so portal and API rate limits work across multiple instances.
- `FYND_WEBHOOK_SECRET` is required in production for `/api/webhooks/fynd`; per-shop webhook secrets remain preferred for shop-specific callbacks.
- Never commit `.env` files to version control.

---

## Project Structure

```
returnpromax/
├── app/
│   ├── routes/                  # File-based routing (React Router v7)
│   │   ├── app.*.tsx            # Admin UI pages (Shopify embedded app)
│   │   ├── api.portal.*.ts      # Customer portal API endpoints
│   │   ├── api.returns.*.ts     # Return management API endpoints
│   │   ├── api.v1.external.*.ts # External REST API (API key auth)
│   │   ├── api.webhooks.*.ts    # Fynd webhook receivers
│   │   ├── webhooks.*.tsx       # Shopify webhook handlers
│   │   └── auth.*.tsx           # Shopify OAuth flow
│   ├── lib/                     # Shared business logic
│   │   ├── shopify-admin.server.ts   # Shopify Admin API (GraphQL + REST)
│   │   ├── fynd.server.ts            # Fynd API client factory
│   │   ├── fynd-returns.server.ts    # Fynd return creation logic
│   │   ├── fynd-webhook.server.ts    # Fynd webhook processing
│   │   ├── notification.server.ts    # Email/SMS notifications
│   │   ├── portal-auth.server.ts     # JWT auth for customer portal
│   │   ├── return-rules.server.ts    # Return eligibility engine
│   │   ├── auto-approve.server.ts    # Auto-approval rule engine
│   │   ├── api-key-auth.server.ts    # External API authentication
│   │   ├── encryption.server.ts      # Credential encryption
│   │   ├── rate-limit.server.ts      # Rate limiting
│   │   └── return-request-id.ts      # RPM-XXXXXXXX ID generation
│   ├── portal/                  # Customer-facing portal
│   │   └── index.html           # SPA served via Shopify App Proxy
│   ├── shopify.server.ts        # Shopify app configuration
│   └── db.server.ts             # Prisma client singleton
├── prisma/
│   ├── schema.prisma            # Database schema definition
│   └── migrations/              # Database migration history
├── scripts/                     # Utility and backfill scripts
├── package.json                 # Dependencies and scripts
├── vite.config.ts               # Vite configuration
└── tsconfig.json                # TypeScript configuration
```

### Key Directories

| Directory         | Purpose                                                              |
|-------------------|----------------------------------------------------------------------|
| `app/routes/`     | All HTTP endpoints. Follows React Router v7 file-based conventions.  |
| `app/lib/`        | Server-side business logic. All files use `.server.ts` suffix.       |
| `app/portal/`     | Customer-facing HTML SPA served through Shopify App Proxy.           |
| `prisma/`         | Database schema and migrations for PostgreSQL.                       |
| `scripts/`        | One-time migration scripts, API testing, and key validation.         |

---

## Post-Install Checklist

After installation, complete these steps to fully configure ReturnProMax:

- [ ] **Verify database connection** -- Run `npx prisma db push` to confirm the database is reachable.
- [ ] **Install on a Shopify store** -- Use `npm run dev` to initiate OAuth and install the app on your development store.
- [ ] **Configure return settings** -- Navigate to Settings > Return Settings in the admin panel to set return window, reasons, and policies.
- [ ] **Set up notifications** -- Configure SMTP settings in Settings > Notifications for email alerts.
- [ ] **Connect Fynd (optional)** -- Add Fynd Platform API credentials in Settings > Integrations for logistics support.
- [ ] **Configure the customer portal** -- Customize branding, colors, and labels in Settings > Portal Widget.
- [ ] **Set up App Proxy** -- In your Shopify Partner Dashboard, configure the App Proxy to point to your app's portal endpoint.
- [ ] **Create API keys (optional)** -- Generate API keys in Settings > API Keys for external system integration.
- [ ] **Test the portal** -- Visit the App Proxy URL on your storefront to verify the customer portal loads correctly.
- [ ] **Validate encryption key** -- Run `npm run validate:key` to ensure credential encryption is working.

---

## Next Steps

- [Architecture Overview](./02-architecture-overview.md) -- Understand the system design and data flow.
- [Returns Management](./05-returns-management.md) -- Learn about the return lifecycle and admin actions.
- [Customer Portal](./06-customer-portal.md) -- Configure and customize the customer-facing portal.
- [Refund Methods](./07-refund-methods.md) -- Configure refund methods and payment handling.
