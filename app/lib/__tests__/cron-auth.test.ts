import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authorizeCronRequest,
  getCronTokens,
  isLocalhostRequest,
  requestHostname,
  safeCompareSecret,
} from "../cron-auth.server";

const originalEnv = { ...process.env };

function req(headers: Record<string, string> = {}) {
  return new Request("https://app.example/api/cron", { headers });
}

beforeEach(() => {
  process.env = { ...originalEnv };
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("safeCompareSecret", () => {
  it("accepts exact matches", () => {
    expect(safeCompareSecret("secret", "secret")).toBe(true);
  });

  it("rejects mismatches, length mismatches, and empty values", () => {
    expect(safeCompareSecret("secret", "wrong")).toBe(false);
    expect(safeCompareSecret("short", "much-longer-secret")).toBe(false);
    expect(safeCompareSecret("", "")).toBe(false);
  });
});

describe("cron token extraction", () => {
  it("accepts x-cron-secret and Bearer tokens", () => {
    expect(getCronTokens(req({ "x-cron-secret": "header-token" }))).toEqual(["header-token"]);
    expect(getCronTokens(req({ authorization: "Bearer bearer-token" }))).toEqual([
      "bearer-token",
    ]);
  });

  it("extracts both token styles when both are present", () => {
    expect(
      getCronTokens(req({ "x-cron-secret": "header-token", authorization: "Bearer bearer-token" })),
    ).toEqual(["header-token", "bearer-token"]);
  });
});

describe("localhost fallback", () => {
  it("matches only exact local hostnames", () => {
    expect(requestHostname(req({ host: "localhost:3000" }))).toBe("localhost");
    expect(isLocalhostRequest(req({ host: "localhost:3000" }))).toBe(true);
    expect(isLocalhostRequest(req({ host: "127.0.0.1:3000" }))).toBe(true);
    expect(isLocalhostRequest(req({ host: "[::1]:3000" }))).toBe(true);
    expect(isLocalhostRequest(req({ host: "127.0.0.1.example.com" }))).toBe(false);
    expect(isLocalhostRequest(req({ host: "localhost.example.com" }))).toBe(false);
  });

  it("allows localhost fallback only outside production when CRON_SECRET is missing", () => {
    delete process.env.CRON_SECRET;
    process.env.NODE_ENV = "development";
    expect(authorizeCronRequest(req({ host: "localhost:3000" }))).toBe(true);
    expect(authorizeCronRequest(req({ host: "remote.example.com" }))).toBe(false);

    process.env.NODE_ENV = "production";
    expect(authorizeCronRequest(req({ host: "localhost:3000" }))).toBe(false);
  });
});

describe("authorizeCronRequest", () => {
  it("accepts matching Bearer and x-cron-secret tokens", () => {
    process.env.CRON_SECRET = "topsecret";
    expect(authorizeCronRequest(req({ authorization: "Bearer topsecret" }))).toBe(true);
    expect(authorizeCronRequest(req({ "x-cron-secret": "topsecret" }))).toBe(true);
  });

  it("rejects missing and wrong tokens when a secret is configured", () => {
    process.env.CRON_SECRET = "topsecret";
    expect(authorizeCronRequest(req())).toBe(false);
    expect(authorizeCronRequest(req({ authorization: "Bearer wrong" }))).toBe(false);
  });
});
