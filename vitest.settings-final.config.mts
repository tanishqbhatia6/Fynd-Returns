/// <reference types="vitest/config" />
import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["app/**/*.test.tsx", "app/**/*.test.ts"],
    environment: "jsdom",
    globals: true,
    setupFiles: ["./app/test/setup.ts", "./app/test/setup.dom.ts"],
    testTimeout: 10_000,
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "json-summary", "json"],
      reportsDirectory: "./coverage-settings-final",
      include: [
        "app/routes/app.settings.rules.tsx",
        "app/routes/app.settings.widget.tsx",
        "app/routes/app.settings.integrations.tsx",
        "app/routes/app.settings.product-policies.tsx",
        "app/routes/app.settings.notifications.tsx",
        "app/routes/app.settings.webhook-logs.tsx",
      ],
    },
  },
});
