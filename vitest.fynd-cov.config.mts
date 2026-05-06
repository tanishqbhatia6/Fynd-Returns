/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["app/lib/__tests__/fynd*.test.ts"],
    environment: "node",
    globals: true,
    setupFiles: ["./app/test/setup.ts"],
    testTimeout: 10_000,
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      reportsDirectory: "./coverage-fynd-gap",
      include: [
        "app/lib/fynd.server.ts",
        "app/lib/fynd-payload.server.ts",
        "app/lib/fynd-returns.server.ts",
        "app/lib/fynd-config.server.ts",
        "app/lib/fynd-status-poll.server.ts",
      ],
      thresholds: {
        statements: 0,
        branches: 0,
        functions: 0,
        lines: 0,
      },
    },
  },
});
