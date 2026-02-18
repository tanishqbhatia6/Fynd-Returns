# Return Pro Max

Fynd ↔ Shopify Returns Manager — Enterprise-grade Shopify app using the **latest recommended stack**.

## Stack (Latest, Non-Deprecated)

- **React Router v7** — Full-stack framework
- **@shopify/shopify-app-react-router** — Official Shopify app package (recommended over Express/Remix)
- **Shopify API 2025-10** — Current stable
- **Polaris Web Components** — Modern Shopify UI
- **PostgreSQL + Prisma 6** — Enterprise database
- **Vite 6** — Build tooling

## Features

- **Merchant Admin**: Returns list, detail, settings, Fynd connection
- **Customer Portal** (App Proxy): Lookup by Order #, AWB, email, mobile; OTP verification
- **Shopify + Fynd Integration**: Returns, tracking, status sync

## Quick Start

1. See **[SETUP.md](./SETUP.md)** for setup.
2. `npm install`
3. Configure `.env` (DATABASE_URL, etc.)
4. `npx prisma migrate dev`
5. `npm run dev`
