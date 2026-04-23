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
      // Thresholds are the coverage floor enforced by CI.
      // Phase 1 ratchet: ~8% → ~14% after testing fynd-payload, fraud-detection,
      // source-channel, credential-validation, return-request-id, errors, and
      // fynd.server pure exports. See COVERAGE.md for the full plan.
      thresholds: {
        statements: 14,
        branches: 10,
        functions: 11,
        lines: 14,
      },
    },
  },
});
