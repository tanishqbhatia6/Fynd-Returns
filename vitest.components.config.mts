/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

/**
 * Standalone vitest config for React component tests (`*.test.tsx`).
 *
 * Why a separate config: the React Router Vite plugin (used in vite.config.ts)
 * transforms TSX into server/client entry points and inserts a `?reactrouter`
 * query that breaks at runtime under jsdom — `Error: React Router Vite plugin
 * can't detect preamble`. This config skips that plugin so jsdom can mount
 * components directly.
 *
 * Run with:   npm run test:components
 */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["app/**/*.test.tsx"],
    environment: "jsdom",
    globals: true,
    setupFiles: ["./app/test/setup.ts", "./app/test/setup.dom.ts"],
    testTimeout: 10_000,
  },
});
