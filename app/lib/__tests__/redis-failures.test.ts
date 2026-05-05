/**
 * Failure-mode tests for the optional Redis singleton.
 *
 * These complement redis.test.ts and focus on the unhappy paths:
 *   - REDIS_URL with invalid format (still constructs lazily, doesn't throw).
 *   - Lazy connect: getRedis() must not perform an actual connection.
 *   - Error event handler: logs once, suppresses subsequent failures.
 *   - "ready" event resets the suppression flag and emits a reconnect log.
 *   - closeRedis() with no client / repeated calls is safe.
 *
 * We mock ioredis so we can simulate the EventEmitter lifecycle without a
 * real network socket. Each test resets the module to clear singleton state.
 */
import { EventEmitter } from "node:events";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ORIG_ENV = { ...process.env };

// A tiny stub that mimics the parts of ioredis we exercise: constructor,
// EventEmitter, and a quit() that may resolve or reject. Each instance
// exposes the constructor args so the test can assert on them.
class FakeRedis extends EventEmitter {
  static instances: FakeRedis[] = [];
  static throwOnConstruct = false;
  args: unknown[];
  quitImpl: () => Promise<unknown> = async () => "OK";
  constructor(...args: unknown[]) {
    super();
    if (FakeRedis.throwOnConstruct) {
      // Allow simulating a constructor blow-up (e.g. parse error path).
      throw new Error("constructor blew up");
    }
    this.args = args;
    FakeRedis.instances.push(this);
  }
  async quit() {
    return this.quitImpl();
  }
}

vi.mock("ioredis", () => ({
  Redis: FakeRedis,
}));

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIG_ENV };
  delete process.env.REDIS_URL;
  FakeRedis.instances = [];
  FakeRedis.throwOnConstruct = false;
  vi.restoreAllMocks();
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
});

describe("redis singleton — failure modes", () => {
  it("REDIS_URL with invalid format does not throw at getRedis() (lazy)", async () => {
    process.env.REDIS_URL = "not-a-real-url://???";
    const { getRedis, closeRedis } = await import("../redis.server");
    // Should construct (FakeRedis is forgiving) and return a client even
    // though the URL is garbage — the failure surfaces later as an "error"
    // event, not as a synchronous throw at get-time.
    const c = getRedis();
    expect(c).not.toBeNull();
    expect(FakeRedis.instances.length).toBe(1);
    await closeRedis();
  });

  it("constructor throw is caught; getRedis() returns null instead of crashing", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    FakeRedis.throwOnConstruct = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getRedis } = await import("../redis.server");
    expect(getRedis()).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0] ?? "")).toContain("[redis]");
  });

  it("client is built with lazyConnect:true (no eager connection)", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const { getRedis, closeRedis } = await import("../redis.server");
    getRedis();
    expect(FakeRedis.instances.length).toBe(1);
    const opts = FakeRedis.instances[0].args[1] as Record<string, unknown>;
    expect(opts.lazyConnect).toBe(true);
    expect(opts.maxRetriesPerRequest).toBe(2);
    expect(opts.enableReadyCheck).toBe(true);
    await closeRedis();
  });

  it("retryStrategy caps backoff at 5000ms", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const { getRedis, closeRedis } = await import("../redis.server");
    getRedis();
    const opts = FakeRedis.instances[0].args[1] as {
      retryStrategy: (n: number) => number;
    };
    expect(opts.retryStrategy(1)).toBe(200);
    expect(opts.retryStrategy(10)).toBe(2000);
    expect(opts.retryStrategy(100)).toBe(5000);
    expect(opts.retryStrategy(1_000_000)).toBe(5000);
    await closeRedis();
  });

  it("subsequent getRedis() calls return the same singleton (init only once)", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const { getRedis, closeRedis } = await import("../redis.server");
    const a = getRedis();
    const b = getRedis();
    const c = getRedis();
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(FakeRedis.instances.length).toBe(1);
    await closeRedis();
  });

  it("error event is logged once; subsequent errors are suppressed", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getRedis, closeRedis } = await import("../redis.server");
    const c = getRedis() as unknown as FakeRedis;
    c.emit("error", new Error("ECONNREFUSED #1"));
    c.emit("error", new Error("ECONNREFUSED #2"));
    c.emit("error", new Error("ECONNREFUSED #3"));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("[redis] connection error");
    expect(String(warn.mock.calls[0][1])).toContain("ECONNREFUSED #1");
    await closeRedis();
  });

  it("non-Error error payload is stringified (no crash on weird emit)", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { getRedis, closeRedis } = await import("../redis.server");
    const c = getRedis() as unknown as FakeRedis;
    c.emit("error", "weird-string-error");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][1])).toBe("weird-string-error");
    await closeRedis();
  });

  it("'ready' event resets the failure flag and logs reconnect once", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { getRedis, closeRedis } = await import("../redis.server");
    const c = getRedis() as unknown as FakeRedis;

    // First failure → one warn.
    c.emit("error", new Error("boom"));
    expect(warn).toHaveBeenCalledTimes(1);

    // Reconnect → info log, flag reset.
    c.emit("ready");
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toContain("[redis] reconnected");

    // Next failure should log again because the flag was reset.
    c.emit("error", new Error("boom-again"));
    expect(warn).toHaveBeenCalledTimes(2);
    await closeRedis();
  });

  it("'ready' event when no prior failure does not emit a reconnect log", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const { getRedis, closeRedis } = await import("../redis.server");
    const c = getRedis() as unknown as FakeRedis;
    c.emit("ready");
    expect(info).not.toHaveBeenCalled();
    await closeRedis();
  });

  it("REDIS_URL that is whitespace-only is treated as unset", async () => {
    process.env.REDIS_URL = "   \t  ";
    const { getRedis } = await import("../redis.server");
    expect(getRedis()).toBeNull();
    expect(FakeRedis.instances.length).toBe(0);
  });

  it("closeRedis() with no client is a no-op and resolves", async () => {
    const { closeRedis } = await import("../redis.server");
    await expect(closeRedis()).resolves.toBeUndefined();
    await expect(closeRedis()).resolves.toBeUndefined();
  });

  it("closeRedis() swallows quit() rejection (best-effort)", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const { getRedis, closeRedis } = await import("../redis.server");
    const c = getRedis() as unknown as FakeRedis;
    c.quitImpl = async () => {
      throw new Error("quit failed");
    };
    await expect(closeRedis()).resolves.toBeUndefined();
  });

  it("closeRedis() resets state so next getRedis() rebuilds the client", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const { getRedis, closeRedis } = await import("../redis.server");
    const first = getRedis();
    expect(first).not.toBeNull();
    await closeRedis();
    const second = getRedis();
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(FakeRedis.instances.length).toBe(2);
    await closeRedis();
  });

  it("__setRedisForTests(null) clears state and forces re-read of REDIS_URL", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const { getRedis, __setRedisForTests, closeRedis } = await import("../redis.server");
    const a = getRedis();
    expect(a).not.toBeNull();
    __setRedisForTests(null);
    // Now REDIS_URL is read again on next getRedis().
    const b = getRedis();
    expect(b).not.toBeNull();
    expect(b).not.toBe(a);
    await closeRedis();
  });
});
