# Test Coverage Plan

This document is the **single source of truth** for how Fynd Returns
gets and keeps meaningful test coverage. It's a multi-phase program,
not a single sprint.

---

## Current baseline

Measured with `npm run test:coverage` (vitest + v8). Numbers below are
recomputed on every push to `main` in CI and reported on the job
summary + Codecov.

| Metric      | Current | Phase 0 floor | Phase 1 floor |
|-------------|--------:|--------------:|--------------:|
| Statements  | 14.24%  | 8%            | **14%**       |
| Branches    | 10.68%  | 4%            | **10%**       |
| Functions   | 11.87%  | 7%            | **11%**       |
| Lines       | 14.20%  | 8%            | **14%**       |

**637 tests** in 36 test files — all passing. The thresholds in
[vitest.coverage.config.mts](vitest.coverage.config.mts) are the CI
floor; they can only ratchet upward.

### Phase 1 (batch 1) files now covered

| File | Before | After |
|------|-------:|------:|
| `app/lib/fynd-payload.server.ts` | 0.2% | 77.9% |
| `app/lib/fraud-detection.server.ts` | 0% | 93.2% |
| `app/lib/source-channel.server.ts` | 0% | 100% |
| `app/lib/credential-validation.server.ts` | 0% | 98.1% |
| `app/lib/observability/errors.server.ts` | 0% | 97.7% |
| `app/lib/return-request-id.ts` | 13.5% | 97.3% |
| `app/lib/dashboard-date-utils.ts` | 39.4% | ~90% |
| `app/lib/fynd.server.ts` (pure exports) | 1.5% | 16.0% |

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
