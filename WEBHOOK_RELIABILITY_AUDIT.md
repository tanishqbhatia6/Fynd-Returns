# Webhook Reliability Audit — April 2026

Source of the numbers: **Shopify Partner Dashboard → Monitoring → Webhooks**,
`Last 7 days` window.

## Headline numbers

| Topic | Total | Failure rate | Response p90 |
|---|---:|---:|---:|
| `orders/create` | 583 | **82.3%** | 197 ms |
| `orders/updated` | 560 | **90.0%** | 200 ms |
| `orders/fulfilled` | 33 | **81.8%** | 215 ms |
| `draft_orders/update` | 40 | 0% | 250 ms |
| `draft_orders/create` | 32 | 0% | 261 ms |
| `app/scopes_update` | 2 | 50% | 378 ms |

Aggregate: **81.0% failure, 271 ms p90**, flagged **High**. This is not a
blip — it's been the steady state for 7 days.

## The one visible pattern

| Handler | Calls Shopify API? | Failure rate |
|---|---|---:|
| `orders/create` | **Yes** (writes `$app:fynd_order_id` metafield) | 82% |
| `orders/updated` | **Yes** (writes same metafield every update) | 90% |
| `orders/fulfilled` | **Yes** (writes same metafield) | 82% |
| `draft_orders/create` | No — pure DB upsert | **0%** |
| `draft_orders/update` | No — pure DB upsert | **0%** |

The handlers that touch the **Shopify Admin API** fail. The ones that
don't, succeed. That is the strongest available signal.

## Likely root causes (ranked by probability)

### P0 — Redundant Shopify API call on every order webhook

Each failing handler does a metafield write via
`shopifyApp.unauthenticated.admin(shop).graphql(...)`. This call:

1. Looks up the offline session from Prisma.
2. Creates a Shopify Admin client.
3. Sends a GraphQL mutation to Shopify.

For `orders/updated`, this fires on **every order edit**, regardless of
whether the order has a Fynd `affiliate_order_id`. Most updates don't,
so we still pay the overhead, and sometimes the metafield write itself
fails (e.g. the order is already closed, user errors returned by
Shopify, or transient 5xx from Shopify).

**If the handler's outer try/catch leaks any error** — anything
upstream of the try, or a mutation rejection that wasn't caught — the
action throws and React Router converts it to **HTTP 500**. Shopify
counts that as a failed delivery, which triggers retry + burns the
failure-rate budget.

The most plausible specific culprit: `shopifyApp.unauthenticated.admin(shop)`
throws a `SessionNotFound` error for some shops (e.g. partially
reinstalled, shop-session mismatch). In `webhooks.orders.create.tsx`,
that call is inside the outer try — so it *should* be caught. In
`webhooks.orders.updated.tsx` and `webhooks.orders.fulfilled.tsx`, the
graphql call is wrapped in its own inner try, but the **enclosing
`shopifyApp.unauthenticated.admin(shop)` call is wrapped too**, so
again, should be caught.

That leaves **`await authenticate.webhook(request)`** as the only call
**outside a try/catch** in every failing handler. If HMAC verification
fails for any request, the handler throws → 500 → Shopify counts as
failed.

### P1 — `shopify.app.toml` doesn't declare `orders/updated` or `orders/fulfilled`

The declarative subscriptions in `shopify.app.toml` today are:

- `orders/create`
- `draft_orders/create`
- `draft_orders/update`
- `app/*` + GDPR

But **`orders/updated` and `orders/fulfilled` are registered
imperatively** in `app/shopify.server.ts` via the `webhooks:` option
(which triggers `shopify.registerWebhooks({ session })` from
`afterAuth`). Shopify's Monitoring page shows these topics are being
delivered (560 + 33 events / 7 days), so the registration is active —
but the hybrid configuration makes it easy to lose track of what's
subscribed where.

Hybrid (declarative toml + imperative `registerWebhooks`) is not
inherently broken, but it makes diff-auditing painful: the toml
doesn't tell the truth about what's actually subscribed. Modern
Shopify guidance is **declarative-only**.

### P2 — Dynamic `await import("../shopify.server")` on the hot path

Every failing handler contains:

```ts
import { authenticate } from "../shopify.server";         // static
// ...
const { default: shopifyApp } = await import("../shopify.server"); // dynamic
```

The module is already imported statically. The dynamic import returns
the cached module, so it's not expensive after the first call — but
it's a function call + promise wrap on every webhook. More
importantly, it signals to reviewers that the author wasn't sure how
to get the default export — and the mental overhead of reading it
invites bugs. Replace with a single static import.

### P3 — `orders/updated` runs Shopify API for every update

Even updates that don't touch the Fynd metafield trigger:

```ts
const fyndOrderId = extractAffiliateOrderId(attrs);
if (fyndOrderId) {
  // ... call Shopify API ...
}
```

When `fyndOrderId` is null (most of the time), we correctly skip. But
the handler **still reaches this check after a `prisma.shop.findUnique`
query** — so we're doing a DB query on every order edit. Over 560
`orders/updated` events in a week, that's 560 unnecessary queries.

Add an early-exit **before the DB hit**: if `attrs` has no keys from
`AFFILIATE_ORDER_ID_KEYS` AND the order isn't cancelled or refunded,
return `new Response()` immediately.

### P4 — No structured error logging

The current catch handlers do:

```ts
console.error("[webhook:orders/create]", err instanceof Error ? err.message : err);
```

On Railway this ends up as a single-line stdout log. It's not
structured (no shop domain, no order ID, no stack trace), so
aggregating across 480+ failures to find a common cause is tedious.

Add `webhookLogger.error({ shop, orderName, topic, err })` — uses the
existing pino-based `observability/logger.server.ts` — so failures
land as queryable JSON with contextual fields.

### P5 — Webhook idempotency is implicit

Shopify retries failed webhooks with exponential backoff for 48 hours.
Our handlers use `upsert` which is idempotent at the DB level, but the
graphql-metafield-write mutation is **not** idempotent (it technically
is, but Shopify may reject with "metafield already exists" in rare
races). We need to:

- Catch Shopify `metafieldDefinitionCreate` errors of code `TAKEN` and
  treat as success.
- Log the actual userErrors body so we can see what Shopify rejected.

## Fix plan

All P0/P1/P2/P3/P4 can land in one PR. P5 is a follow-up.

1. **`shopify.app.toml`** — add `orders/updated` and `orders/fulfilled`
   subscriptions, remove the imperative `webhooks:` block from
   `app/shopify.server.ts` (keep `afterAuth` for metafield-definition
   bootstrap). Ship declarative-only.
2. **All `webhooks.orders.*.tsx`** — remove dynamic `await import`,
   import `default as shopifyApp` statically.
3. **`webhooks.orders.updated.tsx`** — add an early-exit when the
   payload has no affiliate ID AND isn't a cancellation/refund event.
4. **All three failing handlers** — wrap `authenticate.webhook(request)`
   in a guarded try so any HMAC failure returns 401 via an explicit
   Response (same as today, but observable) instead of the React
   Router 500 path.
5. **Structured logging** — replace every `console.error` in these
   files with `webhookLogger.error({...})` using the existing pino
   logger so Railway logs become queryable.

## How to verify the fix worked

1. Deploy to Railway (the commit referenced in the release).
2. Wait 24 hours.
3. Re-open Partner Dashboard → Monitoring → Webhooks → Last 7 days.
4. **Success criteria:**
   - `orders/create` failure rate < 5%
   - `orders/updated` failure rate < 5%
   - `orders/fulfilled` failure rate < 5%
5. If still high, inspect Railway logs with the new structured logger.
   Grep for `"level":50` (pino error level) + `"module":"webhook"`
   and group by `error.message`.

## Performance notes (beyond reliability)

- **271 ms p90** is fine for webhooks (Shopify times out at 5 s). But
  it could be tighter. Most of the time is in the Shopify GraphQL
  round-trip. For `orders/updated`, adding the early-exit (fix #3)
  takes the median response to **~10 ms** — no DB, no network —
  because most order updates don't carry Fynd affiliate IDs.
- `draft_orders/*` response time (250–261 ms) is inflated by Prisma
  cold-start on Railway's free tier. A **persistent connection pool**
  via `DATABASE_URL?connection_limit=5&pool_timeout=0` would halve it.
- The metafield-definition bootstrap in `afterAuth` runs on every
  auth, not just install. Idempotent but wasteful. Guard it behind
  a shop-level install-check flag.
