# Operational Readiness

This is the production checklist for ReturnProMax. Treat it as a release gate,
not as optional documentation.

## Required Runtime Configuration

Startup runs `scripts/validate-production-env.mjs` and exits non-zero if any
critical value is missing or malformed. The validator is strict by default,
including when `NODE_ENV` is unset; it skips only for explicit
`NODE_ENV=development` or `NODE_ENV=test`.

Required:
- `DATABASE_URL`
- `SHOPIFY_API_KEY`
- `SHOPIFY_API_SECRET`
- `SHOPIFY_APP_URL`
- `SCOPES`
- `ENCRYPTION_KEY`
- `PORTAL_JWT_SECRET`
- `CRON_SECRET`
- `FYND_WEBHOOK_SECRET`
- `APP_BILLING_MODE`
- `APP_MANAGED_PRICING_HANDLE`

`SHOPIFY_APP_URL` must be an origin-only `https://` URL with a stable public
hostname. The production validator rejects localhost, private IPs, `.local`, and
`example.com` placeholder hosts because Shopify and Fynd callback URLs must be
reachable from outside the cluster.

Billing:
- `APP_BILLING_MODE` must be `production` or `prod` in production. Leaving it
  unset makes the app billing gate fail open in dev mode, so startup rejects
  that configuration.
- For a temporary non-launch Railway environment only, `APP_BILLING_MODE=dev`
  is allowed when `ALLOW_DEV_BILLING_IN_PRODUCTION=true` is also set. Do not use
  this flag for launch production because it bypasses Shopify Managed Pricing.
- `APP_MANAGED_PRICING_HANDLE` is required for Shopify Managed Pricing.
- Keep `SUPERADMIN_EMAILS` in secret storage if configured. It controls billing
  override access, and startup validates the email list format when present.

Security flags:
- `PORTAL_CSRF_REQUIRED` must not be set to `false` in production.
- If `PORTAL_ALLOWED_ORIGINS` is set, every entry must be an exact origin-only
  `https://` URL on a stable public hostname. Wildcards such as
  `https://*.myshopify.com`, localhost, paths, query strings, and fragments are
  rejected by startup validation.

## Kubernetes Rules

Use `deploy/kubernetes/returnpromax.yaml` as the baseline:
- All sensitive runtime values come from the `returnpromax-secrets` Secret.
- Do not place credentials in ConfigMaps, Helm values, FIK values, or plain env.
- Liveness probe: `/api/healthz`.
- Readiness probe: `/api/readyz`.
- Rolling update uses `maxUnavailable: 0` and `maxSurge: 1`.
- Rate limiting must use a shared backend under horizontal scale. By default it
  uses Postgres via `DATABASE_URL`; `REDIS_URL` is optional.

The public ingress host must be the same stable HTTPS origin configured in:
- `SHOPIFY_APP_URL`
- Shopify app proxy/callback URLs
- Fynd webhook URL
- cron callback configuration

## Production Preflight

Run the preflight before every production deploy:

```bash
npm run preflight:production -- --skip-network
```

This checks the production environment contract, Kubernetes secret references,
probes, rollout strategy, backup manifests, restore tooling, and deployment
workflow gates. It fails if required runtime secrets are missing or malformed.

From an environment that can reach production dependencies, run the stronger
network check:

```bash
npm run preflight:production -- --check-network
```

The network check verifies TCP reachability for `DATABASE_URL`, verifies
`REDIS_URL` only when it is configured, and calls `{SHOPIFY_APP_URL}/api/healthz`
plus `{SHOPIFY_APP_URL}/api/readyz`.
If your CI runner cannot reach private Railway/Kubernetes services, run the
network check from a trusted bastion, release job, or one-off production shell.

## Backups And Restore

Daily backup CronJob template:
- `deploy/kubernetes/postgres-backup-cronjob.yaml`
- S3 uploads use server-side encryption by default (`BACKUP_S3_SSE=AES256`).
  Set `BACKUP_S3_SSE=aws:kms` and `BACKUP_S3_KMS_KEY_ID` when bucket policy
  requires a customer-managed KMS key.

Manual backup:

```bash
DATABASE_URL="postgresql://..." BACKUP_DIR=./backups ./scripts/postgres-backup.sh
```

To upload a manual backup to S3 with encryption:

```bash
DATABASE_URL="postgresql://..." \
BACKUP_BUCKET="returnpromax-prod-backups" \
BACKUP_S3_SSE="AES256" \
./scripts/postgres-backup.sh
```

Restore drill:

```bash
DATABASE_URL="postgresql://..." \
CONFIRM_RESTORE=returnpromax \
./scripts/postgres-restore.sh ./backups/returnpromax-YYYYMMDDTHHMMSSZ.dump
```

Run a restore drill before launch and after every schema-heavy release. This app
stores return cases, shop settings, encrypted credentials, sessions, webhook
logs, and notification logs, so an untested backup is not a backup.

Restore requires a matching `.sha256` file by default. Use
`SKIP_BACKUP_CHECKSUM=true` only for an emergency restore after validating the
dump integrity through another trusted channel.

## Alerts

Wire these OpenTelemetry metrics to your alert backend:
- `fynd.webhook.count`: alert on sustained failures or signature failures.
- `portal.otp.count`: alert on send/verify spikes, `account_locked`, and high
  `invalid_code` rates.
- `http.server.request.count`: alert on 4xx/5xx rate changes by route.
- `redis.health.status` and `redis.failure.total`: alert on Redis failures when
  Redis is configured.
- Rate-limit database query failures: alert on repeated fallback-to-memory logs.
- `health_check.duration` with `dependency=database`: alert on DB failures and
  latency spikes.
- `cron.job.count`: alert when cron jobs return `error`, `partial_error`, or stop
  reporting.
- `fynd.retry_queue.depth` and `fynd.retry_queue.oldest_age_seconds`: alert on
  stuck queue growth.

## Log Redaction Verification

Before launch, run a synthetic request set with fake secrets and PII, then verify
centralized logs do not contain:
- raw OTPs
- portal tokens
- API keys
- Shopify/Fynd bearer tokens
- customer email, phone, or address
- encrypted credential plaintext

The app logger redacts common secret and PII fields, but production logging must
be verified against the actual log sink because collectors can add request
headers or query strings outside app control.

## Secret Rotation

`PORTAL_JWT_SECRET`:
- Generate a new secret with `openssl rand -hex 32`.
- Deploy with the new value.
- Existing portal sessions become invalid; customers must re-verify.

`ENCRYPTION_KEY`:
- Generate the new key.
- Set `ENCRYPTION_KEYS_PREVIOUS=<old>` and `ENCRYPTION_KEY=<new>`.
- Deploy.
- Run `scripts/backfill-rotate-secrets.mjs`.
- Confirm the script reports no undecryptable rows.
- Remove `ENCRYPTION_KEYS_PREVIOUS` and deploy again.

Webhook secrets:
- Use the per-shop rotate action in Settings > Integrations.
- Copy the new secret to Fynd immediately.
- Watch `fynd.webhook.count` and webhook signature failures during the rotation
  window.
- For the legacy/global `/api/webhooks/fynd` receiver, generate a new
  `FYND_WEBHOOK_SECRET` with `openssl rand -hex 32`, update the Kubernetes
  Secret or platform secret manager, update the matching Fynd webhook auth
  header/secret, and roll the deployment.
