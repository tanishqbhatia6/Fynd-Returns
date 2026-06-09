import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { prismaMock, fetchSpy } = vi.hoisted(() => ({
  prismaMock: {
    $queryRaw: vi.fn(),
  },
  fetchSpy: vi.fn(),
}));

vi.mock("../../db.server", () => ({ default: prismaMock }));

vi.mock("../observability/metrics.server", () => ({
  healthCheckDuration: { record: vi.fn() },
  redisHealthStatus: { addCallback: vi.fn() },
}));

vi.mock("../redis.server", () => ({
  getRedis: vi.fn(() => null),
}));

vi.mock("../observability/resilience.server", () => ({
  getAllCircuitBreakerStatuses: () => [
    { name: "fynd", state: "closed", stateNumeric: 0, failureCount: 0, lastStateChange: 0 },
    { name: "shopify", state: "closed", stateNumeric: 0, failureCount: 0, lastStateChange: 0 },
    { name: "smtp", state: "closed", stateNumeric: 0, failureCount: 0, lastStateChange: 0 },
    { name: "whatsapp", state: "closed", stateNumeric: 0, failureCount: 0, lastStateChange: 0 },
  ],
}));

import {
  checkDatabase,
  checkFyndApi,
  checkRedis,
  runReadinessChecks,
} from "../observability/health.server";

beforeEach(() => {
  prismaMock.$queryRaw.mockReset();
  fetchSpy.mockReset();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("checkDatabase", () => {
  it("returns ok on successful query", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    const res = await checkDatabase();
    expect(res.status).toBe("ok");
    expect(typeof res.latencyMs).toBe("number");
    expect(res.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("returns error when query throws", async () => {
    prismaMock.$queryRaw.mockRejectedValue(new Error("connection refused"));
    const res = await checkDatabase();
    expect(res.status).toBe("error");
    expect(res.message).toMatch(/connection refused/);
  });

  it("returns error on timeout", async () => {
    // $queryRaw resolves after 5s — withTimeout's 3s limit should reject first.
    prismaMock.$queryRaw.mockImplementation(() => new Promise((r) => setTimeout(r, 5000)));
    vi.useFakeTimers();
    const promise = checkDatabase();
    vi.advanceTimersByTime(3500);
    vi.useRealTimers();
    const res = await promise;
    expect(res.status).toBe("error");
    expect(res.message).toMatch(/timed out/);
  });
});

describe("checkFyndApi", () => {
  it("returns ok on any response (even 4xx)", async () => {
    fetchSpy.mockResolvedValue({ status: 401 });
    const res = await checkFyndApi();
    expect(res.status).toBe("ok");
  });

  it("returns degraded on network failure", async () => {
    fetchSpy.mockRejectedValue(new Error("ENOTFOUND"));
    const res = await checkFyndApi();
    expect(res.status).toBe("degraded");
    expect(res.message).toMatch(/ENOTFOUND/);
  });

  it("sends a HEAD request (no body)", async () => {
    fetchSpy.mockResolvedValue({ status: 200 });
    await checkFyndApi();
    const [, init] = fetchSpy.mock.calls[0];
    expect((init as { method: string }).method).toBe("HEAD");
  });
});

describe("checkRedis", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("is ok when Redis is disabled outside production", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.REDIS_URL;
    const res = await checkRedis();
    expect(res.status).toBe("ok");
  });

  it("is an error when Redis is missing in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.REDIS_URL;
    const res = await checkRedis();
    expect(res.status).toBe("error");
    expect(res.message).toMatch(/REDIS_URL/);
  });
});

describe("runReadinessChecks", () => {
  it("returns ok when all checks pass", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ ok: 1 }]);
    fetchSpy.mockResolvedValue({ status: 200 });
    const res = await runReadinessChecks();
    expect(res.status).toBe("ok");
    expect(res.checks.database.status).toBe("ok");
    expect(res.checks.fynd_api.status).toBe("ok");
    expect(res.circuitBreakers).toHaveLength(4);
    expect(typeof res.uptime).toBe("number");
    expect(res.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("returns degraded when DB is down", async () => {
    prismaMock.$queryRaw.mockRejectedValue(new Error("DB down"));
    fetchSpy.mockResolvedValue({ status: 200 });
    const res = await runReadinessChecks();
    expect(res.status).toBe("degraded");
    expect(res.checks.database.status).toBe("error");
  });

  it("returns degraded when Fynd is unreachable", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ ok: 1 }]);
    fetchSpy.mockRejectedValue(new Error("ENOTFOUND"));
    const res = await runReadinessChecks();
    expect(res.status).toBe("degraded");
    expect(res.checks.fynd_api.status).toBe("degraded");
  });

  it("includes version from BUILD_VERSION env or 'dev'", async () => {
    process.env.BUILD_VERSION = "1.2.3";
    prismaMock.$queryRaw.mockResolvedValue([]);
    fetchSpy.mockResolvedValue({ status: 200 });
    const res = await runReadinessChecks();
    expect(res.version).toBe("1.2.3");
    delete process.env.BUILD_VERSION;
  });

  it("defaults version to 'dev' when BUILD_VERSION unset", async () => {
    delete process.env.BUILD_VERSION;
    prismaMock.$queryRaw.mockResolvedValue([]);
    fetchSpy.mockResolvedValue({ status: 200 });
    const res = await runReadinessChecks();
    expect(res.version).toBe("dev");
  });
});
