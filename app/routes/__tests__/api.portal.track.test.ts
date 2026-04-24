import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, checkRateLimitMock, extractJourneyMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  checkRateLimitMock: vi.fn(() => ({ allowed: true, remaining: 30, retryAfterMs: 0 })),
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
  rateLimitResponse: (ms: number) => Response.json({ error: "rate limited" }, { status: 429, headers: { "Retry-After": String(ms) } }),
}));

vi.mock("../../lib/fynd-payload.server", () => ({
  extractFyndJourney: extractJourneyMock,
}));

import { loader } from "../api.portal.track";

function mkRequest(qs: string, method = "GET") {
  return new Request(`https://app.example/api/portal/track?${qs}`, { method });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  checkRateLimitMock.mockReset().mockReturnValue({ allowed: true, remaining: 30, retryAfterMs: 0 });
  extractJourneyMock.mockClear();
});

describe("GET /api/portal/track", () => {
  it("returns 204 for OPTIONS (preflight)", async () => {
    const req = new Request("https://app.example/api/portal/track", { method: "OPTIONS" });
    const res = await loader({ request: req, params: {}, context: {} } as never);
    expect(res.status).toBe(204);
  });

  it("returns 429 when rate-limited", async () => {
    checkRateLimitMock.mockReturnValueOnce({ allowed: false, remaining: 0, retryAfterMs: 60000 });
    const res = await loader({ request: mkRequest("shop=x"), params: {}, context: {} } as never);
    expect(res.status).toBe(429);
  });

  it("requires shop param", async () => {
    const res = await loader({ request: mkRequest(""), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "shop is required" });
  });

  it("requires returnRequestNo param", async () => {
    const res = await loader({ request: mkRequest("shop=x"), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "returnRequestNo is required" });
  });

  it("requires email or phone", async () => {
    const res = await loader({ request: mkRequest("shop=x&returnRequestNo=R1"), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "email or phone is required" });
  });

  it("returns 404 when shop not found", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await loader({ request: mkRequest("shop=x&returnRequestNo=R1&email=a@b.com"), params: {}, context: {} } as never);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Shop not found" });
  });

  it("returns 404 when return not found", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce(null);
    const res = await loader({ request: mkRequest("shop=x&returnRequestNo=R1&email=a@b.com"), params: {}, context: {} } as never);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Return not found" });
  });

  it("returns 404 on email/phone mismatch (anti-enumeration)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      returnRequestNo: "R1",
      customerEmailNorm: "real@example.com",
      customerPhoneNorm: null,
      status: "pending",
      refundStatus: null,
      resolutionType: "refund",
      fyndReturnNo: null,
      returnAwb: null,
      notesForCustomer: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await loader({ request: mkRequest("shop=x&returnRequestNo=R1&email=wrong@example.com"), params: {}, context: {} } as never);
    expect(res.status).toBe(404);
  });

  it("returns the return when email matches (case-insensitive)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    const now = new Date("2025-06-01T00:00:00Z");
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      returnRequestNo: "R1",
      customerEmailNorm: "user@example.com",
      customerPhoneNorm: null,
      status: "pending",
      refundStatus: null,
      resolutionType: "refund",
      fyndReturnNo: "FR1",
      returnAwb: "AWB-1",
      notesForCustomer: "Ship it back",
      createdAt: now,
      updatedAt: now,
      fyndPayloadJson: null,
    });
    const res = await loader({ request: mkRequest("shop=x&returnRequestNo=R1&email=USER@Example.com"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.returnRequestNo).toBe("R1");
    expect(body.fyndReturnNo).toBe("FR1");
    // Status is "pending" → journey should be empty array
    expect(body.returnJourney).toEqual([]);
  });

  it("includes journey when status=approved or completed", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      returnRequestNo: "R1",
      customerEmailNorm: "user@example.com",
      customerPhoneNorm: null,
      status: "approved",
      refundStatus: null,
      resolutionType: "refund",
      fyndReturnNo: null,
      returnAwb: null,
      notesForCustomer: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      fyndPayloadJson: '{"payload":{}}',
    });
    const res = await loader({ request: mkRequest("shop=x&returnRequestNo=R1&email=user@example.com"), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.returnJourney.length).toBeGreaterThan(0);
    expect(extractJourneyMock).toHaveBeenCalled();
  });

  it("normalises non-dotted shop to .myshopify.com", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    await loader({ request: mkRequest("shop=mystore&returnRequestNo=R1&email=a@b.com"), params: {}, context: {} } as never);
    expect(prismaMock.shop.findUnique).toHaveBeenCalledWith({ where: { shopDomain: "mystore.myshopify.com" } });
  });

  it("matches by phone when email absent", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findFirst.mockResolvedValueOnce({
      returnRequestNo: "R1",
      customerEmailNorm: null,
      customerPhoneNorm: "+14155551212",
      status: "pending",
      refundStatus: null,
      resolutionType: "refund",
      fyndReturnNo: null,
      returnAwb: null,
      notesForCustomer: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await loader({ request: mkRequest("shop=x&returnRequestNo=R1&phone=%2B14155551212"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });
});
