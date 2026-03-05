# Fynd Returns — Version Audit (Latest)

All packages updated to **latest versions** as of Feb 2026.

---

## Runtime & Framework

| Component | Version | Notes |
|-----------|---------|-------|
| **Node.js** | >=22.12 | LTS (Jod); use `.nvmrc` (22) |
| **React** | 19.2.4 | Latest |
| **React DOM** | 19.2.4 | Latest |
| **React Router** | 7.13.0 | Latest |
| **TypeScript** | 5.9.3 | Latest 5.x |

---

## Shopify SDK

| Package | Version | API |
|---------|---------|-----|
| **@shopify/shopify-app-react-router** | 1.1.1 | Latest |
| **@shopify/shopify-app-session-storage-prisma** | 8.0.1 | Latest |
| **@shopify/app-bridge-react** | 4.2.10 | Latest |
| **@shopify/shopify-api** (transitive) | 12.3.0 | Latest |
| **GraphQL Admin API** | 2026-01 (January26) | [Latest](https://shopify.dev/docs/api/admin-graphql/latest) |

---

## Database

| Package | Version | Notes |
|---------|---------|-------|
| **Prisma** | 6.19.2 | Latest 6.x (Shopify session storage requires ^6.19) |
| **@prisma/client** | 6.19.2 | Matches Prisma CLI |

*Prisma 7 is available but `@shopify/shopify-app-session-storage-prisma` peer-depends on Prisma 6. Stay on 6.x until Shopify updates.*

---

## Build & Dev

| Package | Version |
|---------|---------|
| **Vite** | 7.3.1 |
| **vite-tsconfig-paths** | 6.1.1 |
| **@react-router/dev** | 7.13.0 |
| **@react-router/fs-routes** | 7.13.0 |
| **@react-router/node** | 7.13.0 |
| **@react-router/serve** | 7.13.0 |

---

## UI

- **Polaris Web Components** (s-app-nav, s-page, s-button, etc.) — loaded via CDN from `@shopify/shopify-app-react-router` AppProvider
- **@shopify/polaris-types** — 1.0.1 for TypeScript definitions

---

## Other

| Package | Version |
|---------|---------|
| **isbot** | 5.1.32 |
| **jsonwebtoken** | 9.0.2 |
| **@types/node** | 22.19.x |
| **@types/react** | 19.2.14 |
| **@types/react-dom** | 19.2.3 |
