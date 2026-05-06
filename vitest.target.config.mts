/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["app/**/*.test.ts", "app/**/*.test.tsx"],
    environment: "node",
    globals: true,
    setupFiles: ["./app/test/setup.ts", "./app/test/setup.dom.ts"],
    testTimeout: 10_000,
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "json"],
      reportsDirectory: "./coverage-target",
      include: [
        "app/routes/api.healthz.ts",
        "app/routes/api.readyz.ts",
        "app/routes/api.fynd-webhook-retry-cron.ts",
        "app/routes/api.debug.order-lookup.ts",
        "app/routes/api.returns.$id.actions.ts",
        "app/routes/api.returns.$id.diagnose.ts",
        "app/routes/api.scheduled-report.ts",
        "app/routes/api.fynd-consolidation-cron.ts",
      ],
    },
  },
});
