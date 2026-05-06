/**
 * Coverage gap tests for app/db.server.ts and app/shopify.server.ts.
 *
 * These two files do most of their work at module-import time (they wire up
 * Prisma listeners, kick off a pool-monitoring interval, and call shopifyApp
 * with a config object containing an `afterAuth` hook). To exercise every
 * branch we mock @prisma/client and @shopify/shopify-app-react-router/server
 * before each isolated module re-import via vi.resetModules.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Shared module-level state captured by the mocks below.
// ---------------------------------------------------------------------------
type EventHandler = (e: any) => void;
const handlers: Record<string, EventHandler> = {};
const observerCallbacks: Array<(observer: any) => void> = [];
let queryRawImpl: () => Promise<any> = async () => [{ active: 0n, idle: 0n }];

const loggerWarn = vi.fn();
const loggerError = vi.fn();
const queryDurationRecord = vi.fn();
const addCallbackActive = vi.fn((cb: any) => observerCallbacks.push(cb));
const addCallbackIdle = vi.fn((cb: any) => observerCallbacks.push(cb));

// Capture intervals so we can clear them between tests (the source schedules
// a 30s interval at import time; each fresh import schedules another).
const setIntervalSpy = vi.spyOn(global, "setInterval");

// ---------------------------------------------------------------------------
// @prisma/client mock — keep ALL state inside the factory so vi.resetModules
// won't blow up on the hoisted vi.mock factory's outer references.
// ---------------------------------------------------------------------------
vi.mock("@prisma/client", () => {
  class PrismaClient {
    $on(event: string, fn: EventHandler) {
      handlers[event] = fn;
    }
    async $queryRaw() {
      return queryRawImpl();
    }
  }
  return { PrismaClient };
});

// ---------------------------------------------------------------------------
// observability mocks — keep contracts tight so we can assert the side
// effects (slow-query log, error log, observer registration).
// ---------------------------------------------------------------------------
vi.mock("../lib/observability/logger.server", () => ({
  prismaLogger: { warn: loggerWarn, error: loggerError },
}));

vi.mock("../lib/observability/metrics.server", () => ({
  dbQueryDuration: { record: queryDurationRecord },
  dbPoolActive: { addCallback: addCallbackActive },
  dbPoolIdle: { addCallback: addCallbackIdle },
}));

// ---------------------------------------------------------------------------
// @shopify/shopify-app-react-router/server + adapter + session storage mocks
// ---------------------------------------------------------------------------
const shopifyAppCalls: any[] = [];
const graphqlMock = vi.fn(async () => ({ ok: true }));
const unauthenticatedAdminMock = vi.fn(async () => ({
  admin: { graphql: graphqlMock },
}));

vi.mock("@shopify/shopify-app-react-router/adapters/node", () => ({}));

vi.mock("@shopify/shopify-app-react-router/server", () => {
  const ApiVersion = { January26: "2026-01" };
  const AppDistribution = { AppStore: "app_store" };
  function shopifyApp(config: any) {
    shopifyAppCalls.push(config);
    const fakeShopify: any = {
      addDocumentResponseHeaders: vi.fn(),
      authenticate: { admin: vi.fn() },
      unauthenticated: { admin: unauthenticatedAdminMock },
      login: vi.fn(),
      registerWebhooks: vi.fn(),
      sessionStorage: { kind: "prisma-session-storage" },
    };
    return fakeShopify;
  }
  return { ApiVersion, AppDistribution, shopifyApp };
});

vi.mock("@shopify/shopify-app-session-storage-prisma", () => {
  return {
    PrismaSessionStorage: class {
      constructor(public client: unknown) {}
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function clearCapturedState() {
  for (const k of Object.keys(handlers)) delete handlers[k];
  observerCallbacks.length = 0;
  shopifyAppCalls.length = 0;
  loggerWarn.mockClear();
  loggerError.mockClear();
  queryDurationRecord.mockClear();
  addCallbackActive.mockClear();
  addCallbackIdle.mockClear();
  graphqlMock.mockClear();
  unauthenticatedAdminMock.mockClear();
  // Wipe any cross-test prisma cached on globalThis so the dev-mode branch
  // is reachable on re-import.
  delete (globalThis as any).prismaGlobal;
}

async function freshDbImport(): Promise<typeof import("../db.server")> {
  vi.resetModules();
  clearCapturedState();
  setIntervalSpy.mockClear();
  return await import("../db.server");
}

afterAll(() => {
  // Clear every interval the source code installed so the test process can
  // exit cleanly. unref()'d intervals would let it exit anyway, but this
  // keeps node teardown noise minimal.
  for (const call of setIntervalSpy.mock.results) {
    if (call.value) clearInterval(call.value as any);
  }
  setIntervalSpy.mockRestore();
});

// ===========================================================================
// db.server.ts
// ===========================================================================

describe("db.server.ts", () => {
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    process.env.NODE_ENV = "test"; // non-production by default
  });

  afterAll(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("registers query/warn/error listeners and observer callbacks at import time", async () => {
    await freshDbImport();
    expect(handlers.query).toBeTypeOf("function");
    expect(handlers.warn).toBeTypeOf("function");
    expect(handlers.error).toBeTypeOf("function");
    expect(addCallbackActive).toHaveBeenCalledTimes(1);
    expect(addCallbackIdle).toHaveBeenCalledTimes(1);
  });

  it("query handler records duration and does NOT warn for fast queries", async () => {
    await freshDbImport();
    handlers.query({ duration: 5, query: "SELECT 1", target: "pg" });
    expect(queryDurationRecord).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ "db.slow": "false" }),
    );
    expect(loggerWarn).not.toHaveBeenCalled();
  });

  it("query handler logs slow queries above the 100ms threshold", async () => {
    await freshDbImport();
    const longQuery = "SELECT * FROM x ".repeat(200); // > 500 chars to exercise slice(0, 500)
    handlers.query({ duration: 250, query: longQuery, target: "pg" });
    expect(queryDurationRecord).toHaveBeenCalledWith(
      250,
      expect.objectContaining({ "db.slow": "true" }),
    );
    expect(loggerWarn).toHaveBeenCalledTimes(1);
    const [meta, msg] = loggerWarn.mock.calls[0];
    expect(meta).toMatchObject({
      params: "[REDACTED]",
      duration_ms: 250,
      target: "pg",
    });
    // truncated to 500 chars
    expect(meta.query.length).toBe(500);
    expect(msg).toContain("Slow query detected");
  });

  it("warn handler forwards to prismaLogger.warn", async () => {
    await freshDbImport();
    handlers.warn({ target: "warn-target", message: "be careful" });
    expect(loggerWarn).toHaveBeenCalledWith(
      { target: "warn-target" },
      "be careful",
    );
  });

  it("error handler forwards to prismaLogger.error", async () => {
    await freshDbImport();
    handlers.error({ target: "err-target", message: "boom" });
    expect(loggerError).toHaveBeenCalledWith(
      { target: "err-target" },
      "boom",
    );
  });

  it("dbPoolActive/dbPoolIdle observer callbacks observe poolState values", async () => {
    await freshDbImport();
    const obs = { observe: vi.fn() };
    for (const cb of observerCallbacks) cb(obs);
    expect(obs.observe).toHaveBeenCalledTimes(2);
    // both initial values are zero
    expect(obs.observe).toHaveBeenNthCalledWith(1, 0);
    expect(obs.observe).toHaveBeenNthCalledWith(2, 0);
  });

  it("pool-monitoring interval polls $queryRaw and updates poolState on success", async () => {
    queryRawImpl = async () => [{ active: 7n, idle: 3n }];
    await freshDbImport();

    // Find the interval handler that was installed for pollConnectionPool.
    const installed = setIntervalSpy.mock.calls.find(
      ([, ms]) => ms === 30_000,
    );
    expect(installed).toBeDefined();
    const fn = installed![0] as () => Promise<void>;
    await fn();

    const obs = { observe: vi.fn() };
    for (const cb of observerCallbacks) cb(obs);
    expect(obs.observe).toHaveBeenNthCalledWith(1, 7);
    expect(obs.observe).toHaveBeenNthCalledWith(2, 3);
  });

  it("pool-monitoring tolerates an empty result array (result[0] falsy branch)", async () => {
    queryRawImpl = async () => [];
    await freshDbImport();
    const installed = setIntervalSpy.mock.calls.find(
      ([, ms]) => ms === 30_000,
    );
    const fn = installed![0] as () => Promise<void>;
    await expect(fn()).resolves.toBeUndefined();

    const obs = { observe: vi.fn() };
    for (const cb of observerCallbacks) cb(obs);
    // poolState remains the default zeros
    expect(obs.observe).toHaveBeenNthCalledWith(1, 0);
    expect(obs.observe).toHaveBeenNthCalledWith(2, 0);
  });

  it("pool-monitoring swallows $queryRaw errors (catch branch)", async () => {
    queryRawImpl = async () => {
      throw new Error("db down");
    };
    await freshDbImport();
    const installed = setIntervalSpy.mock.calls.find(
      ([, ms]) => ms === 30_000,
    );
    const fn = installed![0] as () => Promise<void>;
    await expect(fn()).resolves.toBeUndefined(); // does not throw
  });

  it("non-production memoizes the client on globalThis.prismaGlobal", async () => {
    process.env.NODE_ENV = "development";
    const first = await freshDbImport();
    expect((globalThis as any).prismaGlobal).toBeDefined();
    // Re-importing without clearing globalThis should re-use the same client.
    vi.resetModules();
    const second = await import("../db.server");
    expect(second.default).toBe((globalThis as any).prismaGlobal);
    expect(first.default).toBe((globalThis as any).prismaGlobal);
  });

  it("production mode does not memoize on globalThis", async () => {
    process.env.NODE_ENV = "production";
    delete (globalThis as any).prismaGlobal;
    await freshDbImport();
    process.env.NODE_ENV = "production"; // freshDbImport resets via clearCapturedState; ensure value
    // Re-import in production must not have set globalThis.prismaGlobal
    expect((globalThis as any).prismaGlobal).toBeUndefined();
  });
});

// ===========================================================================
// shopify.server.ts
// ===========================================================================

describe("shopify.server.ts", () => {
  async function freshShopifyImport(): Promise<typeof import("../shopify.server")> {
    vi.resetModules();
    clearCapturedState();
    return await import("../shopify.server");
  }

  beforeEach(() => {
    process.env.NODE_ENV = "test";
  });

  it("calls shopifyApp with the expected static config and re-exports helpers", async () => {
    delete process.env.SHOP_CUSTOM_DOMAIN;
    process.env.SHOPIFY_API_KEY = "key-abc";
    process.env.SHOPIFY_API_SECRET = "secret-abc";
    process.env.SCOPES = "read_products,write_orders";
    process.env.SHOPIFY_APP_URL = "https://app.example.com";

    const mod = await freshShopifyImport();

    expect(shopifyAppCalls).toHaveLength(1);
    const cfg = shopifyAppCalls[0];
    expect(cfg.apiKey).toBe("key-abc");
    expect(cfg.apiSecretKey).toBe("secret-abc");
    expect(cfg.scopes).toEqual(["read_products", "write_orders"]);
    expect(cfg.appUrl).toBe("https://app.example.com");
    expect(cfg.authPathPrefix).toBe("/auth");
    expect(cfg.distribution).toBe("app_store");
    expect(cfg.future).toEqual({ expiringOfflineAccessTokens: true });
    expect(cfg.sessionStorage).toBeDefined();
    expect("customShopDomains" in cfg).toBe(false);

    // Re-exports
    expect(mod.apiVersion).toBe("2026-01");
    expect(typeof mod.addDocumentResponseHeaders).toBe("function");
    expect(mod.authenticate).toBeDefined();
    expect(mod.unauthenticated).toBeDefined();
    expect(typeof mod.login).toBe("function");
    expect(typeof mod.registerWebhooks).toBe("function");
    expect(mod.sessionStorage).toEqual({ kind: "prisma-session-storage" });
    expect(mod.default).toBeDefined();
  });

  it("falls back to safe defaults when API secret and app URL are unset", async () => {
    delete process.env.SHOPIFY_API_SECRET;
    delete process.env.SHOPIFY_APP_URL;
    delete process.env.SCOPES;
    delete process.env.SHOP_CUSTOM_DOMAIN;
    delete process.env.SHOPIFY_API_KEY;

    await freshShopifyImport();
    const cfg = shopifyAppCalls[0];
    expect(cfg.apiSecretKey).toBe("");
    expect(cfg.appUrl).toBe("");
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.scopes).toBeUndefined();
    expect("customShopDomains" in cfg).toBe(false);
  });

  it("propagates SHOP_CUSTOM_DOMAIN into customShopDomains when set", async () => {
    process.env.SHOP_CUSTOM_DOMAIN = "custom.shop.example";
    await freshShopifyImport();
    const cfg = shopifyAppCalls[0];
    expect(cfg.customShopDomains).toEqual(["custom.shop.example"]);
    delete process.env.SHOP_CUSTOM_DOMAIN;
  });

  it("afterAuth hook calls metafieldDefinitionCreate via unauthenticated.admin", async () => {
    delete process.env.SHOP_CUSTOM_DOMAIN;
    await freshShopifyImport();
    const cfg = shopifyAppCalls[0];
    const session = { shop: "demo.myshopify.com" };

    await cfg.hooks.afterAuth({ session });

    expect(unauthenticatedAdminMock).toHaveBeenCalledWith("demo.myshopify.com");
    expect(graphqlMock).toHaveBeenCalledTimes(1);
    const call = graphqlMock.mock.calls[0] as unknown as [string, { variables: { definition: any } }];
    expect(call[0]).toContain("metafieldDefinitionCreate");
    expect(call[1].variables.definition).toMatchObject({
      key: "fynd_order_id",
      namespace: "$app",
      ownerType: "ORDER",
      type: "single_line_text_field",
    });
    expect(call[1].variables.definition.capabilities).toEqual({
      adminFilterable: { enabled: true },
    });
  });

  it("afterAuth hook swallows graphql errors silently (idempotent path)", async () => {
    delete process.env.SHOP_CUSTOM_DOMAIN;
    await freshShopifyImport();
    const cfg = shopifyAppCalls[0];
    graphqlMock.mockRejectedValueOnce(new Error("definition exists"));

    await expect(
      cfg.hooks.afterAuth({ session: { shop: "demo.myshopify.com" } }),
    ).resolves.toBeUndefined();
  });

  it("afterAuth hook swallows unauthenticated.admin failures", async () => {
    delete process.env.SHOP_CUSTOM_DOMAIN;
    await freshShopifyImport();
    const cfg = shopifyAppCalls[0];
    unauthenticatedAdminMock.mockRejectedValueOnce(new Error("no session"));

    await expect(
      cfg.hooks.afterAuth({ session: { shop: "broken.myshopify.com" } }),
    ).resolves.toBeUndefined();
    // graphql should not have been called because admin() rejected first
    expect(graphqlMock).not.toHaveBeenCalled();
  });
});
