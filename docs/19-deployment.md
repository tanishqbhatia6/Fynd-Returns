# 19 — Deployment

> Deployment guide for Render, Shopify Partner configuration, environment variables, database migrations, and backfill scripts.

---

## Overview

ReturnProMax is designed to deploy on **Render** (web service + managed PostgreSQL) with the Shopify CLI for app management. The deployment pipeline:

```
Code Push → Render Build → Prisma Generate → React Router Build
          → Production Env Validation → Prisma Migrate Deploy
          → Backfill Scripts → Start Server
```

---

## Render Deployment

### Render Blueprint

The `render.yaml` file defines the infrastructure:

```yaml
services:
  - type: web
    name: returnpromax
    runtime: node
    region: oregon

    buildCommand: npm install && npx prisma generate && npm run build
    startCommand: npm run start

    envVars:
      - key: NODE_ENV
        value: production
      - key: DATABASE_URL
        fromDatabase:
          name: returnpromax-db
          property: connectionString
      - key: SHOPIFY_API_KEY
        sync: false
      - key: SHOPIFY_API_SECRET
        sync: false
      - key: SCOPES
        value: read_orders,write_orders,read_products,read_customers,read_fulfillments,write_fulfillments,write_returns
      - key: SHOPIFY_APP_URL
        sync: false
      - key: PORTAL_JWT_SECRET
        generateValue: true
      - key: CRON_SECRET
        generateValue: true
      - key: FYND_WEBHOOK_SECRET
        generateValue: true
      - key: ENCRYPTION_KEY
        sync: false
      - key: APP_BILLING_MODE
        value: production
      - key: APP_MANAGED_PRICING_HANDLE
        sync: false
      - key: SUPERADMIN_EMAILS
        sync: false

databases:
  - name: returnpromax-db
    databaseName: returnpromax
    plan: free
```

### Deploy Steps

1. **Create Render Account**: Sign up at [render.com](https://render.com).

2. **Create Blueprint**: Connect your GitHub repo and use the `render.yaml` blueprint, or create resources manually.

3. **Set Environment Variables**: In the Render dashboard, configure all `sync: false` variables (see [Environment Variables](#environment-variables) section below).

4. **Deploy**: Push to the connected branch or trigger a manual deploy.

5. **Verify**: Check the deploy logs for:
   ```
   Prisma schema loaded from prisma/schema.prisma
   Production environment validation passed.
   Applying migration ...
   [backfill] ...
   Listening on port ...
   ```

### Build Pipeline

| Phase        | Command                                     | Duration  |
|--------------|---------------------------------------------|-----------|
| Install      | `npm install`                               | ~30s      |
| Generate     | `npx prisma generate`                       | ~5s       |
| Build        | `npm run build` (React Router)              | ~20s      |
| Env Gate     | `node scripts/validate-production-env.mjs`  | <1s       |
| Preflight    | `npm run preflight:production -- --skip-network` | <1s |
| DB Migrate   | `npx prisma migrate deploy`                 | ~5s       |
| Backfill     | 3 backfill scripts (see below)              | ~10s      |
| Start        | `react-router-serve ./build/server/index.js`| Immediate |

### Node.js Version

The app requires Node.js >= 22.12 (specified in `package.json` engines).

---

## Shopify Partner Configuration

### App Setup

1. **Create App** in [Shopify Partners Dashboard](https://partners.shopify.com).

2. **App URL**: Set to your Render URL (e.g., `https://returnpromax.onrender.com`).

3. **Allowed redirection URLs**: Add:
   ```
   https://returnpromax.onrender.com/auth/callback
   https://returnpromax.onrender.com/auth/login
   ```

4. **API Credentials**: Copy the API Key and API Secret to Render environment variables.

5. **Scopes**: Ensure the app requests:
   ```
   read_orders, write_orders, read_products, read_customers,
   read_fulfillments, write_fulfillments, write_returns
   ```

### CLI Commands

| Command                    | Purpose                                    |
|----------------------------|--------------------------------------------|
| `npm run dev`              | Start dev server with Shopify CLI          |
| `npm run dev:local`        | Local dev without Shopify CLI              |
| `npm run deploy`           | Deploy app configuration to Shopify        |
| `npm run config:link`      | Link local project to Shopify app          |
| `npm run generate`         | Generate app extension scaffolding         |

---

## Environment Variables

### Required Variables

| Variable            | Description                                          | Example                          |
|---------------------|------------------------------------------------------|----------------------------------|
| `DATABASE_URL`      | PostgreSQL connection string                         | `postgresql://user:pass@host:5432/db` |
| `SHOPIFY_API_KEY`   | Shopify app API key                                  | `abc123def456`                   |
| `SHOPIFY_API_SECRET`| Shopify app API secret                               | `shpss_abc123...`                |
| `SHOPIFY_APP_URL`   | Public URL of the deployed app                       | `https://returnpromax.onrender.com` |
| `SCOPES`            | Shopify OAuth scopes                                 | `read_orders,write_orders`       |
| `PORTAL_JWT_SECRET` | Secret for signing portal JWT tokens                 | 64 hex characters                |
| `ENCRYPTION_KEY`    | AES encryption key for Fynd credentials              | 64 hex characters                |
| `REDIS_URL`         | Optional Redis connection string for rate limiting; Postgres is used when unset | `rediss://...`                   |
| `CRON_SECRET`       | Secret for scheduled/cron endpoints                  | 32+ random characters            |
| `FYND_WEBHOOK_SECRET` | Secret for legacy/global Fynd webhook authentication | 32+ random characters          |

### Optional Variables

| Variable            | Description                                          | Default      |
|---------------------|------------------------------------------------------|--------------|
| `NODE_ENV`          | Environment mode                                     | `production` |
| `PORT`              | Server port                                          | `3000`       |

### Generating Secrets

```bash
# Generate PORTAL_JWT_SECRET
openssl rand -hex 32

# Generate ENCRYPTION_KEY
openssl rand -hex 32

# Generate CRON_SECRET / FYND_WEBHOOK_SECRET
openssl rand -hex 32

# Validate encryption key format
npm run validate:key
```

### Security Notes

- Never commit `.env` files to source control.
- Production startup validates required environment variables before serving traffic.
- `SHOPIFY_APP_URL` must be an origin-only `https://` URL on a stable public hostname. Localhost, private IPs, `.local`, and placeholder `example.com` hosts are rejected in production.
- Use Kubernetes Secrets or your platform secret manager; do not put secrets in ConfigMaps, FIK values, Helm values, or plain env files.
- `ENCRYPTION_KEY` encrypts Fynd credentials at rest. Changing it invalidates all stored credentials.
- `PORTAL_JWT_SECRET` signs portal session tokens. Changing it invalidates all active portal sessions.
- See `docs/22-operational-readiness.md` for probes, Redis, backups, alerts, and rotation runbooks.

---

## Database

### Provider

PostgreSQL (required). Supported options:
- **Render Managed PostgreSQL** (recommended for production)
- **Neon** (free tier for development)
- **Supabase** (free tier for development)
- Any PostgreSQL 14+ instance

### Migrations

ReturnProMax uses Prisma migrations for production schema changes:

```bash
# Create and test a migration locally
npx prisma migrate dev --name description

# Apply migrations in production
npx prisma migrate deploy

# Generate Prisma client
npx prisma generate
```

The `npm run setup` script combines both generate and migrate:

```bash
npm run setup  # prisma generate && prisma migrate deploy
```

### Schema Overview

| Model                | Records    | Description                            |
|----------------------|------------|----------------------------------------|
| `Session`            | Per session| Shopify admin sessions                 |
| `Shop`               | Per store  | Installed shops                        |
| `ShopSettings`       | Per store  | All configuration (60+ fields)         |
| `ReturnCase`         | Per return | Return request cases                   |
| `ReturnItem`         | Per item   | Line items within a return             |
| `ReturnEvent`        | Per event  | Audit trail of return status changes   |
| `FyndWebhookLog`     | Per webhook| Inbound Fynd webhook log               |
| `FyndOrderMapping`   | Per order  | Shopify-to-Fynd order ID mapping cache |
| `LookupSession`      | Per lookup | Portal lookup sessions (OTP, JWT)      |
| `BlocklistEntry`     | Per entry  | Customer blocklist entries             |
| `NotificationLog`    | Per send   | Email/WhatsApp notification log        |
| `ApiKey`             | Per key    | External API keys                      |
| `WebhookSubscription`| Per sub    | Outbound webhook subscriptions         |

---

## Backfill Scripts

Three backfill scripts run automatically on every server start (in the `npm run start` command):

### 1. `scripts/backfill-shopify-order-ids.mjs`

Backfills missing `shopifyOrderId` fields on return cases that were created before the field was added.

### 2. `scripts/backfill-webhook-logs.mjs`

Backfills structured fields on `FyndWebhookLog` records that only have `rawPayload` (from before the handler extracted individual fields).

### 3. `scripts/backfill-customer-info.mjs`

Backfills missing customer information (`customerName`, `customerCity`, `customerCountry`) on return cases from Shopify order data.

All scripts are idempotent and safe to run multiple times. They log progress to stdout.

---

## npm Scripts Reference

| Script               | Command                                                  | Purpose                           |
|----------------------|----------------------------------------------------------|-----------------------------------|
| `build`              | `react-router build`                                     | Build production bundle           |
| `dev`                | `npx shopify app dev`                                    | Development with Shopify CLI      |
| `dev:local`          | `npx prisma generate && npx prisma db push && NODE_OPTIONS='--import ./instrumentation.server.mjs' npm exec react-router dev` | Local dev without Shopify |
| `start`              | `node scripts/validate-production-env.mjs && prisma migrate deploy && node scripts/run-startup-backfills.mjs && react-router-serve ./build/server/index.js` | Production start |
| `setup`              | `prisma generate && prisma migrate deploy`               | Setup database                    |
| `deploy`             | `shopify app deploy`                                     | Deploy app config to Shopify      |
| `config:link`        | `shopify app config link`                                | Link to Shopify app               |
| `validate:key`       | `node scripts/validate-encryption-key.js`                | Validate ENCRYPTION_KEY format    |
| `preflight:production` | `node scripts/production-preflight.mjs`                 | Validate production readiness gates |
| `test:fynd-api`      | `node scripts/test-fynd-apis.mjs`                        | Test Fynd API connectivity        |
| `test:fynd-api:bash` | `./scripts/test-fynd-apis.sh`                            | Test Fynd APIs via curl           |
| `test`               | `vitest run`                                             | Run test suite                    |
| `test:watch`         | `vitest`                                                 | Run tests in watch mode           |

---

## Health Checks

### Render Health Check

Render automatically pings the root URL. The app responds to HTTP requests on the configured port (default 3000).

### Manual Verification

After deployment, verify:

1. **App loads**: Visit `{SHOPIFY_APP_URL}` -- should redirect to Shopify OAuth.
2. **Portal works**: Visit `{SHOPIFY_APP_URL}/portal/{shop-domain}` -- should show the customer portal.
3. **Database**: Check Render logs for Prisma migration output such as "Applying migration" or "No pending migrations to apply".
4. **Fynd webhook**: Configure the webhook URL in Fynd Platform and send a test event.

---

## Troubleshooting Deployment

| Symptom                          | Cause                                    | Fix                                      |
|----------------------------------|------------------------------------------|------------------------------------------|
| Build fails at `prisma generate` | Missing `DATABASE_URL`                   | Set `DATABASE_URL` in Render env vars    |
| 500 on app load                  | Missing `SHOPIFY_API_KEY/SECRET`         | Set Shopify credentials in env vars      |
| Portal JWT errors                | Missing `PORTAL_JWT_SECRET`              | Generate and set a 64-char hex secret    |
| Fynd credentials invalid         | Wrong `ENCRYPTION_KEY`                   | Re-save Fynd credentials after key change|
| DB connection refused             | Wrong `DATABASE_URL` or firewall         | Verify connection string and SSL mode    |
| Node version error               | Node < 22.12                             | Set Node version in Render to 22.x      |

---

## Related Files

| File                  | Purpose                                  |
|-----------------------|------------------------------------------|
| `render.yaml`         | Render Blueprint configuration           |
| `package.json`        | Scripts, dependencies, engine requirements|
| `prisma/schema.prisma`| Database schema                          |
| `.env.example`        | Environment variable template            |
| `scripts/`            | Backfill and utility scripts             |
