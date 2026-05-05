import { describe, it, expect, vi, beforeEach } from "vitest";

const { runReadinessChecksMock } = vi.hoisted(() => ({
  runReadinessChecksMock: vi.fn(),
}));

vi.mock("../../lib/observability/health.server", () => ({
  runReadinessChecks: runReadinessChecksMock,
}));

import { loader } from "../api.readyz";

beforeEach(() => {
  runReadinessChecksMock.mockReset();
});

async function callLoader() {
  const req = new Request("https://app.example/api/readyz");
  return loader({ request: req, params: {}, context: {} } as never);
}

describe("GET /api/readyz — coverage", () => {
  it("OK: returns 200 when readiness status is 'ok'", async () => {
    runReadinessChecksMock.mockResolvedValueOnce({
      status: "ok",
      checks: { db: "ok", fynd: "ok" },
    });
    const res = await callLoader();
    expect(res.status).toBe(200);
  });

  it("OK: passes through full result body", async () => {
    const payload = {
      status: "ok" as const,
      checks: { db: "ok", fynd: "ok", breakers: "closed" },
      meta: { latencyMs: 12 },
    };
    runReadinessChecksMock.mockResolvedValueOnce(payload);
    const res = await callLoader();
    const body = await res.json();
    expect(body).toEqual(payload);
  });

  it("OK: sets Cache-Control: no-store on healthy responses", async () => {
    runReadinessChecksMock.mockResolvedValueOnce({ status: "ok", checks: {} });
    const res = await callLoader();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("Degraded: returns 503 when readiness status is 'degraded'", async () => {
    runReadinessChecksMock.mockResolvedValueOnce({
      status: "degraded",
      checks: { db: "fail" },
    });
    const res = await callLoader();
    expect(res.status).toBe(503);
  });

  it("Degraded: body reflects degraded status and check details", async () => {
    runReadinessChecksMock.mockResolvedValueOnce({
      status: "degraded",
      checks: { db: "ok", fynd: "fail" },
      reason: "fynd unreachable",
    });
    const res = await callLoader();
    const body = await res.json();
    expect(body.status).toBe("degraded");
    expect(body.checks.fynd).toBe("fail");
    expect(body.reason).toBe("fynd unreachable");
  });

  it("Degraded: still sets no-store cache header", async () => {
    runReadinessChecksMock.mockResolvedValueOnce({ status: "degraded", checks: {} });
    const res = await callLoader();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("Degraded: any non-'ok' status falls into 503 branch", async () => {
    runReadinessChecksMock.mockResolvedValueOnce({ status: "unknown", checks: {} });
    const res = await callLoader();
    expect(res.status).toBe(503);
  });

  it("invokes runReadinessChecks exactly once per request", async () => {
    runReadinessChecksMock.mockResolvedValueOnce({ status: "ok", checks: {} });
    await callLoader();
    expect(runReadinessChecksMock).toHaveBeenCalledTimes(1);
  });
});
