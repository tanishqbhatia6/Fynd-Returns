/**
 * Extra coverage tests for app/routes/api.portal.track.ts
 *
 * Focus areas:
 *   - Tracking-source variations: Fynd shipment (fyndReturnNo + returnAwb)
 *     vs Shopify-fulfillment-only (no Fynd identifiers, AWB optional)
 *   - Missing tracking data fallbacks (null/undefined → null in payload)
 *   - returnJourney extraction across status variants and payload states
 *   - Phone normalisation (stripping non-digits) and email normalisation
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, checkRateLimitMock, extractJourneyMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 30, retryAfterMs: 0 })),
  extractJourneyMock: vi.fn(() => [{ status: "return_initiated", at: "2025-01-01" }]),
}));

Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));

vi.mock("../../lib/portal-cors.server", () => ({
  getPortalCorsHeaders: () => new Headers(),
  withCors: (res: Response) => res,
}));

vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: checkRateLimitMock,
  rateLimitResponse: (ms: number) =>
    Response.json(
      { error: "rate limited" },
      { status: 429, headers: { "Retry-After": String(ms) } },
    ),
}));

vi.mock("../../lib/fynd-payload.server", () => ({
  extractFyndJourney: extractJourneyMock,
}));

import { loader } from "../api.portal.track";

function mkRequest(qs: string, method = "GET") {
  return new Request(`https://app.example/api/portal/track?${qs}`, { method });
}

function baseReturnCase(overrides: Record<string, unknown> = {}) {
  const now = new Date("2026-02-15T12:00:00Z");
  return {
    returnRequestNo: "R-100",
    customerEmailNorm: "buyer@example.com",
    customerPhoneNorm: null,
    status: "pending",
    refundStatus: null,
    resolutionType: "refund",
    fyndReturnNo: null,
    returnAwb: null,
    notesForCustomer: null,
    createdAt: now,
    updatedAt: now,
    fyndPayloadJson: null,
    ...overrides,
  };
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  checkRateLimitMock
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 30, retryAfterMs: 0 });
  extractJourneyMock.mockReset().mockReturnValue([
    { status: "return_initiated", at: "2026-02-15" },
  ]);
});

describe("api.portal.track — coverage extras", () => {
  describe("tracking-source variations", () => {
    it("returns Fynd-shipment fields when fyndReturnNo + returnAwb are populated", async () => {
      prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
      prismaMock.returnCase.findFirst.mockResolvedValueOnce(
        baseReturnCase({
          status: "approved",
          fyndReturnNo: "FYND-9876",
          returnAwb: "AWB-FYND-1",
          fyndPayloadJson: '{"payload":{"shipment":{"id":"S1"}}}',
        }),
      );
      const res = await loader({
        request: mkRequest(
          "shop=demo&returnRequestNo=R-100&email=buyer@example.com",
        ),
        params: {},
        context: {},
      } as never);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.fyndReturnNo).toBe("FYND-9876");
      expect(body.returnAwb).toBe("AWB-FYND-1");
      // Journey extracted from fynd payload because status is approved
      expect(extractJourneyMock).toHaveBeenCalledWith(
        '{"payload":{"shipment":{"id":"S1"}}}',
        "return",
      );
      expect(body.returnJourney.length).toBeGreaterThan(0);
    });

    it("returns Shopify-fulfillment-only return (no Fynd ids, AWB present)", async () => {
      prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
      prismaMock.returnCase.findFirst.mockResolvedValueOnce(
        baseReturnCase({
          status: "approved",
          fyndReturnNo: null,
          returnAwb: "SHOPIFY-TRK-42",
          fyndPayloadJson: null,
        }),
      );
      // For non-Fynd flow, journey extractor should still be called but
      // with null payload it returns nothing → fallback to [].
      extractJourneyMock.mockReturnValueOnce(null as unknown as never);

      const res = await loader({
        request: mkRequest(
          "shop=demo&returnRequestNo=R-100&email=buyer@example.com",
        ),
        params: {},
        context: {},
      } as never);
      const body = await res.json();
      expect(body.fyndReturnNo).toBeNull();
      expect(body.returnAwb).toBe("SHOPIFY-TRK-42");
      expect(body.returnJourney).toEqual([]);
    });

    it("returns nulls for AWB and fyndReturnNo when both missing", async () => {
      prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
      prismaMock.returnCase.findFirst.mockResolvedValueOnce(
        baseReturnCase({ fyndReturnNo: null, returnAwb: null }),
      );
      const res = await loader({
        request: mkRequest(
          "shop=demo&returnRequestNo=R-100&email=buyer@example.com",
        ),
        params: {},
        context: {},
      } as never);
      const body = await res.json();
      expect(body.fyndReturnNo).toBeNull();
      expect(body.returnAwb).toBeNull();
    });

    it("coerces undefined fyndReturnNo / returnAwb to null in response", async () => {
      prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
      // Some code-paths may not set these properties at all (undefined).
      prismaMock.returnCase.findFirst.mockResolvedValueOnce(
        baseReturnCase({ fyndReturnNo: undefined, returnAwb: undefined }),
      );
      const res = await loader({
        request: mkRequest(
          "shop=demo&returnRequestNo=R-100&email=buyer@example.com",
        ),
        params: {},
        context: {},
      } as never);
      const body = await res.json();
      expect(body.fyndReturnNo).toBeNull();
      expect(body.returnAwb).toBeNull();
    });
  });

  describe("returnJourney extraction", () => {
    it("does NOT extract journey when status=pending", async () => {
      prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
      prismaMock.returnCase.findFirst.mockResolvedValueOnce(
        baseReturnCase({
          status: "pending",
          fyndPayloadJson: '{"payload":{}}',
        }),
      );
      const res = await loader({
        request: mkRequest(
          "shop=demo&returnRequestNo=R-100&email=buyer@example.com",
        ),
        params: {},
        context: {},
      } as never);
      const body = await res.json();
      expect(extractJourneyMock).not.toHaveBeenCalled();
      expect(body.returnJourney).toEqual([]);
    });

    it("extracts journey when status=completed (case-insensitive)", async () => {
      prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
      prismaMock.returnCase.findFirst.mockResolvedValueOnce(
        baseReturnCase({
          status: "COMPLETED",
          fyndPayloadJson: '{"payload":{"x":1}}',
        }),
      );
      extractJourneyMock.mockReturnValueOnce([
        { status: "delivered", at: "2026-03-01" },
        { status: "refunded", at: "2026-03-02" },
      ]);
      const res = await loader({
        request: mkRequest(
          "shop=demo&returnRequestNo=R-100&email=buyer@example.com",
        ),
        params: {},
        context: {},
      } as never);
      const body = await res.json();
      expect(extractJourneyMock).toHaveBeenCalledTimes(1);
      expect(body.returnJourney).toHaveLength(2);
      expect(body.returnJourney[0].status).toBe("delivered");
    });

    it("falls back to [] when extractor returns null/undefined for approved status", async () => {
      prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
      prismaMock.returnCase.findFirst.mockResolvedValueOnce(
        baseReturnCase({
          status: "approved",
          fyndPayloadJson: null,
        }),
      );
      extractJourneyMock.mockReturnValueOnce(null as unknown as never);
      const res = await loader({
        request: mkRequest(
          "shop=demo&returnRequestNo=R-100&email=buyer@example.com",
        ),
        params: {},
        context: {},
      } as never);
      const body = await res.json();
      expect(body.returnJourney).toEqual([]);
    });

    it("does NOT extract journey for status=rejected (non-approved/completed)", async () => {
      prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
      prismaMock.returnCase.findFirst.mockResolvedValueOnce(
        baseReturnCase({
          status: "rejected",
          fyndPayloadJson: '{"payload":{}}',
        }),
      );
      const res = await loader({
        request: mkRequest(
          "shop=demo&returnRequestNo=R-100&email=buyer@example.com",
        ),
        params: {},
        context: {},
      } as never);
      const body = await res.json();
      expect(extractJourneyMock).not.toHaveBeenCalled();
      expect(body.returnJourney).toEqual([]);
    });
  });

  describe("missing-data fallbacks", () => {
    it("coerces missing refundStatus and notesForCustomer to null", async () => {
      prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
      prismaMock.returnCase.findFirst.mockResolvedValueOnce(
        baseReturnCase({
          refundStatus: undefined,
          notesForCustomer: undefined,
        }),
      );
      const res = await loader({
        request: mkRequest(
          "shop=demo&returnRequestNo=R-100&email=buyer@example.com",
        ),
        params: {},
        context: {},
      } as never);
      const body = await res.json();
      expect(body.refundStatus).toBeNull();
      expect(body.notesForCustomer).toBeNull();
    });

    it("preserves non-null refundStatus / resolutionType in response", async () => {
      prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
      prismaMock.returnCase.findFirst.mockResolvedValueOnce(
        baseReturnCase({
          refundStatus: "processed",
          resolutionType: "exchange",
        }),
      );
      const res = await loader({
        request: mkRequest(
          "shop=demo&returnRequestNo=R-100&email=buyer@example.com",
        ),
        params: {},
        context: {},
      } as never);
      const body = await res.json();
      expect(body.refundStatus).toBe("processed");
      expect(body.resolutionType).toBe("exchange");
    });
  });

  describe("identity verification edge cases", () => {
    it("rejects when stored customerEmailNorm is null even with matching email param", async () => {
      prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
      prismaMock.returnCase.findFirst.mockResolvedValueOnce(
        baseReturnCase({
          customerEmailNorm: null,
          customerPhoneNorm: null,
        }),
      );
      const res = await loader({
        request: mkRequest(
          "shop=demo&returnRequestNo=R-100&email=buyer@example.com",
        ),
        params: {},
        context: {},
      } as never);
      expect(res.status).toBe(404);
    });

    it("matches phone after stripping spaces, dashes and parens from input", async () => {
      prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
      prismaMock.returnCase.findFirst.mockResolvedValueOnce(
        baseReturnCase({
          customerEmailNorm: null,
          customerPhoneNorm: "+14155551212",
        }),
      );
      // "(415) 555-1212" with country code → after non-[\d+] strip becomes "+14155551212"
      const res = await loader({
        request: mkRequest(
          "shop=demo&returnRequestNo=R-100&phone=%2B1%20(415)%20555-1212",
        ),
        params: {},
        context: {},
      } as never);
      expect(res.status).toBe(200);
    });

    it("accepts dotted shop param without re-appending myshopify.com", async () => {
      prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
      prismaMock.returnCase.findFirst.mockResolvedValueOnce(
        baseReturnCase(),
      );
      await loader({
        request: mkRequest(
          "shop=demo.myshopify.com&returnRequestNo=R-100&email=buyer@example.com",
        ),
        params: {},
        context: {},
      } as never);
      expect(prismaMock.shop.findUnique).toHaveBeenCalledWith({
        where: { shopDomain: "demo.myshopify.com" },
      });
    });

    it("performs case-insensitive returnRequestNo lookup via Prisma where clause", async () => {
      prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
      prismaMock.returnCase.findFirst.mockResolvedValueOnce(
        baseReturnCase({ returnRequestNo: "R-100" }),
      );
      await loader({
        request: mkRequest(
          "shop=demo&returnRequestNo=r-100&email=buyer@example.com",
        ),
        params: {},
        context: {},
      } as never);
      const callArg = prismaMock.returnCase.findFirst.mock.calls[0][0];
      expect(callArg.where.returnRequestNo).toEqual({
        equals: "r-100",
        mode: "insensitive",
      });
      expect(callArg.where.shopId).toBe("shop-1");
    });
  });
});
