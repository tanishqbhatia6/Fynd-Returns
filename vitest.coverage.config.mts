/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Standalone vitest config for coverage measurement. Skips the React Router
 * Vite plugin (it transforms TSX into server/client entry points that v8
 * coverage can't attribute back to the source map).
 *
 * Includes BOTH server tests (`.test.ts`, default node env) AND component
 * tests (`.test.tsx`, switch env to jsdom via per-file
 * `// @vitest-environment jsdom` directive) so a single coverage run
 * covers both halves of the codebase.
 *
 * Run with:   npm run test:coverage
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["app/**/*.test.ts", "app/**/*.e2e.test.ts", "app/**/*.test.tsx"],
    environment: "node",
    globals: true,
    setupFiles: ["./app/test/setup.ts", "./app/test/setup.dom.ts"],
    testTimeout: 10_000,
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "text-summary", "json-summary", "lcov", "html"],
      reportsDirectory: "./coverage",
      include: ["app/**/*.{ts,tsx}"],
      exclude: [
        "app/**/__tests__/**",
        "app/**/*.test.{ts,tsx}",
        "app/**/*.spec.{ts,tsx}",
        "app/test/**",
        "app/entry.*",
        "app/root.tsx",
      ],
      // Thresholds = CI floor. Recent ratchets:
      //   ...40.65% → 41% (Phase 1 close) → 48.6% (component infra + 5
      //   settings loader files added) → 98/90/96/99 after the big
      //   coverage push (22 new test files + 15+ v8 ignore pragmas on
      //   demonstrably unreachable defensive code) → 99/91/97/99 after
      //   fixing /* v8 ignore next */ + // comment pragma syntax (the
      //   trailing comment swallowed the pragma) and the app.returns.$id
      //   100%-lines closure (16 more component tests).
      thresholds: {
        statements: 99,
        branches: 91,
        functions: 97,
        lines: 99,
      },
    },
  },
});
