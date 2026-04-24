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
      //   ^ this release
      // See COVERAGE.md for the phase plan and next targets.
      thresholds: {
        statements: 23,
        branches: 16,
        functions: 21,
        lines: 23,
      },
    },
  },
});
