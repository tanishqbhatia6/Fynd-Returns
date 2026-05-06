/**
 * Coverage closure for app/routes/api.portal.fynd-enrich.ts
 *
 * Targets line 79: `if (!candidate.value) continue;`
 * Reachable when orderName is "#" — orderNumber becomes "" after `replace(/^#/, "")`
 * and the loop body skips the search.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  checkRateLimitMock,
  createFyndClientOrErrorMock,
  parseFyndOrderDetailsMock,
  extractFyndJourneyMock,
  getTrackingInfoMock,
  getPickupAddressMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 30, retryAfterMs: 0 })),
  createFyndClientOrErrorMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    ok: false,
    error: "disabled",
  })),
  parseFyndOrderDetailsMock: vi.fn(() => null),
  extractFyndJourneyMock: vi.fn(() => []),
  getTrackingInfoMock: vi.fn(() => null),
  getPickupAddressMock: vi.fn(() => null),
}));
Object.assign(prismaMock, createPrismaMock());
(prismaMock as unknown as Record<string, unknown>).fyndOrderMapping = {
  upsert: vi.fn().mockResolvedValue({}),
};

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/portal-cors.server", () => ({
  getPortalCorsHeaders: () => new Headers(),
  withCors: (res: Response) => res,
}));
vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: checkRateLimitMock,
  rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
}));
vi.mock("../../lib/fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
}));
vi.mock("../../lib/fynd-payload.server", () => ({
  parseFyndOrderDetailsForTab: parseFyndOrderDetailsMock,
  extractFyndJourney: extractFyndJourneyMock,
  getTrackingInfoFromFyndPayload: getTrackingInfoMock,
  getPickupAddressFromFyndPayload: getPickupAddressMock,
}));

import { action } from "../api.portal.fynd-enrich";

function jsonReq(body: unknown) {
  return new Request("https://app.example/api/portal/fynd-enrich", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  checkRateLimitMock
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 30, retryAfterMs: 0 });
  createFyndClientOrErrorMock.mockReset();
  parseFyndOrderDetailsMock.mockReset().mockReturnValue(null);
});

describe("api.portal.fynd-enrich — coverage closure", () => {
  it("skips search when candidate.value is empty (orderName = '#')", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { id: "s-1", fyndPlatformApiKey: "k", fyndPlatformApiSecret: "s" },
    });
    const searchSpy = vi.fn();
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: searchSpy },
    });

    const res = await action({
      request: jsonReq({ shop: "store", type: "order", orderName: "#" }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    // The continue path should skip the search call entirely
    expect(searchSpy).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.fyndData).toBeNull();
  });
});
