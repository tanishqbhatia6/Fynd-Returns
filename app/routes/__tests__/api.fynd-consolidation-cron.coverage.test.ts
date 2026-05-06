import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { runConsolidationForAllShopsMock } = vi.hoisted(() => ({
  runConsolidationForAllShopsMock: vi.fn(),
}));

vi.mock("../../lib/fynd-consolidation.server", () => ({
  runConsolidationForAllShops: runConsolidationForAllShopsMock,
}));

import { loader, action } from "../api.fynd-consolidation-cron";

const origEnv = { ...process.env };
beforeEach(() => {
  process.env = { ...origEnv };
  runConsolidationForAllShopsMock.mockReset();
});
afterEach(() => {
  process.env = { ...origEnv };
  vi.restoreAllMocks();
});

function mkReq(opts: { method?: string; auth?: string; host?: string } = {}) {
  const headers = new Headers();
  if (opts.auth !== undefined) headers.set("Authorization", opts.auth);
  if (opts.host) headers.set("Host", opts.host);
  return new Request("https://app.example/api/fynd-consolidation-cron", {
    method: opts.method ?? "POST",
    headers,
  });
}

describe("safeCompare via timing-safe comparisons (length mismatches)", () => {
  it("denies when auth header is shorter than expected Bearer token", async () => {
    process.env.CRON_SECRET = "longsupersecretvalue";
    const res = await action({
      request: mkReq({ method: "POST", auth: "Bearer x" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("denies when auth header is longer than expected Bearer token", async () => {
    process.env.CRON_SECRET = "abc";
    const res = await action({
      request: mkReq({
        method: "POST",
        auth: "Bearer abcWITHTRAILINGEXTRABYTES",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });

  it("denies when auth header is empty string but secret is set", async () => {
    process.env.CRON_SECRET = "abc";
    const res = await action({
      request: mkReq({ method: "POST", auth: "" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });

  it("denies when auth header equals raw secret without 'Bearer ' prefix", async () => {
    process.env.CRON_SECRET = "abc";
    const res = await action({
      request: mkReq({ method: "POST", auth: "abc" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });

  it("denies when same length but different content (constant-time compare)", async () => {
    // "Bearer secret1" vs "Bearer secret2" — same length, different last char
    process.env.CRON_SECRET = "secret1";
    const res = await action({
      request: mkReq({ method: "POST", auth: "Bearer secret2" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });

  it("allows when length and content match exactly", async () => {
    process.env.CRON_SECRET = "exactmatch";
    runConsolidationForAllShopsMock.mockResolvedValueOnce([]);
    const res = await action({
      request: mkReq({ method: "POST", auth: "Bearer exactmatch" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });
});

describe("localhost dev mode bypass (no CRON_SECRET)", () => {
  it("allows localhost:3000 host header", async () => {
    delete process.env.CRON_SECRET;
    runConsolidationForAllShopsMock.mockResolvedValueOnce([]);
    const res = await action({
      request: mkReq({ method: "POST", host: "localhost:3000" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });

  it("allows 127.0.0.1 host header", async () => {
    delete process.env.CRON_SECRET;
    runConsolidationForAllShopsMock.mockResolvedValueOnce([]);
    const res = await action({
      request: mkReq({ method: "POST", host: "127.0.0.1:8080" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });

  it("allows GET via loader on localhost when no secret set", async () => {
    delete process.env.CRON_SECRET;
    runConsolidationForAllShopsMock.mockResolvedValueOnce([]);
    const res = await loader({
      request: mkReq({ method: "GET", host: "localhost" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });

  it("denies request with no host header when CRON_SECRET unset", async () => {
    delete process.env.CRON_SECRET;
    const res = await action({
      request: mkReq({ method: "POST" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });
});

describe("error handling during runConsolidation", () => {
  it("returns 500 with stringified non-Error throwable", async () => {
    process.env.CRON_SECRET = "s";
    runConsolidationForAllShopsMock.mockRejectedValueOnce("string failure");
    const res = await action({
      request: mkReq({ method: "POST", auth: "Bearer s" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("string failure");
    expect(typeof body.startedAt).toBe("string");
  });

  it("logs fatal error to console.error", async () => {
    process.env.CRON_SECRET = "s";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    runConsolidationForAllShopsMock.mockRejectedValueOnce(new Error("boom"));
    const res = await action({
      request: mkReq({ method: "POST", auth: "Bearer s" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(500);
    expect(errSpy).toHaveBeenCalledWith("[FyndConsolidationCron] Fatal error:", expect.any(Error));
  });

  it("propagates synchronous throw from runConsolidationForAllShops as 500", async () => {
    process.env.CRON_SECRET = "s";
    vi.spyOn(console, "error").mockImplementation(() => {});
    runConsolidationForAllShopsMock.mockImplementationOnce(() => {
      throw new Error("sync throw");
    });
    const res = await action({
      request: mkReq({ method: "POST", auth: "Bearer s" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("sync throw");
  });

  it("error during loader (GET) path is also handled with 500", async () => {
    process.env.CRON_SECRET = "s";
    vi.spyOn(console, "error").mockImplementation(() => {});
    runConsolidationForAllShopsMock.mockRejectedValueOnce(new Error("loader-side"));
    const res = await loader({
      request: mkReq({ method: "GET", auth: "Bearer s" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("loader-side");
  });

  it("includes startedAt timestamp even on error", async () => {
    process.env.CRON_SECRET = "s";
    vi.spyOn(console, "error").mockImplementation(() => {});
    runConsolidationForAllShopsMock.mockRejectedValueOnce(new Error("x"));
    const before = Date.now();
    const res = await action({
      request: mkReq({ method: "POST", auth: "Bearer s" }),
      params: {},
      context: {},
    } as never);
    const after = Date.now();
    const body = await res.json();
    const ts = Date.parse(body.startedAt);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });
});
