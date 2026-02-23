/// <reference types="vitest/config" />
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig, type UserConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

if (
  process.env.HOST &&
  (!process.env.SHOPIFY_APP_URL ||
    process.env.SHOPIFY_APP_URL === process.env.HOST)
) {
  process.env.SHOPIFY_APP_URL = process.env.HOST;
  delete process.env.HOST;
}

const host = new URL(process.env.SHOPIFY_APP_URL || "http://localhost").hostname;

let hmrConfig;
if (host === "localhost") {
  hmrConfig = {
    protocol: "ws" as const,
    host: "localhost",
    port: 64999,
    clientPort: 64999,
  };
} else {
  hmrConfig = {
    protocol: "wss" as const,
    host: host,
    port: parseInt(process.env.FRONTEND_PORT || "8002"),
    clientPort: 443,
  };
}

export default defineConfig({
  server: {
    allowedHosts: [host],
    cors: { preflightContinue: true },
    port: Number(process.env.PORT || 3000),
    hmr: hmrConfig,
    fs: { allow: ["app", "node_modules"] },
  },
  plugins: [reactRouter(), tsconfigPaths()],
  build: { assetsInlineLimit: 0 },
  optimizeDeps: { include: ["@shopify/app-bridge-react"] },
  test: {
    include: ["app/**/*.test.ts", "app/**/*.e2e.test.ts"],
    environment: "node",
    globals: true,
  },
}) satisfies UserConfig;
