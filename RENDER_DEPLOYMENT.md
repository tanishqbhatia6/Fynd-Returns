# Return Pro Max — Render Deployment Guide

Complete checklist for deploying to Render and configuring Shopify.

---

## Part 1: Code & Project Changes

### 1.1 Database (PostgreSQL)

The app uses **PostgreSQL** on Render. The start command runs `prisma db push` to sync the schema on each deploy (no migrations needed for initial setup).

### 1.2 Render Build & Start Commands

In **Render Dashboard → Your Web Service → Settings**:

| Setting | Value |
|---------|-------|
| **Root Directory** | Leave **empty** (or `.`) if `package.json` is at repo root. If your repo has the app in a subfolder (e.g. `returnpromax/`), set it to that folder name. |
| **Build Command** | `npm install && npx prisma generate && npm run build` |
| **Start Command** | `npx prisma db push && npm run start` |

**Important:** Do NOT use `npm --prefix frontend` — this project has no `frontend` folder. The build runs from the project root.

### 1.3 Environment Variables (Render Dashboard)

Add these in **Render → Your Service → Environment**:

| Variable | Value | Notes |
|----------|-------|-------|
| `DATABASE_URL` | (auto from Render PostgreSQL) | Or paste Internal Database URL |
| `SHOPIFY_API_KEY` | Your app's Client ID | From Partner Dashboard |
| `SHOPIFY_API_SECRET` | Your app's Client secret | From Partner Dashboard |
| `SCOPES` | `read_orders,write_orders,read_products,read_customers,read_fulfillments,write_fulfillments,write_returns` | Comma-separated |
| `SHOPIFY_APP_URL` | `https://YOUR-APP-NAME.onrender.com` | Your Render URL (no trailing slash) |
| `PORTAL_JWT_SECRET` | Random 32-byte hex | Run: `openssl rand -hex 32` |
| `ENCRYPTION_KEY` | 64-char hex | Run: `openssl rand -hex 32` (use 64 chars) |

**Optional:**
- `FYND_API_BASE_URL` — defaults to `https://api.fynd.com`

---

## Part 2: Shopify Partner Dashboard Changes

After your app is live on Render, update these in **Partner Dashboard → Apps → [Your App] → Configuration**:

### 2.1 App URL

| Field | Value |
|-------|-------|
| **App URL** | `https://YOUR-APP-NAME.onrender.com` |

Replace with your actual Render URL (e.g. `https://returnpromax.onrender.com`).

### 2.2 Redirect URLs

Add (comma-separated):

```
https://YOUR-APP-NAME.onrender.com/auth/callback, https://YOUR-APP-NAME.onrender.com/auth/shopify/callback
```

### 2.3 App Proxy

Expand **App proxy** and set:

| Field | Value |
|-------|-------|
| **Subpath prefix** | `apps` |
| **Subpath** | `returns` |
| **Proxy URL** | `https://YOUR-APP-NAME.onrender.com/apps/returns` |

### 2.4 Webhooks

Webhook URIs are relative (`/webhooks/app/uninstalled`, etc.). They will use your App URL automatically. No changes needed if App URL is correct.

### 2.5 Scopes

Ensure these are selected:

`read_orders`, `write_orders`, `read_products`, `read_customers`, `read_fulfillments`, `write_fulfillments`, `write_returns`

---

## Part 3: shopify.app.toml (Optional)

If you use `shopify app deploy`, update placeholders:

```toml
client_id = "YOUR_ACTUAL_CLIENT_ID"
application_url = "https://YOUR-APP-NAME.onrender.com"

[auth]
redirect_urls = [
  "https://YOUR-APP-NAME.onrender.com/auth/callback",
  "https://YOUR-APP-NAME.onrender.com/auth/shopify/callback"
]

[app_proxy]
url = "https://YOUR-APP-NAME.onrender.com/apps/returns"
```

---

## Part 4: First Deploy Checklist

1. [ ] Create PostgreSQL database on Render (Dashboard → New → PostgreSQL, or use `render.yaml`)
2. [ ] Set all environment variables in Render (see Part 1.3)
3. [ ] Deploy the app
4. [ ] Update Partner Dashboard: App URL, Redirect URLs, App Proxy (see Part 2)
5. [ ] Reinstall the app on a test store (or update URLs and re-authorize)
6. [ ] Test: Admin UI, Settings, Customer portal at `https://STORE.myshopify.com/apps/returns`

---

## Part 5: Local Development After Production

For local dev, use one of:

- **Neon** (free): https://neon.tech — create DB, copy connection string
- **Supabase** (free): https://supabase.com
- **Render PostgreSQL**: Use the External URL (not Internal) for local access

```bash
# .env (local)
DATABASE_URL="postgresql://user:pass@host:5432/returnpromax?sslmode=require"
SHOPIFY_APP_URL=http://localhost:3000
# ... rest from Partner Dashboard
```

Run `npm run dev:local` for local development.
