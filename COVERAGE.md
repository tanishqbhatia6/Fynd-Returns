# Test Coverage Plan

This document is the **single source of truth** for how Fynd Returns
gets and keeps meaningful test coverage. It's a multi-phase program,
not a single sprint.

---

## Current baseline

Measured with `npm run test:coverage` (vitest + v8). Numbers below are
recomputed on every push to `main` in CI and reported on the job
summary + Codecov.

| Metric      | Current | Batch 21 | Batch 22 (now) |
|-------------|--------:|---------:|---------------:|
| Statements  | 37.35%  | 36%      | **37%**        |
| Branches    | 24.74%  | 23%      | **24%**        |
| Functions   | 27.67%  | 26%      | **27%**        |
| Lines       | 38.18%  | 36%      | **37%**        |

**1,608 tests** in 98 test files — all passing. Thresholds in
[vitest.coverage.config.mts](vitest.coverage.config.mts) are the CI
floor; they can only ratchet upward.

### Phase 1 (batch 1) files lifted

| File | Before | After |
|------|-------:|------:|
| `app/lib/fynd-payload.server.ts` | 0.2% | 77.9% |
| `app/lib/fraud-detection.server.ts` | 0% | 93.2% |
| `app/lib/source-channel.server.ts` | 0% | 100% |
| `app/lib/credential-validation.server.ts` | 0% | 98.1% |
| `app/lib/observability/errors.server.ts` | 0% | 97.7% |
| `app/lib/return-request-id.ts` | 13.5% | 97.3% |
| `app/lib/dashboard-date-utils.ts` | 39.4% | ~90% |

### Batch 2a / 2b — MSW harness + Prisma mock factory

| File | Before | After |
|------|-------:|------:|
| `app/lib/shopify-admin.server.ts` (pure + GraphQL) | 2.8% | ~25% |
| `app/lib/fynd.server.ts` (pure + token fetch) | 1.5% | 30.2% |
| `app/lib/fynd-webhook.server.ts` (pure helpers) | 11.4% | 15.5% |
| `app/lib/billing.server.ts` | — | (34 tests, ~95%) |

### Batch 3

| File | Before | After |
|------|-------:|------:|
| `app/lib/notification.server.ts` | 0.3% | ~45% (35 new tests) |
| `app/lib/shopify-admin.server.ts` (close/decline/best-effort) | 13.3% | ~30% (+16 tests) |

### Batch 4

| File | Before | After |
|------|-------:|------:|
| `app/lib/shopify-admin.server.ts` (createRefund + fetchOrderByGid) | ~30% | ~40% (+14 tests) |
| `app/lib/webhook-dispatch.server.ts` | 0% | ~90% (13 new tests) |

### Batch 5

Five small self-contained files pushed to high coverage in one pass.
97 new tests across 5 new test files.

| File | Before | After |
|------|-------:|------:|
| `app/lib/shop.server.ts` | 0% | ~95% (8 tests) |
| `app/lib/postman-collection.server.ts` | 0% | ~100% (13 tests) |
| `app/lib/observability/resilience.server.ts` | 20.9% | ~95% (20 tests) |
| `app/lib/fynd-status-poll.server.ts` | 0% | ~85% (22 tests) |
| `app/lib/fynd-webhook-api.server.ts` | 0% | ~90% (34 tests) |

### Batch 6

Four observability modules, 68 new tests, + test count crossed 1,000.

| File | Before | After |
|------|-------:|------:|
| `app/lib/observability/slo.server.ts` | 0% | ~95% (22 tests — SLO defs, burn-rate, budget, annotateSLO) |
| `app/lib/observability/health.server.ts` | 0% | ~90% (10 tests — DB + Fynd checks + composite readiness) |
| `app/lib/observability/request-context.server.ts` | 8.1% | ~95% (18 tests — requestId, baggage, IP hash, correlation headers) |
| `app/lib/observability/security.server.ts` | 51.4% | ~95% (18 tests — auth/rate-limit/webhook-sig/suspicious-activity) |

### Batch 7

Two more observability modules lifted, plus the Fynd FDK wrapper and the
consolidation batch runner. 71 new tests across 4 new test files.

| File | Before | After |
|------|-------:|------:|
| `app/lib/observability/tracing.server.ts` | 27% | ~90% (22 tests — withSpan/Sync, baggage, events, timer) |
| `app/lib/observability/logger.server.ts` | ~60% | ~95% (11 tests — sampling, child-logger env overrides) |
| `app/lib/fynd-fdk.server.ts` | 0% | ~90% (23 tests — Platform/App ctors, Storefront + Platform client methods, 401/403 hint messages) |
| `app/lib/fynd-consolidation.server.ts` | 0% | ~95% (15 tests — single-case sync, multi-case grouping, failures, all-shops iteration) |

### Batch 8

Eight small- and medium-sized uncovered libs lifted in one pass.
88 new tests across 8 new test files. Clears out most of the remaining
pure-logic files, setting up route and big-lib tests for batches 9+.

| File | Before | After |
|------|-------:|------:|
| `app/lib/fynd-config.server.ts` | 8% | ~100% (16 tests — env URLs, custom URL parsing, app mode) |
| `app/lib/fynd-logger.server.ts` | 0% | ~100% (10 tests — redact patterns for creds + auth headers) |
| `app/lib/portal-config.server.ts` | 0% | ~100% (9 tests — default merge, invalid JSON, defaultTab allow-list) |
| `app/lib/portal-theme.server.ts` | 0% | ~100% (11 tests — default theme, partial merge, HTML token replacement) |
| `app/lib/refund-gate-presets.ts` | 0% | ~100% (13 tests — preset status maps, inference round-trip, labels) |
| `app/lib/return-id-counter.server.ts` | 0% | ~100% (5 tests — atomic increment, missing row, DB error) |
| `app/lib/observability/audit.server.ts` | 0% | ~100% (7 tests — auditLog + helpers, span annotation, no-span path) |
| `app/lib/fynd-retry.server.ts` | 0% | ~90% (12 tests — throttle, happy path, retry backoff, exhaustion, scheduleRetry) |

### Batch 9

First batch of route-level tests — 5 small routes (health, portal, auth)
plus a fix for the webhook-dispatch flushAll race that showed up as
parallelism climbed. 33 new tests in 5 files.

| File | Before | After |
|------|-------:|------:|
| `app/routes/api.healthz.ts` | 0% | ~100% (4 tests — liveness response shape, BUILD_VERSION) |
| `app/routes/api.readyz.ts` | 0% | ~100% (3 tests — 200/503 gating on composite status, no-store header) |
| `app/routes/api.portal.track.ts` | 0% | ~90% (12 tests — CORS, rate limit, param validation, anti-enumeration, journey extraction) |
| `app/routes/api.portal.returns.ts` | 0% | ~90% (11 tests — token gating, session states, enrichment, malformed JSON) |
| `app/routes/auth.$.tsx` | 0% | ~100% (3 tests — admin gate, boundary headers) |

### Batch 10

Five more API routes covered: the external-API Postman collection download,
both Fynd cron endpoints, and the customer OTP send / verify flow. 54 new
tests across 5 new test files.

| File | Before | After |
|------|-------:|------:|
| `app/routes/api.v1.external.postman.ts` | 0% | ~100% (7 tests — 3-permission cascade, rate limits, env-driven base URL) |
| `app/routes/api.fynd-consolidation-cron.ts` | 0% | ~100% (9 tests — CRON_SECRET gating, localhost dev fallback, aggregates, error path) |
| `app/routes/api.fynd-webhook-retry-cron.ts` | 0% | ~95% (9 tests — retry success, reschedule-with-backoff, exhaustion, processing errors) |
| `app/routes/api.portal.otp.send.ts` | 0% | ~95% (13 tests — session validation, cooldown, email dispatch) |
| `app/routes/api.portal.otp.verify.ts` | 0% | ~90% (16 tests — bcrypt + legacy SHA-256, attempt caps, account lockout, token issuance) |

### Batch 11

External v1 API CRUD surface tested end-to-end — list + detail returns,
settings, webhooks list/POST/DELETE. 44 new tests across 5 new test
files. Also expanded the shared Prisma mock to include
`webhookSubscription` and `webhookDeliveryFailure` so every
webhook-touching test can use the factory instead of hand-rolling stubs.

| File | Before | After |
|------|-------:|------:|
| `app/routes/api.v1.external.returns.ts` | 0% | ~95% (11 tests — filters, cursor + offset pagination, error envelope) |
| `app/routes/api.v1.external.returns.$id.ts` | 0% | ~100% (7 tests — auth, per-key rate limit, 404/500 paths) |
| `app/routes/api.v1.external.settings.ts` | 0% | ~100% (6 tests — auth cascade, sanitized response, missing/error paths) |
| `app/routes/api.v1.external.webhooks.ts` | 0% | ~95% (12 tests — list, create with SSRF guard, duplicate detection, invalid events) |
| `app/routes/api.v1.external.webhooks.$id.ts` | 0% | ~100% (8 tests — soft-delete, 404/500, method gating) |

### Batch 12

Three more action/integration routes covered — external refund,
Gorgias widget (HTML), Gorgias actions. 40 new tests across 3 new
test files.

| File | Before | After |
|------|-------:|------:|
| `app/routes/api.v1.external.returns.$id.refund.ts` | 0% | ~95% (13 tests — validation, state gates, refund creation, webhook dispatch, legacy discount_code coercion) |
| `app/routes/api.integrations.gorgias.ts` | 0% | ~95% (11 tests — HTML card rendering, API-key timing-safe compare, fallback query, risk/gift badges) |
| `app/routes/api.integrations.gorgias-actions.ts` | 0% | ~95% (16 tests — approve, reject, add_note, get_timeline actions with status gates) |

### Batch 13

Strategic pivot: instead of many small files, target the single biggest
uncovered file in the repo. `api.returns.$id.actions.ts` is 2,348 lines
of multi-action dispatch that had 0% coverage — one test file here
moved global coverage by **+1.36 percentage points**, the biggest
single-batch jump of the campaign.

| File | Before | After |
|------|-------:|------:|
| `app/routes/api.returns.$id.actions.ts` | 0% | ~17% (24 tests — dispatch, body parsing (JSON + form), auth/id/404 guards, simple action types: update_status, add_note, save_notes_for_customer, update_label, update_instructions, edit_details, cancel_order validation) |

### Batch 14

Continuing the big-file strategy. Heavyweight action types in the same
file — each a self-contained state machine worth its own fixture setup.
23 new tests lifted the actions file 17% → 35% and pushed global
coverage over the **30% line** for the first time (+1.43pp).

| File | Before | After |
|------|-------:|------:|
| `app/routes/api.returns.$id.actions.ts` | ~17% | ~35% (+23 tests covering reject, approve (consolidation + green), retry_fynd_sync state machine, approve_cancellation close-before-cancel invariant, decline_cancellation) |

### Batch 15

Next biggest untouched file — `api.portal.create-return.ts` at 1,313
lines and 0% coverage. 22 new tests covering the validation guards,
CSRF gating, blocklist enforcement, and the complete "accept offer →
discount code" path. +0.96pp global.

| File | Before | After |
|------|-------:|------:|
| `app/routes/api.portal.create-return.ts` | 0% | ~18% (22 tests — method/rate-limit/CSRF gates, param validation, shop lookup + normalization, blocklist gate, offer accept path end-to-end incl. Shopify discount-code mutation) |

### Batch 16

Next biggest untouched route — `api.portal.lookup.ts` at 602 lines and
0% coverage. 25 new tests covering the full dispatch, the OTP state
machine, and every supported lookup type. File jumped to **51%** —
halfway covered in one pass. +1.07pp global.

| File | Before | After |
|------|-------:|------:|
| `app/routes/api.portal.lookup.ts` | 0% | ~51% (25 tests — loader preflight, action guards (method/rate-limit/params/lookup-type/length/shop), OTP gate state machine (new session, resend cooldown, lockout after 15 fails, session expired/unverified/mismatched token), lookup dispatch by return_id, return_no, forward/return_awb, phone, email — plus empty-result path) |

### Batch 17

Next mega-route — `api.portal.order.ts` at 1,127 lines and ~2% covered.
23 new tests cover the exported `shouldBlockOrderForExistingReturn`
helper (regression-hardened), all loader validation guards, existing-
returns formatting + active filter, and all three error-fallback paths
(SessionNotFoundError → 403, OrderAccessError → 200 fallback,
"not approved/protected" message → 200 fallback, generic → 200
fallback). +0.58pp global; file 2% → 20%.

| File | Before | After |
|------|-------:|------:|
| `app/routes/api.portal.order.ts` | ~2% | ~20% (23 tests — shouldBlockOrderForExistingReturn (6 cases incl. over-return + defensive input), OPTIONS preflight, 429/400/404 guards with order-number sanitization + shop normalization, existing returns mapping + active filter, all 4 error-fallback branches using the real OrderAccessError class for instanceof) |

### Batch 18

Two high-value server libraries extended: pure helpers in
`shopify-admin.server.ts` that were still uncovered, plus the
`createFyndClientOrError` / `createFyndClient` factory in `fynd.server.ts`.
37 new tests across 2 new files.

| File | Before | After |
|------|-------:|------:|
| `app/lib/shopify-admin.server.ts` | ~35% | ~36% (25 tests — extractShopifyOrderNumberVariants (FYND prefix variants, letter+digit sub-variants, dedup, unicode safety), extractAffiliateOrderId (all 7 key variants, case-insensitive, priority order, whitespace trim, skip-empty), OrderAccessError) |
| `app/lib/fynd.server.ts` | ~30% | ~50% (12 tests — all 10 early-return branches + 2 happy paths in createFyndClientOrError, plus the createFyndClient wrapper both succeeding and returning null) |

### Batch 19

Two more routes fully covered — portal cancellation state machine and
scheduled-report cron. 36 new tests.

| File | Before | After |
|------|-------:|------:|
| `app/routes/api.portal.cancel-return.ts` | 0% | ~95% (24 tests — loader preflight, auth gates (token/session/expired/unverified), cross-shop replay defence, portal config gate, Flow A auto-cancel (pending/processing/in progress/initiated) with email + webhook side effects, Flow B cancellation request (refund block at refunded / in_progress, duplicate pending block, success clears prior declined)) |
| `app/routes/api.scheduled-report.ts` | 0% | ~85% (12 tests — CRON_SECRET gating, empty result set, daily/weekly/monthly dispatch, no-recipients + SMTP-unconfigured error paths, adminNotifyEmail fallback, per-shop error isolation, SMTP password decryption) |

### Batch 20

Two more admin routes fully covered: CSV export + bulk actions. 30
new tests, +1.11pp global.

| File | Before | After |
|------|-------:|------:|
| `app/routes/api.returns.export.ts` | 0% | ~85% (9 tests — shop auto-create, 10,000-row limit, UTF-8 BOM + CRLF, PII anonymisation with stable hash tokens, status + search filter, multi-item rows, empty-items row, CSV escaping of commas/quotes, 500 on DB error) |
| `app/routes/api.returns.bulk.ts` | 0% | ~90% (21 tests — all validation gates (method / body / action type / resolutionType / id count / reason), bulk_approve (idempotent updateMany, terminal skip, per-row errors, notification failure swallow, missing-id reporting), bulk_reject happy path + terminal skip, bulk_change_resolution update + rejected/cancelled guard) |

### Batch 21

Portal exchange catalog + Fynd enrichment routes. 28 new tests across
2 files.

| File | Before | After |
|------|-------:|------:|
| `app/routes/api.portal.products.ts` | 0% | ~95% (13 tests — rate-limit, shop/exchange/session guards, single-product fetch, search fetch, availability filtering, -1 inventory = untracked, 50-limit cap, non-ok response, fetch throws, productType filter) |
| `app/routes/api.portal.fynd-enrich.ts` | 0% | ~85% (15 tests — loader preflight, action guards (method/rate-limit/shop), Fynd-disabled fallback, storefront-client fallback, order enrichment with forward-shipment preference + mapping cache + search-throw swallow, returns enrichment with 10-id cap + exact-shipment match + stale-bag fallback) |

### Batch 22 — this release

Admin tooling routes — return diagnostic + admin create-return. 24 new
tests, +1.27pp global.

| File | Before | After |
|------|-------:|------:|
| `app/routes/api.returns.$id.diagnose.ts` | 0% | ~80% (7 tests — 404s, DB snapshot, fast-path derivation, Shopify order fetch error capture, live Fynd API trace, search-throw trace entry) |
| `app/routes/api.admin.create-return.ts` | 0% | ~75% (17 tests — validation (method, required fields, qty, over-return), blocklist + adminOverride skip, eligibility failure, auto-approve (disabled / no rules / manual_review), orderId resolution chain (GID kept / Fynd lookup / fetchOrderByOrderNumber fallback), transaction failure) |

---

## Why not 100% everywhere

Coverage is a proxy, not a goal. Chasing 100% globally produces tests
that re-assert the implementation (brittle), and diminishing returns
past 80% mean enormous effort for few real bugs caught.

Industry norm for a SaaS app of this complexity is **70–85% on
critical paths**, with E2E smoke tests on the golden flows. That's the
target. Specific high-risk files will go higher (often 95–100%).

### What we will go to 100% on

- `app/lib/encryption.server.ts` (secrets — any gap is a security risk).
- `app/lib/api-key-auth.server.ts` (auth).
- `app/lib/fynd-webhook-verify.server.ts` (signature verification).
- `app/lib/rate-limit.server.ts` (abuse prevention).
- `app/lib/portal-auth.server.ts` (customer session).
- Any file under `app/lib/` that is pure logic with no IO.

### What we will aim for ~80% on

- Route handlers (`app/routes/api.*.ts`, `app/routes/app.*.tsx`).
- Major server libraries (`fynd.server.ts`, `shopify-admin.server.ts`,
  `notification.server.ts`).

### What we will aim for ~50% on (E2E suffices)

- Pure React UI components (charts, chrome, dashboard tiles).
- Glue / rendering code without business logic.

---

## Phases

Each phase ends by (a) merging tests, (b) ratcheting the CI threshold
in `vitest.coverage.config.mts`, (c) updating the baseline table
above.

### Phase 0 — Foundations (shipping now)

- Fixed the one pre-existing broken test.
- Installed `@vitest/coverage-v8`; added `npm run test:coverage`.
- Added CI workflow with typecheck + tests + coverage + build.
- Added CodeQL security scan.
- Added Dependabot for npm + GitHub Actions.
- Added community health files (CODEOWNERS, PR template, issue
  templates, CONTRIBUTING, LICENSE, SECURITY).
- **Coverage floor set at current baseline** — can't drop.

**Exit:** all of the above merged and green on `main`.

### Phase 1 — Critical server logic (~1–2 weeks)

Unit + API tests for the highest-risk uncovered files. Prioritised by
statement count × risk:

- [ ] `app/lib/fynd-webhook.server.ts` (730 stmts, 11.4%) → 85%+
- [ ] `app/lib/shopify-admin.server.ts` (633 stmts, 2.8%) → 80%+
- [ ] `app/lib/fynd-payload.server.ts` (494 stmts, 0.2%) → 85%+
- [ ] `app/lib/fynd.server.ts` (338 stmts, 1.5%) → 85%+
- [ ] `app/lib/notification.server.ts` (337 stmts, 0.3%) → 80%+
- [ ] `app/routes/api.returns.$id.actions.ts` (1108 stmts, 0%) → 75%+
- [ ] `app/routes/api.portal.create-return.ts` (526 stmts, 0%) → 75%+
- [ ] `app/routes/api.portal.order.ts` (429 stmts, 1.9%) → 75%+

**Target overall:** 30–40% statements. Ratchet threshold to 30%.

**Tooling required:**
- `msw` for HTTP mocking (Shopify Admin, Fynd API).
- Prisma mock pattern (already in place, expand).

### Phase 2 — E2E golden flows (~1 week)

Install Playwright. Write **6–10 end-to-end specs** that boot a real
React Router dev server against a seeded Postgres and drive the portal
+ admin through their critical paths:

- [ ] Customer submits a return (order-based lookup).
- [ ] Customer submits manually with OTP verification.
- [ ] Admin approves a pending return.
- [ ] Admin rejects a pending return with reason.
- [ ] Fynd sync on approval (mocked Fynd API).
- [ ] Credit-note webhook → auto-refund (mocked Shopify refund).
- [ ] Blocklist enforcement on portal.
- [ ] Portal "track existing return" — all 7 lookup methods.
- [ ] CSV export from returns list.
- [ ] Bulk-approve on returns list.

E2E adds confidence, not statement coverage — but GitHub Insights will
show them as separate test suite on the Actions tab.

### Phase 3 — Route + component coverage (~2–3 weeks)

Loader / action tests for every `app.*.tsx` route. Component tests
(Testing Library) for the KPI card, return detail, portal, returns
list, docs sidebar, settings forms.

**Target overall:** 60%+ statements. Ratchet threshold to 60%.

### Phase 4 — Regression + edge cases (ongoing)

Every bug we fix from here forward **must** include a regression test
that fails before the fix and passes after. Coverage ratchet enforces
this on PRs.

**Target overall:** 75–80% statements. Ratchet threshold to 75%.

### Phase 5 — Stretch (optional)

Only if we've exhausted real bugs and want the badge: push specific
high-risk files to 100%. Not a global target — we stop when the ROI
flattens.

---

## How coverage is enforced

1. **Local dev:** `npm run test:coverage` prints a summary and writes
   `coverage/index.html` (browsable in any browser).
2. **CI:** `ci.yml` runs `npm run test:coverage`; vitest fails the run
   if any metric drops below the thresholds in
   `vitest.coverage.config.mts`.
3. **PR visibility:** the `coverage-summary.json` artifact is uploaded
   from every run. When Codecov is configured (optional
   `CODECOV_TOKEN` repo secret), every PR gets a diff comment.
4. **Ratchet mechanics:** when a PR increases coverage, the reviewer
   bumps the threshold in the same PR so the floor moves up. Never
   down.

---

## FAQ

### Can I skip a test for a one-line patch?

Yes — trivial typo fixes and docs don't need tests. Use judgment. If
you're changing a control-flow branch, write a test.

### What if mocking is too painful?

File an issue tagged `testing-infra`. We'll invest in the shared
harness rather than let every contributor reinvent their own mocks.

### How do I see what's uncovered in a file?

```bash
npm run test:coverage
open coverage/index.html
# navigate to the file — red/yellow gutters mark uncovered lines
```

### How often is the baseline table in this doc updated?

Manually, at the end of each phase. The authoritative up-to-the-minute
numbers are on the Actions job summary and Codecov dashboard.
