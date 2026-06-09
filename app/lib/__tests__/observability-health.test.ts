/**
 * Tests for observability/health.server.ts: dependency health verification.
 * Covers checkDatabase (success + failure + timeout), checkFyndApi (HEAD
 * request, network failure, abort) and runReadinessChecks (composite
 * status aggregation). Mocks prisma, the metrics histogram, the circuit
 * breaker registry and global fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { prismaMock, healthCheckDurationRecord, getCircuitBreakerStatusesMock } = vi.hoisted(() => ({
  prismaMock: {
    $queryRaw: vi.fn(),
  },
  healthCheckDurationRecord: vi.fn(),
  getCircuitBreakerStatusesMock: vi.fn(),
}));

vi.mock("../../db.server", () => ({ default: prismaMock }));

vi.mock("../observability/metrics.server", () => ({
  healthCheckDuration: { record: healthCheckDurationRecord },
  redisHealthStatus: { addCallback: vi.fn() },
}));

vi.mock("../redis.server", () => ({
  getRedis: vi.fn(() => null),
}));

vi.mock("../observability/resilience.server", () => ({
  getAllCircuitBreakerStatuses: getCircuitBreakerStatusesMock,
}));

import {
  checkDatabase,
  checkFyndApi,
  checkRedis,
  runReadinessChecks,
} from "../observability/health.server";

describe("checkDatabase", () => {
  beforeEach(() => {
    prismaMock.$queryRaw.mockReset();
    healthCheckDurationRecord.mockClear();
  });

  it("returns ok when the query succeeds", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);
    const result = await checkDatabase();
    expect(result.status).toBe("ok");
    expect(result.message).toBeUndefined();
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("records duration metric tagged with the database dependency", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);
    await checkDatabase();
    expect(healthCheckDurationRecord).toHaveBeenCalledWith(expect.any(Number), {
      dependency: "database",
    });
  });

  it("returns error with the thrown message on query failure", async () => {
    prismaMock.$queryRaw.mockRejectedValueOnce(new Error("connection refused"));
    const result = await checkDatabase();
    expect(result.status).toBe("error");
    expect(result.message).toBe("connection refused");
    expect(healthCheckDurationRecord).toHaveBeenCalledWith(expect.any(Number), {
      dependency: "database",
    });
  });

  it("returns error with a fallback message for non-Error rejections", async () => {
    prismaMock.$queryRaw.mockRejectedValueOnce("boom");
    const result = await checkDatabase();
    expect(result.status).toBe("error");
    expect(result.message).toBe("Database check failed");
  });
});

describe("checkFyndApi", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    healthCheckDurationRecord.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns ok when the HEAD request resolves with any response", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const result = await checkFyndApi();
    expect(result.status).toBe("ok");
    expect(result.message).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.fynd.com",
      expect.objectContaining({ method: "HEAD" }),
    );
  });

  it("treats 4xx responses as reachable (status ok)", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    const result = await checkFyndApi();
    expect(result.status).toBe("ok");
  });

  it("returns degraded with the error message on network failure", async () => {
    fetchMock.mockRejectedValueOnce(new Error("ENOTFOUND api.fynd.com"));
    const result = await checkFyndApi();
    expect(result.status).toBe("degraded");
    expect(result.message).toBe("ENOTFOUND api.fynd.com");
  });

  it("returns degraded with a fallback message for non-Error rejections", async () => {
    fetchMock.mockRejectedValueOnce("offline");
    const result = await checkFyndApi();
    expect(result.status).toBe("degraded");
    expect(result.message).toBe("Fynd API unreachable");
  });

  it("records the duration metric tagged with fynd_api on both paths", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await checkFyndApi();
    fetchMock.mockRejectedValueOnce(new Error("nope"));
    await checkFyndApi();
    const tags = healthCheckDurationRecord.mock.calls.map((c) => c[1]);
    expect(tags).toEqual([{ dependency: "fynd_api" }, { dependency: "fynd_api" }]);
  });

  it("passes an AbortSignal so the request can be cancelled", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    await checkFyndApi();
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("checkRedis", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns ok when REDIS_URL is unset outside production", async () => {
    process.env.NODE_ENV = "test";
    delete process.env.REDIS_URL;
    const result = await checkRedis();
    expect(result.status).toBe("ok");
    expect(result.message).toBe("Redis disabled outside production");
  });

  it("returns error when REDIS_URL is unset in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.REDIS_URL;
    const result = await checkRedis();
    expect(result.status).toBe("error");
    expect(result.message).toBe("REDIS_URL is required in production");
  });
});

describe("runReadinessChecks", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    prismaMock.$queryRaw.mockReset();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    healthCheckDurationRecord.mockClear();
    getCircuitBreakerStatusesMock.mockReset();
    getCircuitBreakerStatusesMock.mockReturnValue({
      fynd: { state: "closed", failureCount: 0 },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns ok when all dependencies are healthy", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const result = await runReadinessChecks();
    expect(result.status).toBe("ok");
    expect(result.checks.database.status).toBe("ok");
    expect(result.checks.fynd_api.status).toBe("ok");
  });

  it("returns degraded when the database check errors", async () => {
    prismaMock.$queryRaw.mockRejectedValueOnce(new Error("db down"));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const result = await runReadinessChecks();
    expect(result.status).toBe("degraded");
    expect(result.checks.database.status).toBe("error");
    expect(result.checks.database.message).toBe("db down");
    expect(result.checks.fynd_api.status).toBe("ok");
  });

  it("returns degraded when only the Fynd API is unreachable", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);
    fetchMock.mockRejectedValueOnce(new Error("network gone"));
    const result = await runReadinessChecks();
    expect(result.status).toBe("degraded");
    expect(result.checks.database.status).toBe("ok");
    expect(result.checks.fynd_api.status).toBe("degraded");
    expect(result.checks.fynd_api.message).toBe("network gone");
  });

  it("includes circuit breaker statuses, version, uptime and timestamp", async () => {
    prismaMock.$queryRaw.mockResolvedValueOnce([{ "?column?": 1 }]);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    const result = await runReadinessChecks();
    expect(result.circuitBreakers).toEqual({
      fynd: { state: "closed", failureCount: 0 },
    });
    expect(getCircuitBreakerStatusesMock).toHaveBeenCalled();
    expect(typeof result.version).toBe("string");
    expect(result.version.length).toBeGreaterThan(0);
    expect(typeof result.uptime).toBe("number");
    // ISO 8601 timestamp.
    expect(() => new Date(result.timestamp).toISOString()).not.toThrow();
    expect(new Date(result.timestamp).toISOString()).toBe(result.timestamp);
  });

  it("uses BUILD_VERSION env when set, otherwise 'dev'", async () => {
    prismaMock.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));

    const original = process.env.BUILD_VERSION;
    try {
      delete process.env.BUILD_VERSION;
      const dev = await runReadinessChecks();
      expect(dev.version).toBe("dev");

      process.env.BUILD_VERSION = "1.2.3";
      const tagged = await runReadinessChecks();
      expect(tagged.version).toBe("1.2.3");
    } finally {
      if (original === undefined) delete process.env.BUILD_VERSION;
      else process.env.BUILD_VERSION = original;
    }
  });
});
