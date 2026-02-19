# Security

## Credential handling

### Fynd credentials

- **Storage**: Fynd credentials (Client ID/Secret, Application Token) are stored per shop in `ShopSettings.fyndCredentials`, encrypted with AES-256-GCM.
- **Encryption key**: Set `ENCRYPTION_KEY` in production. Must be 64 hex characters (32 bytes). Generate with: `openssl rand -hex 32`.
- **Dev mode**: In `NODE_ENV=development`, a fallback dev key is used if `ENCRYPTION_KEY` is unset. In production, the app will fail to start without a valid key.

### Input validation

- All credential inputs (Company ID, Application ID, Client ID, Client Secret, Application Token, Custom URL, Policy JSON) are validated and sanitized before save or test.
- Length limits, character restrictions, and URL/JSON format checks prevent injection and oversized payloads.

### Logging

- Debug logs never include credential values. Patterns such as `clientSecret`, `applicationToken`, `Bearer`, and `Basic` auth headers are redacted before logging.

## Environment variables

| Variable | Required (prod) | Description |
|----------|----------------|-------------|
| `ENCRYPTION_KEY` | Yes | 64 hex chars for credential encryption. Generate: `openssl rand -hex 32` |
| `PORTAL_JWT_SECRET` | Yes | JWT signing secret for portal auth. Generate: `openssl rand -hex 32` |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SHOPIFY_API_KEY` | Yes | From Shopify Partner Dashboard |
| `SHOPIFY_API_SECRET` | Yes | From Shopify Partner Dashboard |
| `SCOPES` | Yes | Comma-separated OAuth scopes |
| `SHOPIFY_APP_URL` | Yes | App URL (e.g. `https://your-app.onrender.com`) |

## Deployment checklist

1. Set `ENCRYPTION_KEY` and `PORTAL_JWT_SECRET` with cryptographically secure values.
2. Run `npx prisma migrate deploy` after deploy.
3. Use HTTPS only. Do not expose credentials over HTTP.
4. Rotate `ENCRYPTION_KEY` only when migrating credentials; existing encrypted data will be unreadable with a new key.
