# Security Architecture

This document covers every security layer in ReturnProMax: authentication, authorization, encryption, rate limiting, CORS, webhook verification, and operational security. It is intended for developers, security auditors, and DevOps engineers.

---

## Table of Contents

1. [Security Overview](#security-overview)
2. [Shopify OAuth (Admin Authentication)](#shopify-oauth-admin-authentication)
3. [Portal Authentication (JWT + OTP)](#portal-authentication-jwt--otp)
4. [External API Key Authentication](#external-api-key-authentication)
5. [AES-256-GCM Encryption at Rest](#aes-256-gcm-encryption-at-rest)
6. [Rate Limiting](#rate-limiting)
7. [CORS Policy](#cors-policy)
8. [HMAC Webhook Verification](#hmac-webhook-verification)
9. [Customer Blocklist](#customer-blocklist)
10. [Environment Variables Security](#environment-variables-security)
11. [Production Security Checklist](#production-security-checklist)

---

## Security Overview

ReturnProMax operates across three trust boundaries, each with its own authentication mechanism:

| Boundary               | Authentication Method           | Implementation File                    |
|------------------------|---------------------------------|----------------------------------------|
| Shopify Admin (merchant) | Shopify OAuth 2.0             | `app/shopify.server.ts`                |
| Customer Portal        | JWT tokens + OTP verification   | `app/lib/portal-auth.server.ts`        |
| External REST API      | API key (`X-API-Key` header)    | `app/lib/api-key-auth.server.ts`       |

All boundaries are additionally protected by rate limiting and, where applicable, CORS restrictions.

---

## Shopify OAuth (Admin Authentication)

**File:** `app/shopify.server.ts`

### How It Works

ReturnProMax uses the `@shopify/shopify-app-react-router` library to implement the standard Shopify OAuth 2.0 flow. The library handles:

1. **Installation redirect** -- Merchant clicks "Install" in the Shopify App Store; the app redirects to Shopify's OAuth consent screen.
2. **Callback verification** -- Shopify redirects back with an authorization code. The library verifies the HMAC signature and exchanges the code for an access token.
3. **Session storage** -- Access tokens are stored in the `Session` model via `PrismaSessionStorage`. Both online (user-scoped) and offline (shop-scoped) sessions are supported.
4. **Token refresh** -- When `expiringOfflineAccessTokens` is enabled (which it is), the library handles automatic token refresh via `refreshToken` and `refreshTokenExpires`.

### Scopes

Scopes are configured via the `SCOPES` environment variable (comma-separated). Typical scopes include:

- `read_orders`, `write_orders` -- Order data access
- `read_products` -- Product data for return eligibility
- `read_customers`, `write_customers` -- Customer data and store credit

### Webhook Registration

After successful OAuth, the `afterAuth` hook automatically registers Shopify webhooks:

- `ORDERS_CREATE` -> `/webhooks/orders/create`
- `ORDERS_FULFILLED` -> `/webhooks/orders/fulfilled`
- `ORDERS_UPDATED` -> `/webhooks/orders/updated`

Shopify signs all webhook payloads with HMAC-SHA256 using the app's API secret key. The library verifies these signatures automatically before the webhook handler runs.

### Session Verification

Every admin route calls `authenticate.admin(request)` which:

1. Checks for a valid session cookie
2. Verifies the session hasn't expired
3. Returns the session with the shop domain and access token
4. Redirects to OAuth if the session is missing or invalid

---

## Portal Authentication (JWT + OTP)

**File:** `app/lib/portal-auth.server.ts`

The customer-facing portal uses a two-step authentication flow:

### Step 1: Order Lookup

The customer provides an order number, email, phone, or return request number. The system:

1. Normalizes and SHA-256 hashes the lookup value via `hashLookupValue()`.
2. Creates a `LookupSession` record with the hashed value, matched return IDs, and an expiry time.

### Step 2: OTP Verification

Customer-facing portal lookups require verified identity by default. Email OTP is enabled by default through `portalOtpEmailEnabled` in `ShopSettings`; `portalOtpSmsEnabled` is a locked-on schema field, but phone OTP starts fail closed until a real SMS/WhatsApp OTP delivery path is implemented and verified:

1. An OTP is sent to the customer's email.
2. The OTP is bcrypt-hashed before storage in `otpTarget`; raw OTPs are never persisted.
3. The `LookupSession` records `otpSentAt` and `attemptsCount` for cooldown and lockout enforcement.
4. On successful verification, `verifiedAt` is set and `otpTarget` is cleared. Legacy SHA-256 OTP hashes are accepted only for pre-rollout sessions and upgraded on successful verification.

### Step 3: JWT Token Issuance

After successful lookup (and OTP verification if required), a JWT is issued:

```typescript
createPortalToken(payload)  // Signs with PORTAL_JWT_SECRET, 1-hour TTL
```

**Token properties:**
- **Algorithm:** HS256 (HMAC-SHA256)
- **TTL:** 1 hour (`TOKEN_TTL = "1h"`)
- **Secret:** `PORTAL_JWT_SECRET` environment variable (minimum 32 characters in production)
- **Claims:** Custom payload including shop ID, lookup session ID, and matched returns

### Token Verification

Subsequent portal API calls include the JWT in the `Authorization` header. Sensitive portal endpoints must use `verifyPortalSession()`, not only the low-level JWT decoder. The session verifier checks:

- the JWT signature and expiry
- the `LookupSession` row still exists
- the session is verified
- the stored token matches the presented token
- the session is not expired
- the session shop and lookup claims match the request scope

### Session Cleanup

The `cleanupExpiredSessions()` function removes `LookupSession` records older than 7 days. This should be called periodically (cron or app startup) to prevent table bloat.

### Lookup Value Hashing

Customer identifiers are hashed before storage or comparison:

```typescript
hashLookupValue(value) // SHA-256 of lowercased, trimmed input
```

This ensures that the raw customer email/phone is not stored in the lookup session table.

---

## External API Key Authentication

**File:** `app/lib/api-key-auth.server.ts`

### Key Format

```
rpm_ + 40 hex characters (160-bit entropy)
Example: rpm_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2
```

### Key Generation

```typescript
const random = crypto.randomBytes(20).toString("hex"); // 40 hex chars
const fullKey = `rpm_${random}`;
const keyHash = await bcrypt.hash(fullKey, 10);         // bcrypt, 10 rounds
```

The full key is shown to the user exactly once. Only the bcrypt hash and an 8-character prefix (`keyPrefix`) are persisted in the `ApiKey` model.

### Authentication Flow

1. Extract `X-API-Key` from the request header.
2. Extract the first 8 characters as `prefix`.
3. Query `ApiKey` records where `keyPrefix = prefix`, `isActive = true`, and `revokedAt = null`. This is an indexed lookup.
4. For each candidate, run `bcrypt.compare(apiKey, candidate.keyHash)`.
5. On match, parse the `permissions` JSON array and verify the required permission is present.
6. Update `lastUsedAt` (fire-and-forget, non-blocking).

### Permissions

| Permission         | Grants access to                              |
|--------------------|-----------------------------------------------|
| `read_returns`     | List and view return cases                    |
| `write_returns`    | Approve, reject, refund returns               |
| `read_settings`    | Read shop settings                            |
| `manage_webhooks`  | Create, update, delete webhook subscriptions  |

### Error Responses

| Condition              | HTTP Status | Error Code    |
|------------------------|-------------|---------------|
| Missing `X-API-Key`    | 401         | `UNAUTHORIZED`|
| Invalid key            | 401         | `UNAUTHORIZED`|
| Key lacks permission   | 403         | `FORBIDDEN`   |

### Key Revocation

Keys are soft-deleted by setting `revokedAt` to the current timestamp. Revoked keys are excluded from authentication queries by the `revokedAt: null` filter.

---

## AES-256-GCM Encryption at Rest

**File:** `app/lib/encryption.server.ts`

Sensitive credentials (e.g., Fynd API credentials in `ShopSettings.fyndCredentials`) are encrypted at rest using AES-256-GCM.

### Algorithm Details

| Parameter        | Value                                          |
|------------------|------------------------------------------------|
| Algorithm        | `aes-256-gcm`                                  |
| Key length       | 256 bits (32 bytes, 64 hex characters)         |
| IV length        | 128 bits (16 bytes, randomly generated)        |
| Authentication   | GCM authentication tag (integrity verification)|

### Encrypted Format

The encrypted output is a colon-separated string:

```
<iv_hex>:<auth_tag_hex>:<ciphertext_hex>
```

Example:
```
a1b2c3d4e5f6a7b8c9d0e1f2:f1e2d3c4b5a6978800112233:4455667788...
```

### Key Management

- **Production:** The `ENCRYPTION_KEY` environment variable must be exactly 64 hex characters (32 bytes). The app throws a fatal error on startup if this is missing or malformed.
- **Development:** If `NODE_ENV=development` and no key is set, a deterministic dev-only key is used with a structured warning.
- **Key generation command:** `openssl rand -hex 32`

### Security Properties

- **Confidentiality:** AES-256 encryption prevents reading credentials without the key.
- **Integrity:** GCM authentication tag detects any tampering with the ciphertext.
- **IV uniqueness:** A fresh random IV is generated for every `encrypt()` call, ensuring identical plaintext produces different ciphertext.

---

## Rate Limiting

**File:** `app/lib/rate-limit.server.ts`

### Architecture

In-memory sliding window counter. Each key is composed of `IP:shopDomain:endpoint`. Entries auto-expire after their window elapses.

> **Note:** The in-memory store is suitable for single-instance deployments. Enterprise/multi-instance deployments should replace this with a Redis-backed implementation.

### Per-Endpoint Limits

| Endpoint                     | Max Requests | Window      | Purpose                        |
|------------------------------|-------------|-------------|--------------------------------|
| `portal.lookup`              | 30          | 1 minute    | Order lookup                   |
| `portal.order`               | 30          | 1 minute    | Order detail fetch             |
| `portal.create-return`       | 5           | 5 minutes   | Return submission              |
| `portal.otp.send`            | 5           | 5 minutes   | OTP dispatch                   |
| `portal.otp.verify`          | 10          | 1 minute    | OTP verification               |
| `portal.returns`             | 30          | 1 minute    | Return status queries          |
| `external.returns.list`      | 120         | 1 minute    | API: list returns              |
| `external.returns.detail`    | 120         | 1 minute    | API: return detail             |
| `external.settings`          | 120         | 1 minute    | API: read settings             |
| `external.returns.approve`   | 30          | 1 minute    | API: approve return            |
| `external.returns.reject`    | 30          | 1 minute    | API: reject return             |
| `external.returns.refund`    | 30          | 1 minute    | API: issue refund              |
| `external.webhooks`          | 10          | 1 minute    | API: webhook management        |
| `external.postman`           | 10          | 1 minute    | Postman collection endpoint    |
| `default`                    | 60          | 1 minute    | All other endpoints            |

### Rate Limit Response

When a client exceeds the limit, the server responds with:

- **HTTP 429 Too Many Requests**
- `Retry-After` header with the number of seconds until the window resets
- JSON body: `{ "error": "Too many requests. Please try again shortly." }`

### Client Identification

The client key is derived from:

1. `X-Forwarded-For` header (first IP in the chain), or `"unknown"` if absent
2. `shop` query parameter, or `"global"` if absent
3. Endpoint identifier

This means rate limits are per-IP, per-shop, per-endpoint.

### Memory Management

A cleanup interval runs every 5 minutes, purging expired entries from the in-memory store to prevent unbounded memory growth.

---

## CORS Policy

**File:** `app/lib/portal-cors.server.ts`

The customer portal runs on the merchant's Shopify storefront domain and makes cross-origin requests to the ReturnProMax app domain. CORS headers control which origins are allowed.

### Allowed Origins

**Production:**

| Source                                  | Example                              |
|-----------------------------------------|--------------------------------------|
| Exact `?shop=` storefront origin         | `https://my-store.myshopify.com`     |
| Exact `PORTAL_ALLOWED_ORIGINS` entries   | `https://returns.brand.com`          |

Production must not use broad `*.myshopify.com` or `*.shopify.com` CORS
patterns. The portal API derives the expected storefront origin from the
normalized `shop` query parameter and reflects only that exact origin, unless an
explicit origin is configured in `PORTAL_ALLOWED_ORIGINS`.

**Development only (NODE_ENV !== "production"):**

| Pattern                   | Example                       |
|---------------------------|-------------------------------|
| `localhost:<any-port>`    | `http://localhost:3000`        |
| `127.0.0.1:<any-port>`   | `http://127.0.0.1:8080`       |

### CORS Headers

| Header                           | Value                              |
|----------------------------------|------------------------------------|
| `Access-Control-Allow-Origin`    | Reflected origin (if allowed)      |
| `Vary`                           | `Origin`                           |
| `Access-Control-Allow-Methods`   | `GET, POST, OPTIONS`               |
| `Access-Control-Allow-Headers`   | `Content-Type, Authorization, X-Portal-Token` |
| `Access-Control-Max-Age`         | `86400` (24 hours preflight cache) |

### Implementation

- `getPortalCorsHeaders(request)` -- Generates CORS headers based on the request's `Origin`.
- `withCors(response, request)` -- Clones a response and adds CORS headers.

Origins that do not match any allowed pattern receive no `Access-Control-Allow-Origin` header, causing the browser to block the request.

---

## HMAC Webhook Verification

### Inbound Webhooks (from Shopify)

Shopify signs all webhook payloads with HMAC-SHA256 using the app's `SHOPIFY_API_SECRET`. The `@shopify/shopify-app-react-router` library automatically verifies these signatures before any webhook handler executes. Invalid signatures result in a 401 response.

### Inbound Webhooks (from Fynd)

Fynd webhook payloads arrive at `/api/webhooks/fynd`. Verification is handled at the application level.

### Outbound Webhooks (to external subscribers)

**File:** `app/lib/webhook-dispatch.server.ts`

When ReturnProMax dispatches events to registered `WebhookSubscription` endpoints:

1. The JSON payload is serialized.
2. An HMAC-SHA256 signature is computed using the subscription's `secret` field.
3. The signature is sent in the `X-RPM-Signature` header with a `sha256=` prefix.

**Signature format:**
```
X-RPM-Signature: sha256=<hex-digest>
```

**Verification example (recipient side):**
```javascript
const crypto = require('crypto');
const expected = 'sha256=' + crypto
  .createHmac('sha256', webhookSecret)
  .update(rawBody)
  .digest('hex');
const valid = crypto.timingSafeEqual(
  Buffer.from(expected),
  Buffer.from(receivedSignature)
);
```

**Additional headers sent with each outbound webhook:**

| Header           | Value                                          |
|------------------|------------------------------------------------|
| `Content-Type`   | `application/json`                             |
| `X-RPM-Signature`| `sha256=<hmac-hex>`                            |
| `X-RPM-Event`    | Event type (e.g., `return.created`)            |

### Delivery Guarantees

- **Timeout:** 10 seconds per attempt
- **Retry policy:** Up to 3 total attempts (initial + 2 retries)
- **Retry delays:** 30 seconds, then 2 minutes (exponential backoff)
- **Failure handling:** Fire-and-forget; failures after all retries are logged to console but do not block the main flow

---

## Customer Blocklist

**Models:** `ShopSettings.blocklistEnabled`, `BlocklistEntry`

### How It Works

When `blocklistEnabled` is `true`, the portal checks incoming return requests against the shop's blocklist before processing.

### Blocklist Types

| Type          | What is matched                                 |
|---------------|------------------------------------------------|
| `email`       | Customer email (normalized to lowercase)        |
| `phone`       | Customer phone number (normalized)              |
| `order_name`  | Shopify order name (e.g., `#1001`)              |
| `ip`          | Client IP address                               |

### Enforcement

- Entries are stored in `BlocklistEntry` with a unique constraint on `(settingsId, type, value)`.
- Each entry can have an optional `reason` and `blockedBy` (admin identifier).
- Blocked customers receive a generic error message; no information is leaked about why the block occurred.

---

## Environment Variables Security

The following environment variables contain sensitive material and must be protected:

| Variable              | Purpose                              | Requirements                           |
|-----------------------|--------------------------------------|----------------------------------------|
| `SHOPIFY_API_KEY`     | Shopify app API key                  | Provided by Shopify Partners           |
| `SHOPIFY_API_SECRET`  | Shopify app API secret               | Never expose in client code            |
| `PORTAL_JWT_SECRET`   | Signs portal JWT tokens              | Minimum 32 characters in production    |
| `ENCRYPTION_KEY`      | AES-256-GCM encryption key           | Exactly 64 hex characters (32 bytes)   |
| `DATABASE_URL`        | PostgreSQL connection string         | Use SSL in production                  |
| `SCOPES`              | Shopify OAuth scopes                 | Comma-separated, least-privilege       |
| `SHOPIFY_APP_URL`     | App base URL                         | Must be HTTPS in production            |
| `FYND_WEBHOOK_SECRET` | Legacy/global Fynd webhook secret    | Minimum 32 characters in production    |

### Generation Commands

```bash
# Generate PORTAL_JWT_SECRET (32+ random characters)
openssl rand -base64 48

# Generate ENCRYPTION_KEY (64 hex characters = 32 bytes)
openssl rand -hex 32

# Generate FYND_WEBHOOK_SECRET
openssl rand -hex 32
```

### Best Practices

- Never commit `.env` files to version control. The `.gitignore` should include `.env*`.
- Use a secrets manager (e.g., AWS Secrets Manager, Vault, Doppler) in production.
- Rotate `ENCRYPTION_KEY` and `PORTAL_JWT_SECRET` periodically. Note that rotating `ENCRYPTION_KEY` requires re-encrypting all stored credentials.
- Use separate keys for staging and production environments.

---

## Production Security Checklist

Use this checklist before deploying to production:

### Authentication & Secrets

- [ ] `PORTAL_JWT_SECRET` is set and at least 32 characters long
- [ ] `ENCRYPTION_KEY` is set and exactly 64 hex characters
- [ ] `SHOPIFY_API_SECRET` is set and matches the Shopify Partners dashboard
- [ ] `DATABASE_URL` uses SSL (`?sslmode=require` or equivalent)
- [ ] Rate limits use a shared backend in production. Postgres is the default; `REDIS_URL` is optional.
- [ ] `SCOPES` is set to the least-privilege Shopify OAuth scopes required by the app
- [ ] `APP_BILLING_MODE` is `production` or `prod` so billing cannot fail open
- [ ] `APP_MANAGED_PRICING_HANDLE` is set for Shopify Managed Pricing
- [ ] `PORTAL_CSRF_REQUIRED` is not set to `false` in production
- [ ] `FYND_WEBHOOK_SECRET` is set for the legacy/global Fynd webhook receiver, and per-shop webhook secrets are generated for shop-specific callbacks
- [ ] `PORTAL_ALLOWED_ORIGINS`, if set, contains only exact origin-only public `https://` URLs with no wildcards
- [ ] All secrets are managed via a secrets manager, not plaintext config files
- [ ] No secrets are committed to the repository

### Network & Transport

- [ ] `SHOPIFY_APP_URL` is an origin-only HTTPS URL on a stable public hostname
- [ ] Portal CORS allows only the exact shop origin or explicitly configured trusted origins
- [ ] All outbound webhook subscriptions use HTTPS URLs
- [ ] Fynd API connections use HTTPS

### Rate Limiting

- [ ] Rate limiting is active on all portal and external API endpoints
- [ ] Postgres-backed or Redis-backed rate limiting is enabled for all production deployments
- [ ] OTP endpoints are tightly limited (5 requests per 5 minutes)

### Data Protection

- [ ] Fynd credentials are encrypted at rest (`fyndCredentials` field)
- [ ] SMTP passwords are stored securely (consider encrypting `smtpPass`)
- [ ] WhatsApp API keys are stored securely (consider encrypting `whatsappApiKey`)
- [ ] Customer lookup values are SHA-256 hashed before storage
- [ ] Portal OTPs are bcrypt-hashed before storage and cleared after successful verification
- [ ] Expired `LookupSession` records are cleaned up periodically

### API Keys

- [ ] API keys are bcrypt-hashed before storage (10 rounds)
- [ ] Full API keys are shown exactly once at creation time
- [ ] Revoked keys have `revokedAt` set and are excluded from auth queries
- [ ] API key permissions follow least-privilege principle

### Webhook Security

- [ ] Shopify webhook HMAC verification is handled by the Shopify library (automatic)
- [ ] Outbound webhooks are signed with HMAC-SHA256 (`X-RPM-Signature`)
- [ ] Webhook subscription secrets are unique per subscription
- [ ] Webhook delivery uses a 10-second timeout to prevent slowloris attacks

### Monitoring

- [ ] Failed authentication attempts are logged
- [ ] Rate limit violations are trackable
- [ ] `FyndWebhookLog` captures all inbound webhook activity
- [ ] `NotificationLog` records all notification delivery attempts
- [ ] `ReturnEvent` provides a complete audit trail for every return action

### Shopify-Specific

- [ ] OAuth scopes follow least-privilege (`SCOPES` env var)
- [ ] Webhook registrations are re-registered on every `afterAuth` (idempotent)
- [ ] `Session` model supports both online and offline tokens
- [ ] Token refresh is enabled (`expiringOfflineAccessTokens: true`)

---

## Threat Model Summary

| Threat                          | Mitigation                                                        |
|---------------------------------|-------------------------------------------------------------------|
| Session hijacking               | Shopify OAuth with HMAC-verified callbacks; HTTP-only cookies     |
| Portal token theft              | JWT with 1-hour TTL; OTP verification                             |
| API key compromise              | bcrypt-hashed storage; key prefix lookup; revocation support      |
| Credential exposure at rest     | AES-256-GCM encryption for Fynd credentials                      |
| Brute-force attacks             | Rate limiting on all endpoints; OTP attempt counting              |
| Cross-origin attacks            | Strict CORS policy; origin allowlist validation                   |
| Webhook spoofing (inbound)      | HMAC-SHA256 verification for Shopify webhooks                     |
| Webhook spoofing (outbound)     | HMAC-SHA256 signature on all outbound webhooks                    |
| Abusive customers               | Blocklist feature (email, phone, order, IP)                       |
| Replay attacks                  | JWT `iat` claim; unique IVs for encryption; session expiry        |
| SQL injection                   | Prisma ORM with parameterized queries (no raw SQL)                |
| Denial of service               | Per-endpoint rate limiting; webhook delivery timeouts             |

---

*Last updated: 2026-03-12*
