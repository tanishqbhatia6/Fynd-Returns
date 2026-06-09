import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts/production-preflight.mjs");

const validEnv = {
  DATABASE_URL: "postgresql://user:pass@localhost:5432/returnpromax",
  REDIS_URL: "redis://localhost:6379",
  SHOPIFY_API_KEY: "test_key",
  SHOPIFY_API_SECRET: "test_secret",
  SHOPIFY_APP_URL: "https://returns.returnpromax.com",
  SCOPES: "read_orders,write_orders",
  ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  PORTAL_JWT_SECRET: "0123456789abcdef0123456789abcdef",
  CRON_SECRET: "abcdef0123456789abcdef0123456789",
  FYND_WEBHOOK_SECRET: "fedcba9876543210fedcba9876543210",
  APP_BILLING_MODE: "production",
  APP_MANAGED_PRICING_HANDLE: "return-pro-max-prod",
};

function runPreflight(args: string[], env: Record<string, string | undefined> = {}) {
  return spawnSync(process.execPath, [script, ...args], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...env,
    },
    encoding: "utf8",
  });
}

describe("scripts/production-preflight.mjs", () => {
  it("passes static repo readiness checks without live env or network", () => {
    const res = runPreflight(["--skip-env", "--skip-network"]);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Production readiness preflight passed");
  });

  it("validates production env values when provided", () => {
    const res = runPreflight(["--skip-network"], validEnv);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Production readiness preflight passed");
  });

  it("fails when production env values are missing", () => {
    const res = runPreflight(["--skip-network"], {});
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Production readiness preflight failed");
    expect(res.stderr).toContain("Production environment contract failed");
    expect(res.stderr).toContain("Missing DATABASE_URL");
    expect(res.stderr).toContain("Missing REDIS_URL");
  });
});
