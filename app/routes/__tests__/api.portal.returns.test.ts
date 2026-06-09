import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  verifyPortalSessionMock,
  checkRateLimitMock,
  rateLimitResponseMock,
  getPortalLabelsMock,
  extractJourneyMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  verifyPortalSessionMock: vi.fn(),
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 30, retryAfterMs: 0 })),
  rateLimitResponseMock: vi.fn(() => Response.json({ error: "rate-limited" }, { status: 429 })),
  getPortalLabelsMock: vi.fn(() => ({ heading: "Your Returns" })),
  extractJourneyMock: vi.fn(() => [{ status: "return_initiated" }]),
}));

Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));

vi.mock("../../lib/portal-auth.server", () => ({
  verifyPortalSession: verifyPortalSessionMock,
}));

vi.mock("../../lib/portal-cors.server", () => ({
  getPortalCorsHeaders: () => new Headers(),
  withCors: (res: Response) => res,
}));

vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: checkRateLimitMock,
  rateLimitResponse: rateLimitResponseMock,
}));

vi.mock("../../lib/portal-i18n", () => ({
  getPortalLabels: getPortalLabelsMock,
}));

vi.mock("../../lib/fynd-payload.server", () => ({
  extractFyndJourney: extractJourneyMock,
}));

import { loader } from "../api.portal.returns";

function mkRequest(opts: { auth?: string; method?: string } = {}) {
  const headers = new Headers();
  if (opts.auth) headers.set("Authorization", opts.auth);
  return new Request("https://app.example/api/portal/returns", {
    method: opts.method ?? "GET",
    headers,
  });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  checkRateLimitMock
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 30, retryAfterMs: 0 });
  rateLimitResponseMock
    .mockReset()
    .mockReturnValue(Response.json({ error: "rate-limited" }, { status: 429 }));
  verifyPortalSessionMock.mockReset().mockResolvedValue({
    id: "s1",
    shopId: "shop-1",
    lookupType: "email",
    lookupValueHash: "hash",
    lookupValueNorm: "user@example.com",
    matchedReturnIds: "[]",
  });
  getPortalLabelsMock.mockClear();
  extractJourneyMock.mockClear();
});

describe("GET /api/portal/returns", () => {
  it("returns 204 on OPTIONS preflight", async () => {
    const res = await loader({
      request: mkRequest({ method: "OPTIONS" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(204);
    expect(checkRateLimitMock).not.toHaveBeenCalled();
  });

  it("429 when rate-limited before auth or database work", async () => {
    checkRateLimitMock.mockResolvedValueOnce({
      allowed: false,
      remaining: 0,
      retryAfterMs: 60000,
    });

    const res = await loader({
      request: mkRequest({ auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(429);
    expect(checkRateLimitMock).toHaveBeenCalledWith(expect.any(Request), "portal.returns");
    expect(rateLimitResponseMock).toHaveBeenCalledWith(60000);
    expect(verifyPortalSessionMock).not.toHaveBeenCalled();
    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
  });

  it("401 when Authorization header missing", async () => {
    const res = await loader({ request: mkRequest(), params: {}, context: {} } as never);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("401 when token fails verification", async () => {
    verifyPortalSessionMock.mockResolvedValueOnce(null);
    const res = await loader({
      request: mkRequest({ auth: "Bearer bad" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid token" });
  });

  it("401 when session is not verified", async () => {
    verifyPortalSessionMock.mockResolvedValueOnce(null);
    const res = await loader({
      request: mkRequest({ auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid token" });
  });

  it("401 when session expired", async () => {
    verifyPortalSessionMock.mockResolvedValueOnce(null);
    const res = await loader({
      request: mkRequest({ auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid token" });
  });

  it("returns empty returns array when matchedReturnIds is '[]'", async () => {
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      portalLanguage: "en",
      portalLabelsJson: null,
      defaultReturnInstructions: null,
    });

    const res = await loader({
      request: mkRequest({ auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.returns).toEqual([]);
    expect(body.language).toBe("en");
  });

  it("enriches returns with journey when approved", async () => {
    verifyPortalSessionMock.mockResolvedValueOnce({
      id: "s1",
      shopId: "shop-1",
      lookupType: "email",
      lookupValueHash: "hash",
      lookupValueNorm: "user@example.com",
      matchedReturnIds: JSON.stringify(["rc-1"]),
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        status: "approved",
        fyndPayloadJson: '{"payload":{}}',
        returnLabelJson: null,
        items: [],
        events: [],
        fyndCurrentStatus: "return_initiated",
        fyndReturnNo: "FR1",
        forwardAwb: null,
        returnAwb: "AWB-1",
        notesForCustomer: null,
        cancellationRequestedAt: null,
        cancellationDeclinedAt: null,
      },
    ]);
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      portalLanguage: "en",
      portalLabelsJson: null,
      defaultReturnInstructions: "Pack it up",
    });

    const res = await loader({
      request: mkRequest({ auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.returns).toHaveLength(1);
    expect(body.returns[0].returnJourney).toEqual([{ status: "return_initiated" }]);
    expect(body.returns[0].returnInstructions).toBe("Pack it up");
    expect(body.returns[0].fyndPayloadJson).toBe(undefined);
  });

  it("skips journey + label + instructions when return is pending", async () => {
    verifyPortalSessionMock.mockResolvedValueOnce({
      id: "s1",
      shopId: "shop-1",
      lookupType: "email",
      lookupValueHash: "hash",
      lookupValueNorm: "user@example.com",
      matchedReturnIds: JSON.stringify(["rc-1"]),
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        status: "pending",
        fyndPayloadJson: null,
        returnLabelJson: '{"carrier":"USPS"}',
        items: [],
        events: [],
      },
    ]);
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      portalLanguage: "en",
      portalLabelsJson: null,
      defaultReturnInstructions: "x",
    });
    const res = await loader({
      request: mkRequest({ auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.returns[0].returnJourney).toBe(null);
    expect(body.returns[0].returnLabel).toBe(null);
    expect(body.returns[0].returnInstructions).toBe(null);
  });

  it("silently recovers from malformed matchedReturnIds JSON", async () => {
    verifyPortalSessionMock.mockResolvedValueOnce({
      id: "s1",
      shopId: "shop-1",
      lookupType: "email",
      lookupValueHash: "hash",
      lookupValueNorm: "user@example.com",
      matchedReturnIds: "{broken",
    });
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ portalLanguage: "en" });
    const res = await loader({
      request: mkRequest({ auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.returns).toEqual([]);
  });

  it("merges portalLabelsJson overrides into labels", async () => {
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      portalLanguage: "fr",
      portalLabelsJson: JSON.stringify({ heading: "Mes Retours" }),
    });
    await loader({ request: mkRequest({ auth: "Bearer t" }), params: {}, context: {} } as never);
    expect(getPortalLabelsMock).toHaveBeenCalledWith("fr", { heading: "Mes Retours" });
  });

  it("tolerates malformed portalLabelsJson", async () => {
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      portalLanguage: "en",
      portalLabelsJson: "{not json",
    });
    const res = await loader({
      request: mkRequest({ auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });
});
