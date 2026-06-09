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

function mkSession(matchedReturnIds: string | null, shopId = "shop-A") {
  return {
    id: "s1",
    shopId,
    lookupType: "email",
    lookupValueHash: "hash",
    lookupValueNorm: "user@example.com",
    verifiedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    matchedReturnIds,
  };
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  verifyPortalSessionMock.mockReset().mockResolvedValue(mkSession("[]"));
  checkRateLimitMock
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 30, retryAfterMs: 0 });
  rateLimitResponseMock
    .mockReset()
    .mockReturnValue(Response.json({ error: "rate-limited" }, { status: 429 }));
  getPortalLabelsMock.mockClear();
  extractJourneyMock.mockClear();
});

describe("api.portal.returns — authorized scope by matchedReturnIds", () => {
  it("scopes findMany to ids in matchedReturnIds AND payload.shopId", async () => {
    verifyPortalSessionMock.mockResolvedValueOnce(
      mkSession(JSON.stringify(["rc-1", "rc-2", "rc-3"]), "shop-A"),
    );
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ portalLanguage: "en" });

    await loader({ request: mkRequest({ auth: "Bearer t" }), params: {}, context: {} } as never);

    expect(prismaMock.returnCase.findMany).toHaveBeenCalledTimes(1);
    const arg = prismaMock.returnCase.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ id: { in: ["rc-1", "rc-2", "rc-3"] }, shopId: "shop-A" });
    expect(arg.orderBy).toEqual({ createdAt: "desc" });
    expect(arg.select.items.select.id).toBe(true);
    expect(arg.select.events).toEqual({
      orderBy: { happenedAt: "desc" },
      take: 10,
      select: {
        id: true,
        eventType: true,
        happenedAt: true,
      },
    });
  });

  it("does not call findMany when matchedReturnIds is empty array", async () => {
    verifyPortalSessionMock.mockResolvedValueOnce(mkSession("[]", "shop-A"));
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ portalLanguage: "en" });

    const res = await loader({
      request: mkRequest({ auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);

    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.returns).toEqual([]);
  });

  it("does not call findMany when matchedReturnIds is null/undefined (treated as '[]')", async () => {
    verifyPortalSessionMock.mockResolvedValueOnce(mkSession(null, "shop-A"));
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ portalLanguage: "en" });

    const res = await loader({
      request: mkRequest({ auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);

    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("does not call findMany when matchedReturnIds JSON is malformed", async () => {
    verifyPortalSessionMock.mockResolvedValueOnce(mkSession("not-json", "shop-A"));
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ portalLanguage: "en" });

    const res = await loader({
      request: mkRequest({ auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);

    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
    const body = await res.json();
    expect(body.returns).toEqual([]);
  });

  it("uses payload.shopId — not the session's — to scope returns (cross-shop guard)", async () => {
    verifyPortalSessionMock.mockResolvedValueOnce(
      mkSession(JSON.stringify(["rc-9"]), "shop-FROM-TOKEN"),
    );
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ portalLanguage: "en" });

    await loader({ request: mkRequest({ auth: "Bearer t" }), params: {}, context: {} } as never);

    const arg = prismaMock.returnCase.findMany.mock.calls[0][0];
    expect(arg.where.shopId).toBe("shop-FROM-TOKEN");
  });

  it("verifies the bearer token through the portal session helper", async () => {
    verifyPortalSessionMock.mockResolvedValueOnce(mkSession("[]", "shop-A"));
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ portalLanguage: "en" });

    await loader({ request: mkRequest({ auth: "Bearer t" }), params: {}, context: {} } as never);

    expect(verifyPortalSessionMock).toHaveBeenCalledWith(prismaMock, {
      portalToken: "t",
    });
  });

  it("returns only the matched ids — caller cannot widen scope via additional ids", async () => {
    // Even if Prisma mock would return extra rows, the route trusts findMany
    // results; what we assert is the WHERE clause restricts to the exact ids
    // the verified session matched.
    verifyPortalSessionMock.mockResolvedValueOnce(mkSession(JSON.stringify(["rc-1"]), "shop-A"));
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        status: "pending",
        items: [],
        events: [],
        returnLabelJson: null,
        fyndPayloadJson: null,
      },
    ]);
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ portalLanguage: "en" });

    const res = await loader({
      request: mkRequest({ auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    const body = await res.json();

    const arg = prismaMock.returnCase.findMany.mock.calls[0][0];
    expect(arg.where.id.in).toEqual(["rc-1"]);
    expect(body.returns.map((r: { id: string }) => r.id)).toEqual(["rc-1"]);
  });

  it("strips fyndPayloadJson from every returned record", async () => {
    verifyPortalSessionMock.mockResolvedValueOnce(
      mkSession(JSON.stringify(["rc-1", "rc-2"]), "shop-A"),
    );
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        status: "approved",
        items: [],
        events: [],
        returnLabelJson: null,
        fyndPayloadJson: '{"secret":"x"}',
      },
      {
        id: "rc-2",
        status: "completed",
        items: [],
        events: [],
        returnLabelJson: null,
        fyndPayloadJson: '{"secret":"y"}',
      },
    ]);
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ portalLanguage: "en" });

    const res = await loader({
      request: mkRequest({ auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.returns).toHaveLength(2);
    for (const r of body.returns) {
      expect(r.fyndPayloadJson).toBeUndefined();
      expect(JSON.stringify(r)).not.toContain("secret");
    }
  });

  it("preserves matchedReturnIds order in the WHERE 'in' clause", async () => {
    const ids = ["rc-3", "rc-1", "rc-2"];
    verifyPortalSessionMock.mockResolvedValueOnce(mkSession(JSON.stringify(ids), "shop-A"));
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ portalLanguage: "en" });

    await loader({ request: mkRequest({ auth: "Bearer t" }), params: {}, context: {} } as never);

    expect(prismaMock.returnCase.findMany.mock.calls[0][0].where.id.in).toEqual(ids);
  });

  it("returns approved status with returnLabel parsed from returnLabelJson", async () => {
    verifyPortalSessionMock.mockResolvedValueOnce(mkSession(JSON.stringify(["rc-1"]), "shop-A"));
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        status: "Approved",
        items: [],
        events: [],
        returnLabelJson:
          '{"carrier":"USPS","trackingNumber":"1Z","labelUrl":"https://x","qrCodeUrl":null}',
        fyndPayloadJson: null,
      },
    ]);
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      portalLanguage: "en",
      defaultReturnInstructions: "Bring to UPS",
    });

    const res = await loader({
      request: mkRequest({ auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    const body = await res.json();
    expect(body.returns[0].returnLabel).toEqual({
      carrier: "USPS",
      trackingNumber: "1Z",
      labelUrl: "https://x",
      qrCodeUrl: null,
    });
    expect(body.returns[0].returnInstructions).toBe("Bring to UPS");
  });

  it("recovers when returnLabelJson is malformed (returnLabel = null)", async () => {
    verifyPortalSessionMock.mockResolvedValueOnce(mkSession(JSON.stringify(["rc-1"]), "shop-A"));
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        status: "completed",
        items: [],
        events: [],
        returnLabelJson: "{garbage",
        fyndPayloadJson: null,
      },
    ]);
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ portalLanguage: "en" });

    const res = await loader({
      request: mkRequest({ auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    // Malformed JSON => returnLabelInfo stays null even though approved/completed
    expect(body.returns[0].returnLabel).toBe(null);
  });

  it("falls back to 'en' when shopSettings is missing", async () => {
    verifyPortalSessionMock.mockResolvedValueOnce(mkSession("[]", "shop-A"));
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce(null);

    const res = await loader({
      request: mkRequest({ auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.language).toBe("en");
    expect(getPortalLabelsMock).toHaveBeenCalledWith("en", {});
  });
});
