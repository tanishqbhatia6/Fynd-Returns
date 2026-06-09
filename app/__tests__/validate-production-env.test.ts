import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const script = join(process.cwd(), "scripts/validate-production-env.mjs");

function runValidator(env: Record<string, string | undefined>) {
  return spawnSync(process.execPath, [script], {
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...env,
    },
    encoding: "utf8",
  });
}

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

describe("scripts/validate-production-env.mjs", () => {
  it("validates by default when NODE_ENV is unset", () => {
    const res = runValidator(validEnv);
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("Production environment validation passed");
  });

  it("fails by default when NODE_ENV is unset and required values are missing", () => {
    const res = runValidator({});
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Production environment validation failed");
    expect(res.stderr).toContain("Missing DATABASE_URL");
    expect(res.stderr).toContain("Missing REDIS_URL");
    expect(res.stderr).toContain("Missing SCOPES");
    expect(res.stderr).toContain("Missing APP_BILLING_MODE");
    expect(res.stderr).toContain("Missing APP_MANAGED_PRICING_HANDLE");
    expect(res.stderr).toContain("Missing FYND_WEBHOOK_SECRET");
  });

  it("skips only explicit development and test modes", () => {
    expect(runValidator({ NODE_ENV: "development" }).status).toBe(0);
    expect(runValidator({ NODE_ENV: "test" }).status).toBe(0);
  });

  it("requires managed pricing handle", () => {
    const res = runValidator({ ...validEnv, APP_MANAGED_PRICING_HANDLE: "" });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("Missing APP_MANAGED_PRICING_HANDLE");
  });

  it("requires production billing mode so billing cannot fail open", () => {
    const unset = { ...validEnv, APP_BILLING_MODE: "" };
    const dev = { ...validEnv, APP_BILLING_MODE: "dev" };

    const unsetRes = runValidator(unset);
    expect(unsetRes.status).toBe(1);
    expect(unsetRes.stderr).toContain("Missing APP_BILLING_MODE");

    const devRes = runValidator(dev);
    expect(devRes.status).toBe(1);
    expect(devRes.stderr).toContain("APP_BILLING_MODE must be one of: prod, production");
  });

  it("rejects disabling portal CSRF in production", () => {
    const res = runValidator({ ...validEnv, PORTAL_CSRF_REQUIRED: "false" });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain("PORTAL_CSRF_REQUIRED must not be false in production");
  });

  it("requires a strong Fynd webhook secret so the global webhook cannot fail at runtime", () => {
    const missing = runValidator({ ...validEnv, FYND_WEBHOOK_SECRET: "" });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("Missing FYND_WEBHOOK_SECRET");

    const weak = runValidator({ ...validEnv, FYND_WEBHOOK_SECRET: "short" });
    expect(weak.status).toBe(1);
    expect(weak.stderr).toContain("FYND_WEBHOOK_SECRET must be at least 32 characters");
  });

  it("validates optional portal allowed origins as exact public HTTPS origins", () => {
    const good = runValidator({
      ...validEnv,
      PORTAL_ALLOWED_ORIGINS: "https://returns.brand.com,https://help.brand.com/",
    });
    expect(good.status).toBe(0);

    const wildcard = runValidator({ ...validEnv, PORTAL_ALLOWED_ORIGINS: "https://*.myshopify.com" });
    expect(wildcard.status).toBe(1);
    expect(wildcard.stderr).toContain("PORTAL_ALLOWED_ORIGINS must list exact origins");

    const http = runValidator({ ...validEnv, PORTAL_ALLOWED_ORIGINS: "http://returns.brand.com" });
    expect(http.status).toBe(1);
    expect(http.stderr).toContain("PORTAL_ALLOWED_ORIGINS entries must be https:// origins");

    const path = runValidator({ ...validEnv, PORTAL_ALLOWED_ORIGINS: "https://returns.brand.com/portal" });
    expect(path.status).toBe(1);
    expect(path.stderr).toContain("PORTAL_ALLOWED_ORIGINS entries must be origin-only URLs");

    const localhost = runValidator({ ...validEnv, PORTAL_ALLOWED_ORIGINS: "https://localhost:3000" });
    expect(localhost.status).toBe(1);
    expect(localhost.stderr).toContain("PORTAL_ALLOWED_ORIGINS entries must use stable public hostnames");
  });

  it("validates optional superadmin email list when provided", () => {
    const good = runValidator({ ...validEnv, SUPERADMIN_EMAILS: "owner@example.com,ops@example.com" });
    expect(good.status).toBe(0);

    const bad = runValidator({ ...validEnv, SUPERADMIN_EMAILS: "owner@example.com,not-an-email" });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("SUPERADMIN_EMAILS contains invalid email addresses");
  });

  it("rejects non-public Shopify app URLs", () => {
    const localhost = runValidator({ ...validEnv, SHOPIFY_APP_URL: "https://localhost" });
    expect(localhost.status).toBe(1);
    expect(localhost.stderr).toContain("SHOPIFY_APP_URL must use a stable public hostname");

    const placeholder = runValidator({ ...validEnv, SHOPIFY_APP_URL: "https://app.example.com" });
    expect(placeholder.status).toBe(1);
    expect(placeholder.stderr).toContain("SHOPIFY_APP_URL must use a stable public hostname");

    const privateIp = runValidator({ ...validEnv, SHOPIFY_APP_URL: "https://10.0.0.12" });
    expect(privateIp.status).toBe(1);
    expect(privateIp.stderr).toContain("SHOPIFY_APP_URL must use a stable public hostname");
  });
});
