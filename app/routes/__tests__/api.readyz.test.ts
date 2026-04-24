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

describe("GET /api/readyz", () => {
  it("returns 200 with body when status=ok", async () => {
    runReadinessChecksMock.mockResolvedValueOnce({ status: "ok", checks: { db: "ok" } });
    const res = await callLoader();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns 503 when status=degraded", async () => {
    runReadinessChecksMock.mockResolvedValueOnce({ status: "degraded", checks: { db: "fail" } });
    const res = await callLoader();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe("degraded");
  });

  it("sets no-store cache-control header on both paths", async () => {
    runReadinessChecksMock.mockResolvedValueOnce({ status: "degraded" });
    const res = await callLoader();
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });
});
