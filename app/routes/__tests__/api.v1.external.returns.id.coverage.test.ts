import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateApiKeyMock,
  checkRateLimitMock,
  checkPerKeyRateLimitMock,
  externalApiLoggerMock,
} = vi.hoisted(() => ({
    prismaMock: {} as ReturnType<typeof createPrismaMock>,
    authenticateApiKeyMock: vi.fn(),
    checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 10, retryAfterMs: 0 })),
    checkPerKeyRateLimitMock: vi.fn<(...args: unknown[]) => Promise<Response | null>>(
      async () => null,
    ),
    externalApiLoggerMock: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  }));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/api-key-auth.server", () => ({ authenticateApiKey: authenticateApiKeyMock }));
vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: checkRateLimitMock,
  rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
}));
vi.mock("../../lib/external-api-helpers.server", async () => {
  const actual = await vi.importActual<typeof import("../../lib/external-api-helpers.server")>(
    "../../lib/external-api-helpers.server",
  );
  return { ...actual, checkPerKeyRateLimit: checkPerKeyRateLimitMock };
});
vi.mock("../../lib/observability/logger.server", () => ({
  externalApiLogger: externalApiLoggerMock,
}));

import { loader } from "../api.v1.external.returns.$id";

const mkReq = () => new Request("https://app.example/api/v1/external/returns/rc-1");
const okAuth = { ok: true, keyId: "k-1", shopId: "shop-1" } as const;

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateApiKeyMock.mockReset().mockResolvedValue(okAuth);
  checkRateLimitMock
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 10, retryAfterMs: 0 });
  checkPerKeyRateLimitMock.mockReset().mockResolvedValue(null);
  externalApiLoggerMock.error.mockClear();
  externalApiLoggerMock.warn.mockClear();
  externalApiLoggerMock.info.mockClear();
  externalApiLoggerMock.debug.mockClear();
});

describe("GET /api/v1/external/returns/:id - coverage", () => {
  // ── not-found ──
  it("returns 404 with NOT_FOUND error code when prisma yields null", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(null);
    const res = await loader({
      request: mkReq(),
      params: { id: "missing-id" },
      context: {},
    } as never);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_FOUND");
    expect(body.error.message).toContain("missing-id");
  });

  it("scopes findFirst to the authenticated shopId so cross-tenant lookups 404", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-9", shopId: "shop-XYZ" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(null);
    const res = await loader({
      request: mkReq(),
      params: { id: "rc-other-tenant" },
      context: {},
    } as never);
    expect(res.status).toBe(404);
    const callArg = prismaMock.returnCase.findFirst.mock.calls[0][0];
    expect(callArg.where).toEqual({ id: "rc-other-tenant", shopId: "shop-XYZ" });
  });

  it("includes items and events with events ordered by happenedAt asc in the prisma query", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(null);
    await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    const arg = prismaMock.returnCase.findFirst.mock.calls[0][0];
    expect(arg.include.items).toBe(true);
    expect(arg.include.events).toEqual({ orderBy: { happenedAt: "asc" } });
  });

  // ── sanitization shape ──
  it("sanitized payload exposes whitelisted top-level fields only", async () => {
    const now = new Date("2026-01-01T00:00:00Z");
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-1",
      shopId: "shop-1",
      returnRequestNo: "RPM-100",
      shopifyOrderId: "gid://shopify/Order/1",
      shopifyOrderName: "#1001",
      shopifyReturnId: null,
      status: "approved",
      refundStatus: null,
      resolutionType: "refund",
      customerName: "Alice",
      customerEmailNorm: "alice@test.com",
      customerPhoneNorm: "+1234567890",
      customerCity: "NYC",
      customerCountry: "US",
      currency: "USD",
      rejectionReason: null,
      adminNotes: null,
      notesForCustomer: null,
      isGreenReturn: false,
      fyndReturnId: null,
      fyndReturnNo: null,
      fyndCurrentStatus: null,
      returnAwb: null,
      forwardAwb: null,
      createdAt: now,
      updatedAt: now,
      // sensitive/internal fields that must NOT be leaked
      customerEmail: "RAW@example.com",
      customerPhone: "raw-phone",
      internalSecret: "should-not-leak",
      items: [],
      events: [],
    });

    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.shopId).toBeUndefined();
    expect(body.data.internalSecret).toBeUndefined();
    // raw email/phone fields should not surface; normalized aliases do
    expect(body.data.customerEmail).toBe("alice@test.com");
    expect(body.data.customerPhone).toBe("+1234567890");
    expect(body.data.customerEmailNorm).toBeUndefined();
    expect(body.data.customerPhoneNorm).toBeUndefined();
  });

  it("normalizes customerEmailNorm to customerEmail and customerPhoneNorm to customerPhone", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-2",
      customerEmailNorm: "norm@x.com",
      customerPhoneNorm: "+1999",
      items: [],
      events: [],
    });
    const res = await loader({ request: mkReq(), params: { id: "rc-2" }, context: {} } as never);
    const body = await res.json();
    expect(body.data.customerEmail).toBe("norm@x.com");
    expect(body.data.customerPhone).toBe("+1999");
  });

  it("sanitized item shape contains exactly the whitelisted keys", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-3",
      items: [
        {
          id: "it-1",
          shopifyLineItemId: "gid://shopify/LineItem/1",
          title: "Tee",
          variantTitle: "M",
          sku: "TEE-M",
          price: "19.99",
          qty: 2,
          reasonCode: "wrong_size",
          condition: "unused",
          notes: null,
          // fields that must be stripped
          internalCost: 5,
          shopId: "shop-1",
          createdAt: new Date(),
        },
      ],
      events: [],
    });
    const res = await loader({ request: mkReq(), params: { id: "rc-3" }, context: {} } as never);
    const body = await res.json();
    expect(body.data.items).toHaveLength(1);
    expect(Object.keys(body.data.items[0]).sort()).toEqual(
      [
        "condition",
        "id",
        "notes",
        "price",
        "qty",
        "reasonCode",
        "sku",
        "shopifyLineItemId",
        "title",
        "variantTitle",
      ].sort(),
    );
  });

  it("sanitized event shape contains exactly the whitelisted keys", async () => {
    const t = new Date("2026-02-01T00:00:00Z");
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-4",
      items: [],
      events: [
        {
          id: "ev-1",
          source: "admin",
          eventType: "approved",
          happenedAt: t,
          // fields that must be stripped
          actorId: "secret-user",
          payload: { foo: "bar" },
          shopId: "shop-1",
        },
      ],
    });
    const res = await loader({ request: mkReq(), params: { id: "rc-4" }, context: {} } as never);
    const body = await res.json();
    expect(body.data.events).toHaveLength(1);
    expect(Object.keys(body.data.events[0]).sort()).toEqual(
      ["eventType", "happenedAt", "id", "source"].sort(),
    );
    expect(body.data.events[0].actorId).toBeUndefined();
    expect(body.data.events[0].payload).toBeUndefined();
  });

  it("response envelope wraps payload as { data, errors:[] }", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-5",
      items: [],
      events: [],
    });
    const res = await loader({ request: mkReq(), params: { id: "rc-5" }, context: {} } as never);
    const body = await res.json();
    expect(body).toHaveProperty("data");
    expect(body.errors).toEqual([]);
    expect(body.data.id).toBe("rc-5");
  });

  it("returns empty arrays for items/events when prisma returns missing collections", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-6",
      items: undefined,
      events: undefined,
    });
    const res = await loader({ request: mkReq(), params: { id: "rc-6" }, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.items).toEqual([]);
    expect(body.data.events).toEqual([]);
  });

  // ── events ordering passthrough ──
  it("preserves the order of events as returned by prisma (loader trusts orderBy)", async () => {
    const t1 = new Date("2026-03-01T00:00:00Z");
    const t2 = new Date("2026-03-02T00:00:00Z");
    const t3 = new Date("2026-03-03T00:00:00Z");
    // Prisma returns ascending — loader passes them through.
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-7",
      items: [],
      events: [
        { id: "ev-a", source: "admin", eventType: "created", happenedAt: t1 },
        { id: "ev-b", source: "admin", eventType: "approved", happenedAt: t2 },
        { id: "ev-c", source: "admin", eventType: "refunded", happenedAt: t3 },
      ],
    });
    const res = await loader({ request: mkReq(), params: { id: "rc-7" }, context: {} } as never);
    const body = await res.json();
    const ids = body.data.events.map((e: { id: string }) => e.id);
    expect(ids).toEqual(["ev-a", "ev-b", "ev-c"]);
    const ts = body.data.events.map((e: { happenedAt: string }) =>
      new Date(e.happenedAt).getTime(),
    );
    // Verify chronological monotonicity (ascending), which is the loader's contract.
    expect(ts[0]).toBeLessThan(ts[1]);
    expect(ts[1]).toBeLessThan(ts[2]);
  });

  it("multiple items are mapped 1:1 with stable ordering", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-8",
      items: [
        { id: "it-1", title: "A", qty: 1 },
        { id: "it-2", title: "B", qty: 2 },
        { id: "it-3", title: "C", qty: 3 },
      ],
      events: [],
    });
    const res = await loader({ request: mkReq(), params: { id: "rc-8" }, context: {} } as never);
    const body = await res.json();
    expect(body.data.items.map((i: { id: string }) => i.id)).toEqual(["it-1", "it-2", "it-3"]);
    expect(body.data.items.map((i: { qty: number }) => i.qty)).toEqual([1, 2, 3]);
  });

  it("propagates fynd / awb tracking fields verbatim", async () => {
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      id: "rc-9",
      fyndReturnId: "fynd-123",
      fyndReturnNo: "FYND-RN-1",
      fyndCurrentStatus: "in_transit",
      returnAwb: "AWB-RET-1",
      forwardAwb: "AWB-FWD-1",
      items: [],
      events: [],
    });
    const res = await loader({ request: mkReq(), params: { id: "rc-9" }, context: {} } as never);
    const body = await res.json();
    expect(body.data.fyndReturnId).toBe("fynd-123");
    expect(body.data.fyndReturnNo).toBe("FYND-RN-1");
    expect(body.data.fyndCurrentStatus).toBe("in_transit");
    expect(body.data.returnAwb).toBe("AWB-RET-1");
    expect(body.data.forwardAwb).toBe("AWB-FWD-1");
  });

  it("503/500 path: logs and returns INTERNAL_ERROR envelope on prisma throw", async () => {
    prismaMock.returnCase.findFirst.mockRejectedValueOnce(new Error("connection refused"));
    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(externalApiLoggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: "external.returns.detail",
        shopId: "shop-1",
        keyId: "k-1",
        returnId: "rc-1",
        err: expect.objectContaining({ message: "connection refused" }),
      }),
      "External return detail failed",
    );
  });

  it("does not call findFirst when id param is missing (short-circuits at 400)", async () => {
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(prismaMock.returnCase.findFirst).not.toHaveBeenCalled();
  });

  it("does not call findFirst when auth fails (short-circuits at 401)", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({
      ok: false,
      response: Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 }),
    });
    const res = await loader({ request: mkReq(), params: { id: "rc-1" }, context: {} } as never);
    expect(res.status).toBe(401);
    expect(prismaMock.returnCase.findFirst).not.toHaveBeenCalled();
  });
});
