import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    include: ["app/**/*.test.ts"],
    environment: "node",
    globals: true,
    setupFiles: ["./app/test/setup.ts", "./app/test/setup.dom.ts"],
    testTimeout: 10_000,
    coverage: {
      enabled: true,
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "./coverage-gap",
      include: [
        "app/lib/shop.server.ts",
        "app/lib/return-id-counter.server.ts",
        "app/lib/return-request-id.ts",
        "app/lib/return-action-errors.server.ts",
        "app/lib/parse-json.ts",
        "app/lib/status-colors.ts",
        "app/lib/refund-gate-presets.ts",
        "app/lib/source-channel.server.ts",
        "app/lib/credential-validation.server.ts"
      ],
    },
  },
});
