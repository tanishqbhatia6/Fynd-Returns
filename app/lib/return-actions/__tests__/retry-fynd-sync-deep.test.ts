/**
 * Deep unit tests for handleRetryFyndSync.
 *
 * The retry handler is one of the most-branched action handlers in the app:
 *  - status guard (must be approved/completed)
 *  - already-synced short circuit (redirect with already_synced)
 *  - allow retry only when fyndReturnId is missing OR sync is in failed/retry_scheduled state
 *  - fynd config error path (no settings / createFyndClientOrError fails)
 *  - storefront-only client (no getShipments) is rejected with a "platform required" error
 *  - createReturnOnFynd happy path: writes synced fields + event + side-effects Shopify Return
 *  - createReturnOnFynd crash: persists failed status + crashed event
 *  - createReturnOnFynd reports !success: persists failed status + failed event with error
 *  - alreadyExists path: success redirect with `already_exists` param
 *  - Shopify Return creation as side effect: only when shopifyReturnId missing AND
 *    order id is GID/numeric AND not green return; failures are non-fatal
 *
 * Pattern adapted from extracted-handlers.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../../test/prisma-mock";

const {
  prismaMock,
  createFyndClientOrErrorMock,
  createReturnOnFyndMock,
  fetchOrderMock,
  fetchOrderByOrderNumberMock,
  createShopifyReturnMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  createFyndClientOrErrorMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  createReturnOnFyndMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  fetchOrderMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  fetchOrderByOrderNumberMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
  createShopifyReturnMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../../db.server", () => ({ default: prismaMock }));
vi.mock("../../fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
}));
vi.mock("../../fynd-returns.server", () => ({
  createReturnOnFynd: createReturnOnFyndMock,
}));
vi.mock("../../shopify-admin.server", () => ({
  fetchOrder: fetchOrderMock,
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
  createShopifyReturn: createShopifyReturnMock,
}));

import { handleRetryFyndSync } from "../retry-fynd-sync.server";
import type { ReturnHandlerContext, ReturnActionBody } from "../types";

const RETRY_BODY = { action: "retry_fynd_sync" } as ReturnActionBody;

function mkClient(overrides: Record<string, unknown> = {}) {
  return { getShipments: vi.fn(async () => ({ items: [] })), ...overrides };
}

function mkCtx(overrides: Partial<ReturnHandlerContext> = {}): ReturnHandlerContext {
  const base = {
    id: "rc-1",
    returnCase: {
      id: "rc-1",
      status: "approved",
      returnRequestNo: "RQ-1",
      shopifyOrderId: "gid://shopify/Order/1",
      shopifyOrderName: "#1001",
      shopifyReturnId: null,
      fyndReturnId: null,
      fyndShipmentId: null,
      fyndSyncStatus: null,
      fyndSyncRetries: 0,
      customerAddress1: null,
      customerCity: null,
      isGreenReturn: false,
      createdAt: new Date("2024-01-01T00:00:00Z"),
      items: [],
    } as never,
    shop: {
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndApiType: "platform" },
    },
    admin: { graphql: vi.fn() } as never,
    shopDomain: "store.myshopify.com",
    sessionEmail: "admin@example.com",
    isTerminal: false,
    elapsed: () => 100,
    logShopifyReturnEvent: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  } as ReturnHandlerContext;
  return { ...base, ...overrides };
}

async function expectRedirect(p: Promise<unknown>, expectedFrag: string) {
  try {
    await p;
    throw new Error("expected handler to throw a redirect");
  } catch (err) {
    expect(err).toBeInstanceOf(Response);
    const res = err as Response;
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("Location")).toContain(expectedFrag);
  }
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  createFyndClientOrErrorMock.mockReset();
  createReturnOnFyndMock.mockReset();
  fetchOrderMock.mockReset().mockResolvedValue(null);
  fetchOrderByOrderNumberMock.mockReset().mockResolvedValue(null);
  createShopifyReturnMock
    .mockReset()
    .mockResolvedValue({ success: true, shopifyReturnId: "gid://shopify/Return/99" });
});

describe("handleRetryFyndSync — status guard", () => {
  it("returns 400 when status is not approved or completed", async () => {
    const res = await handleRetryFyndSync(
      mkCtx({ returnCase: { ...mkCtx().returnCase, status: "pending" } as never }),
      RETRY_BODY,
    );
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(400);
  });

  it("permits status=completed", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: false, error: "no creds" });
    await expectRedirect(
      handleRetryFyndSync(
        mkCtx({ returnCase: { ...mkCtx().returnCase, status: "completed" } as never }),
        RETRY_BODY,
      ),
      "fyndError=",
    );
  });
});

describe("handleRetryFyndSync — already-synced short-circuit", () => {
  it("redirects to already_synced when fyndReturnId set and not in failed/retry state", async () => {
    await expectRedirect(
      handleRetryFyndSync(
        mkCtx({
          returnCase: {
            ...mkCtx().returnCase,
            fyndReturnId: "FY-99",
            fyndSyncStatus: "synced",
          } as never,
        }),
        RETRY_BODY,
      ),
      "fyndSuccess=already_synced",
    );
    // Should not have invoked the Fynd client at all
    expect(createFyndClientOrErrorMock).not.toHaveBeenCalled();
  });

  it("does NOT short-circuit when sync status is failed (allows retry)", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: false, error: "transient" });
    await expectRedirect(
      handleRetryFyndSync(
        mkCtx({
          returnCase: {
            ...mkCtx().returnCase,
            fyndReturnId: "FY-99",
            fyndSyncStatus: "failed",
          } as never,
        }),
        RETRY_BODY,
      ),
      "fyndError=",
    );
    expect(createFyndClientOrErrorMock).toHaveBeenCalled();
  });

  it("does NOT short-circuit when sync status is retry_scheduled", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: false, error: "transient" });
    await expectRedirect(
      handleRetryFyndSync(
        mkCtx({
          returnCase: {
            ...mkCtx().returnCase,
            fyndReturnId: "FY-99",
            fyndSyncStatus: "retry_scheduled",
          } as never,
        }),
        RETRY_BODY,
      ),
      "fyndError=",
    );
    expect(createFyndClientOrErrorMock).toHaveBeenCalled();
  });
});

describe("handleRetryFyndSync — fynd config errors", () => {
  it("redirects with fyndError when shop has no settings", async () => {
    await expectRedirect(
      handleRetryFyndSync(
        mkCtx({
          shop: { id: "shop-1", shopDomain: "store.myshopify.com", settings: null },
        }),
        RETRY_BODY,
      ),
      "fyndError=",
    );
    // No client construction attempted — guard short-circuits
    expect(createFyndClientOrErrorMock).not.toHaveBeenCalled();
  });

  it("redirects with fyndError when createFyndClientOrError fails", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: false, error: "missing creds" });
    let captured: Response | null = null;
    try {
      await handleRetryFyndSync(mkCtx(), RETRY_BODY);
    } catch (err) {
      captured = err as Response;
    }
    expect(captured).toBeInstanceOf(Response);
    const loc = decodeURIComponent(captured!.headers.get("Location") ?? "");
    expect(loc).toContain("fyndError=");
    expect(loc).toContain("missing creds");
    // Should NOT have proceeded to call createReturnOnFynd
    expect(createReturnOnFyndMock).not.toHaveBeenCalled();
  });

  it("rejects storefront-only client (no getShipments) with platform required message", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: {
        /* no getShipments */
      },
    });
    let captured: Response | null = null;
    try {
      await handleRetryFyndSync(mkCtx(), RETRY_BODY);
    } catch (err) {
      captured = err as Response;
    }
    expect(captured).toBeInstanceOf(Response);
    const loc = decodeURIComponent(captured!.headers.get("Location") ?? "");
    expect(loc).toContain("Platform API");
    // No DB writes for this short-circuit
    expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
  });
});

describe("handleRetryFyndSync — createReturnOnFynd happy path", () => {
  it("writes synced fields + success event + redirects with fyndSuccess=1", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: mkClient() });
    createReturnOnFyndMock.mockResolvedValueOnce({
      success: true,
      fyndReturnId: "FY-RET-100",
      fyndReturnNo: "RN-100",
      fyndOrderId: "FYMP-1",
      fyndShipmentId: "SH-1",
      fyndPayload: { hello: "world" },
    });
    fetchOrderMock.mockResolvedValueOnce({ affiliateOrderId: "AFF-1" });

    await expectRedirect(handleRetryFyndSync(mkCtx(), RETRY_BODY), "fyndSuccess=1");

    const updateCalls = prismaMock.returnCase.update.mock.calls;
    const synced = updateCalls.find((c) => c[0].data?.fyndSyncStatus === "synced");
    expect(synced).toBeDefined();
    expect(synced![0].data.fyndReturnId).toBe("FY-RET-100");
    expect(synced![0].data.fyndReturnNo).toBe("RN-100");
    expect(synced![0].data.fyndOrderId).toBe("FYMP-1");
    expect(synced![0].data.fyndShipmentId).toBe("SH-1");
    expect(typeof synced![0].data.fyndPayloadJson).toBe("string");
    expect(synced![0].data.fyndSyncError).toBeNull();
    expect(synced![0].data.fyndSyncRetries).toBe(0);

    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "fynd_sync",
          source: "admin",
        }),
      }),
    );
  });

  it("redirects with fyndSuccess=already_exists when alreadyExists is true", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: mkClient() });
    createReturnOnFyndMock.mockResolvedValueOnce({
      success: true,
      alreadyExists: true,
      fyndReturnId: "FY-EXIST",
    });
    await expectRedirect(handleRetryFyndSync(mkCtx(), RETRY_BODY), "fyndSuccess=already_exists");
  });

  it("uses fetchOrderByOrderNumber when shopifyOrderId is missing", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: mkClient() });
    createReturnOnFyndMock.mockResolvedValueOnce({
      success: true,
      fyndReturnId: "FY-1",
    });
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({ affiliateOrderId: "AFF-FROM-NAME" });

    await expectRedirect(
      handleRetryFyndSync(
        mkCtx({
          returnCase: {
            ...mkCtx().returnCase,
            shopifyOrderId: null,
            shopifyOrderName: "#2002",
            shopifyReturnId: "gid://shopify/Return/1", // skip side-effect for this test
          } as never,
        }),
        RETRY_BODY,
      ),
      "fyndSuccess=1",
    );
    expect(fetchOrderByOrderNumberMock).toHaveBeenCalledWith(expect.anything(), "2002");
    expect(fetchOrderMock).not.toHaveBeenCalled();
  });

  it("skips order-fetch when shopifyOrderId starts with manual:", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: mkClient() });
    createReturnOnFyndMock.mockResolvedValueOnce({
      success: true,
      fyndReturnId: "FY-X",
    });

    await expectRedirect(
      handleRetryFyndSync(
        mkCtx({
          returnCase: {
            ...mkCtx().returnCase,
            shopifyOrderId: "manual:abc",
            shopifyReturnId: "gid://shopify/Return/1",
          } as never,
        }),
        RETRY_BODY,
      ),
      "fyndSuccess=1",
    );
    expect(fetchOrderMock).not.toHaveBeenCalled();
    expect(fetchOrderByOrderNumberMock).not.toHaveBeenCalled();
  });

  it("forwards pickup address when customer fields present", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: mkClient() });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, fyndReturnId: "FY-1" });

    await expectRedirect(
      handleRetryFyndSync(
        mkCtx({
          returnCase: {
            ...mkCtx().returnCase,
            customerAddress1: "1 Main St",
            customerCity: "Berlin",
            customerName: "Alice",
            shopifyReturnId: "gid://shopify/Return/1",
          } as never,
        }),
        RETRY_BODY,
      ),
      "fyndSuccess=1",
    );
    const args = createReturnOnFyndMock.mock.calls[0]!;
    const opts = args[2] as {
      pickupAddress: { address1: string; city: string; name: string } | null;
    };
    expect(opts.pickupAddress).not.toBeNull();
    expect(opts.pickupAddress!.address1).toBe("1 Main St");
    expect(opts.pickupAddress!.name).toBe("Alice");
  });

  it("passes targetShipmentId from existing fyndShipmentId", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: mkClient() });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, fyndReturnId: "FY-1" });

    await expectRedirect(
      handleRetryFyndSync(
        mkCtx({
          returnCase: {
            ...mkCtx().returnCase,
            fyndShipmentId: "SH-EXISTING",
            shopifyReturnId: "gid://shopify/Return/1",
          } as never,
        }),
        RETRY_BODY,
      ),
      "fyndSuccess=1",
    );
    const opts = createReturnOnFyndMock.mock.calls[0]![2] as { targetShipmentId: string | null };
    expect(opts.targetShipmentId).toBe("SH-EXISTING");
  });
});

describe("handleRetryFyndSync — createReturnOnFynd crash", () => {
  it("persists failed status + writes fynd_sync_failed event when createReturnOnFynd throws", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: mkClient() });
    createReturnOnFyndMock.mockRejectedValueOnce(new Error("boom"));

    await expectRedirect(handleRetryFyndSync(mkCtx(), RETRY_BODY), "fyndError=");

    const updates = prismaMock.returnCase.update.mock.calls;
    const failed = updates.find((c) => c[0].data?.fyndSyncStatus === "failed");
    expect(failed).toBeDefined();
    expect(failed![0].data.fyndSyncError).toContain("boom");

    const events = prismaMock.returnEvent.create.mock.calls;
    const crashedEvent = events.find((c) => c[0].data?.eventType === "fynd_sync_failed");
    expect(crashedEvent).toBeDefined();
    const payload = JSON.parse(crashedEvent![0].data.payloadJson as string);
    expect(payload.status).toBe("crashed");
    expect(payload.action).toBe("manual_retry");
    expect(payload.adminEmail).toBe("admin@example.com");
  });

  it("uses fallback message when createReturnOnFynd returns null", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: mkClient() });
    // Simulate a ridiculous "returns nothing" path via rejection that creates retryCrashError = null,
    // but fyndResult also null. We mock createReturnOnFynd to resolve to undefined.
    createReturnOnFyndMock.mockResolvedValueOnce(undefined as never);

    await expectRedirect(handleRetryFyndSync(mkCtx(), RETRY_BODY), "fyndError=");

    const updates = prismaMock.returnCase.update.mock.calls;
    const failed = updates.find((c) => c[0].data?.fyndSyncStatus === "failed");
    expect(failed).toBeDefined();
    expect(failed![0].data.fyndSyncError).toContain("Fynd sync failed unexpectedly");
  });

  it("survives when prisma.returnCase.update fails during crash branch", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: mkClient() });
    createReturnOnFyndMock.mockRejectedValueOnce(new Error("boom"));
    prismaMock.returnCase.update.mockRejectedValueOnce(new Error("db down"));

    await expectRedirect(handleRetryFyndSync(mkCtx(), RETRY_BODY), "fyndError=");
  });
});

describe("handleRetryFyndSync — createReturnOnFynd reports !success", () => {
  it("persists failed status + fynd_sync_failed event when fyndResult.success is false", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: mkClient() });
    createReturnOnFyndMock.mockResolvedValueOnce({
      success: false,
      error: "Forbidden 403",
    });

    await expectRedirect(handleRetryFyndSync(mkCtx(), RETRY_BODY), "fyndError=");

    const updates = prismaMock.returnCase.update.mock.calls;
    const failed = updates.find((c) => c[0].data?.fyndSyncStatus === "failed");
    expect(failed).toBeDefined();
    // enrichFyndError appends guidance for 403 errors
    expect(failed![0].data.fyndSyncError).toContain("403");

    const events = prismaMock.returnEvent.create.mock.calls;
    const ev = events.find((c) => c[0].data?.eventType === "fynd_sync_failed");
    expect(ev).toBeDefined();
    const payload = JSON.parse(ev![0].data.payloadJson as string);
    expect(payload.status).toBe("failed");
    expect(typeof payload.errorType).toBe("string");
  });

  it("uses fallback message when success=true but no IDs returned", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: mkClient() });
    createReturnOnFyndMock.mockResolvedValueOnce({
      success: true /* no fyndReturnId / no alreadyExists */,
    });

    await expectRedirect(handleRetryFyndSync(mkCtx(), RETRY_BODY), "fyndError=");

    const updates = prismaMock.returnCase.update.mock.calls;
    const failed = updates.find((c) => c[0].data?.fyndSyncStatus === "failed");
    expect(failed).toBeDefined();
    expect(failed![0].data.fyndSyncError).toContain("did not return a return ID");
  });
});

describe("handleRetryFyndSync — Shopify Return creation as side effect", () => {
  it("creates Shopify Return when missing AND order is GID AND not green return", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: mkClient() });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, fyndReturnId: "FY-1" });
    createShopifyReturnMock.mockResolvedValueOnce({
      success: true,
      shopifyReturnId: "gid://shopify/Return/123",
    });

    await expectRedirect(handleRetryFyndSync(mkCtx(), RETRY_BODY), "fyndSuccess=1");

    expect(createShopifyReturnMock).toHaveBeenCalled();
    const updates = prismaMock.returnCase.update.mock.calls;
    const sideEffect = updates.find(
      (c) => c[0].data?.shopifyReturnId === "gid://shopify/Return/123",
    );
    expect(sideEffect).toBeDefined();
  });

  it("skips Shopify Return creation when shopifyReturnId already set", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: mkClient() });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, fyndReturnId: "FY-1" });

    await expectRedirect(
      handleRetryFyndSync(
        mkCtx({
          returnCase: {
            ...mkCtx().returnCase,
            shopifyReturnId: "gid://shopify/Return/EXISTING",
          } as never,
        }),
        RETRY_BODY,
      ),
      "fyndSuccess=1",
    );
    expect(createShopifyReturnMock).not.toHaveBeenCalled();
  });

  it("skips Shopify Return creation when isGreenReturn=true", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: mkClient() });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, fyndReturnId: "FY-1" });

    await expectRedirect(
      handleRetryFyndSync(
        mkCtx({
          returnCase: {
            ...mkCtx().returnCase,
            isGreenReturn: true,
          } as never,
        }),
        RETRY_BODY,
      ),
      "fyndSuccess=1",
    );
    expect(createShopifyReturnMock).not.toHaveBeenCalled();
  });

  it("skips Shopify Return creation when shopifyOrderId starts with manual:", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: mkClient() });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, fyndReturnId: "FY-1" });

    await expectRedirect(
      handleRetryFyndSync(
        mkCtx({
          returnCase: {
            ...mkCtx().returnCase,
            shopifyOrderId: "manual:abc",
          } as never,
        }),
        RETRY_BODY,
      ),
      "fyndSuccess=1",
    );
    expect(createShopifyReturnMock).not.toHaveBeenCalled();
  });

  it("Shopify Return creation failure is non-fatal — still redirects success", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: mkClient() });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, fyndReturnId: "FY-1" });
    createShopifyReturnMock.mockResolvedValueOnce({ success: false, error: "no fulfillment" });

    await expectRedirect(handleRetryFyndSync(mkCtx(), RETRY_BODY), "fyndSuccess=1");
  });

  it("Shopify Return creation crash is non-fatal — still redirects success", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: mkClient() });
    createReturnOnFyndMock.mockResolvedValueOnce({ success: true, fyndReturnId: "FY-1" });
    createShopifyReturnMock.mockRejectedValueOnce(new Error("network"));

    await expectRedirect(handleRetryFyndSync(mkCtx(), RETRY_BODY), "fyndSuccess=1");
  });
});
