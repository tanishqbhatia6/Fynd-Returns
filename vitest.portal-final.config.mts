/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: [
      "app/routes/__tests__/api.portal.*.test.ts",
      "app/routes/__tests__/api-portal-*.test.ts",
    ],
    environment: "node",
    globals: true,
    setupFiles: ["./app/test/setup.ts"],
    testTimeout: 30_000,
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "json-summary", "json", "html"],
      reportsDirectory: "./coverage-portal-final",
      include: [
        "app/routes/api.portal.lookup.ts",
        "app/routes/api.portal.order.ts",
        "app/routes/api.portal.create-return.ts",
        "app/routes/api.portal.cancel-return.ts",
        "app/routes/api.portal.fynd-enrich.ts",
        "app/routes/api.portal.otp.send.ts",
        "app/routes/api.portal.otp.verify.ts",
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
