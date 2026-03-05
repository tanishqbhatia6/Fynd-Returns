# Fynd Returns — Setup Guide

Enterprise-grade Fynd ↔ Shopify Returns Manager using the **latest Shopify stack** (React Router v7, Shopify App React Router, Polaris Web Components).

---

## Stack (Latest, Non-Deprecated)

| Component | Technology |
|-----------|------------|
| **Framework** | React Router v7 |
| **Shopify** | @shopify/shopify-app-react-router (recommended) |
| **API Version** | 2025-10 (October25) |
| **Database** | PostgreSQL + Prisma 6 |
| **UI** | Polaris Web Components (s-*) |
| **Build** | Vite 6 |

---

## Prerequisites

- **Node.js 20.19+**
- **Shopify Partner account** + development store
- **Fynd Partner** credentials
- **PostgreSQL** (local or hosted: Neon, Supabase, Railway)

---

## Setup

### 1. Install & Database

```bash
cd returnpromax
npm install
```

Create PostgreSQL database and set `.env`:

```
DATABASE_URL="postgresql://user:password@host:5432/returnpromax"
PORTAL_JWT_SECRET=  # openssl rand -hex 32
ENCRYPTION_KEY=    # 32-byte hex
```

```bash
npx prisma migrate dev --name init
```

### 2. Shopify App

```bash
shopify auth login
shopify app config link
```

Update `shopify.app.toml` with your app URLs after first `npm run dev`.

### 3. Run

```bash
npm run dev
```

---

## Project Structure

```
returnpromax/
├── app/
│   ├── shopify.server.ts    # Shopify auth (October25 API)
│   ├── db.server.ts
│   ├── lib/                 # Encryption, Fynd, portal auth
│   ├── portal/              # Customer portal HTML
│   └── routes/              # File-based routing
│       ├── app._index.tsx   # Returns list
│       ├── app.returns.$id  # Return detail
│       ├── app.settings     # Settings
│       ├── apps.returns     # App Proxy (customer portal)
│       ├── api.portal.*     # Portal API
│       └── webhooks.*
├── prisma/
└── shopify.app.toml
```

---

## Post-Install

1. Open **Settings** in the app
2. Enter Fynd Company ID, Application ID, Access Token
3. Save

---

## Customer Portal

`https://YOUR_STORE.myshopify.com/apps/returns`

Lookup by Order #, Return #, AWB, Email, Mobile. OTP verification (dev: check console for code).
