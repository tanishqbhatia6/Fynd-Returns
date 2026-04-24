/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Standalone vitest config for coverage measurement. We avoid the React
// Router plugin from vite.config.ts because it transforms TSX into
// server/client entry points that v8 coverage can't attribute back to the
// source map cleanly (causing silent zero-output runs). This config runs
// the same test files listed in vite.config.ts's test.include array.
//
// Run with:   npm run test:coverage
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["app/**/*.test.ts", "app/**/*.e2e.test.ts"],
    environment: "node",
    globals: true,
    setupFiles: ["./app/test/setup.ts"],
    testTimeout: 10000,
    coverage: {
      enabled: true,
      provider: "v8",
      // text: human-readable stdout
      // text-summary: single-line recap for CI logs
      // json-summary: consumed by badge/reporting scripts
      // lcov: consumed by Codecov / Coveralls
      // html: local dev — browse coverage/index.html to see gaps
      reporter: ["text", "text-summary", "json-summary", "lcov", "html"],
      reportsDirectory: "./coverage",
      include: ["app/**/*.{ts,tsx}"],
      exclude: [
        "app/**/__tests__/**",
        "app/**/*.test.{ts,tsx}",
        "app/**/*.spec.{ts,tsx}",
        "app/test/**",
        // Generated or build-only entrypoints
        "app/entry.*",
        "app/root.tsx",
      ],
      // Thresholds are the coverage floor enforced by CI. Each phase
      // ratchets upward; the floor never drops.
      //   Phase 0 baseline:   ~8% statements
      //   Phase 1 batch 1:   14% (pure-logic libs)
      //   Phase 1 batch 2a:  15.66% (MSW harness + shopify-admin pure/integration)
      //   Phase 1 batch 2b:  15.66% (+ Prisma mock factory, fynd-webhook pure)
      //   Phase 1 batch 3:   17.83% (+ notification, close/decline Shopify return,
      //                              billing gate landed in the billing PR = 34 tests)
      //   Phase 1 batch 4:   18.81% (+ createRefund, fetchOrderByGid, webhook-dispatch)
      //   Phase 1 batch 5:   20.85% (+ shop.server, postman-collection, resilience,
      //                                fynd-status-poll, fynd-webhook-api)
      //   Phase 1 batch 6:   21.67% (+ slo, health, request-context, security
      //                                observability modules — 68 tests)
      //   Phase 1 batch 7:   22.86% (+ tracing, logger, fynd-fdk,
      //                                fynd-consolidation — 71 tests)
      //   Phase 1 batch 8:   23.77% (+ fynd-config, fynd-logger, portal-config,
      //                                portal-theme, refund-gate-presets,
      //                                return-id-counter, audit, fynd-retry —
      //                                88 tests)
      //   Phase 1 batch 9:   24.32% (+ first route tests — healthz, readyz,
      //                                portal.track, portal.returns, auth.$ —
      //                                33 tests)
      //   Phase 1 batch 10:  25.75% (+ external.postman, 2 cron routes,
      //                                portal.otp.send + portal.otp.verify —
      //                                54 tests)
      //   Phase 1 batch 11:  26.17% (+ external.returns/settings/webhooks CRUD
      //                                — 44 tests)
      //   Phase 1 batch 12:  27.28% (+ external.returns.refund + Gorgias
      //                                widget + Gorgias actions — 40 tests)
      //   Phase 1 batch 13:  28.64% (+ api.returns.\$id.actions dispatch +
      //                                simple action types — 24 tests, one
      //                                big-file strategy pushed +1.36pp)
      //   Phase 1 batch 14:  30.07% (+ heavyweight action types: reject,
      //                                approve (consolidation), retry_fynd_sync,
      //                                approve/decline_cancellation — 23 tests,
      //                                crossed the 30% line)
      //   Phase 1 batch 15:  31.03% (+ api.portal.create-return guards +
      //                                offer-accept path — 22 tests, +0.96pp
      //                                from a 1,313-line file)
      //   Phase 1 batch 16:  32.10% (+ api.portal.lookup — 25 tests covering
      //                                guards, OTP gate state machine, all
      //                                lookup type dispatches. File 0% → 51%)
      //   Phase 1 batch 17:  32.68% (+ api.portal.order — 23 tests for
      //                                pure helper, guards, error fallbacks.
      //                                File 2% → 20%)
      //   Phase 1 batch 18:  33.04% (+ shopify-admin pure helpers +
      //                                createFyndClientOrError branches —
      //                                37 tests)
      //   Phase 1 batch 19:  33.97% (+ api.portal.cancel-return state
      //                                machine + api.scheduled-report cron —
      //                                36 tests)
      //   Phase 1 batch 20:  35.08% (+ api.returns.export CSV generation +
      //                                api.returns.bulk three bulk action
      //                                types — 30 tests, +1.11pp)
      //   ^ this release
      // See COVERAGE.md for the phase plan and next targets.
      thresholds: {
        statements: 35,
        branches: 22,
        functions: 26,
        lines: 35,
      },
    },
  },
});
