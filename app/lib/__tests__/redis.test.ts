/**
 * Tests for the optional Redis singleton.
 *
 * Covers:
 *  - Returns null when REDIS_URL is unset.
 *  - Constructs a client when REDIS_URL is set (without actually connecting,
 *    courtesy of lazyConnect).
 *  - __setRedisForTests injects/clears the singleton for unit tests.
 *  - closeRedis cleans up gracefully even when no client exists.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ORIG_ENV = { ...process.env };

beforeEach(() => {
  vi.resetModules();
  process.env = { ...ORIG_ENV };
  delete process.env.REDIS_URL;
});

afterEach(() => {
  process.env = { ...ORIG_ENV };
});

describe("redis singleton", () => {
  it("returns null when REDIS_URL is unset", async () => {
    const { getRedis } = await import("../redis.server");
    expect(getRedis()).toBeNull();
  });

  it("returns a client when REDIS_URL is set", async () => {
    process.env.REDIS_URL = "redis://localhost:6379";
    const { getRedis, closeRedis } = await import("../redis.server");
    const client = getRedis();
    expect(client).not.toBeNull();
    // The same instance is returned on subsequent calls.
    expect(getRedis()).toBe(client);
    await closeRedis();
  });

  it("__setRedisForTests injects a client", async () => {
    const { getRedis, __setRedisForTests } = await import("../redis.server");
    const fake = { fake: true } as never;
    __setRedisForTests(fake);
    expect(getRedis()).toBe(fake);
    __setRedisForTests(null);
  });

  it("closeRedis is a no-op when no client exists", async () => {
    const { closeRedis } = await import("../redis.server");
    await expect(closeRedis()).resolves.toBeUndefined();
  });
});
