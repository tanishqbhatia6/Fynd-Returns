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
});

function mkReq(opts: { method?: string; auth?: string; host?: string } = {}) {
  const headers = new Headers();
  if (opts.auth) headers.set("Authorization", opts.auth);
  if (opts.host) headers.set("Host", opts.host);
  return new Request("https://app.example/api/fynd-consolidation-cron", {
    method: opts.method ?? "POST",
    headers,
  });
}

describe("POST /api/fynd-consolidation-cron (action)", () => {
  it("401 when CRON_SECRET set but auth header missing", async () => {
    process.env.CRON_SECRET = "topsecret";
    const res = await action({ request: mkReq({ method: "POST" }), params: {}, context: {} } as never);
    expect(res.status).toBe(401);
  });

  it("401 when Bearer token doesn't match CRON_SECRET", async () => {
    process.env.CRON_SECRET = "topsecret";
    const res = await action({ request: mkReq({ method: "POST", auth: "Bearer wrong" }), params: {}, context: {} } as never);
    expect(res.status).toBe(401);
  });

  it("200 with aggregates when authorized", async () => {
    process.env.CRON_SECRET = "topsecret";
    runConsolidationForAllShopsMock.mockResolvedValueOnce([
      { shopId: "s-1", groupsProcessed: 2, casesUpdated: 3, errors: [] },
      { shopId: "s-2", groupsProcessed: 1, casesUpdated: 1, errors: ["err-x"] },
    ]);
    const res = await action({ request: mkReq({ method: "POST", auth: "Bearer topsecret" }), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.shopsProcessed).toBe(2);
    expect(body.totalGroups).toBe(3);
    expect(body.totalCases).toBe(4);
    expect(body.errors).toEqual(["err-x"]);
  });

  it("omits errors field when none", async () => {
    process.env.CRON_SECRET = "topsecret";
    runConsolidationForAllShopsMock.mockResolvedValueOnce([
      { shopId: "s-1", groupsProcessed: 1, casesUpdated: 1, errors: [] },
    ]);
    const res = await action({ request: mkReq({ method: "POST", auth: "Bearer topsecret" }), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.errors).toBe(undefined);
  });

  it("500 when consolidation throws", async () => {
    process.env.CRON_SECRET = "topsecret";
    runConsolidationForAllShopsMock.mockRejectedValueOnce(new Error("DB down"));
    const res = await action({ request: mkReq({ method: "POST", auth: "Bearer topsecret" }), params: {}, context: {} } as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe("DB down");
  });

  it("allows localhost when CRON_SECRET unset (dev convenience)", async () => {
    delete process.env.CRON_SECRET;
    runConsolidationForAllShopsMock.mockResolvedValueOnce([]);
    const res = await action({ request: mkReq({ method: "POST", host: "localhost:3000" }), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });

  it("denies non-localhost when CRON_SECRET unset", async () => {
    delete process.env.CRON_SECRET;
    const res = await action({ request: mkReq({ method: "POST", host: "remote.example.com" }), params: {}, context: {} } as never);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/fynd-consolidation-cron (loader)", () => {
  it("GET with auth runs the cron", async () => {
    process.env.CRON_SECRET = "topsecret";
    runConsolidationForAllShopsMock.mockResolvedValueOnce([]);
    const res = await loader({ request: mkReq({ method: "GET", auth: "Bearer topsecret" }), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });

  it("GET without auth returns 405", async () => {
    process.env.CRON_SECRET = "topsecret";
    const res = await loader({ request: mkReq({ method: "GET" }), params: {}, context: {} } as never);
    expect(res.status).toBe(405);
  });
});
