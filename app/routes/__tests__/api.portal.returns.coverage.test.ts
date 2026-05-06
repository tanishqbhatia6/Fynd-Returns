import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, verifyPortalTokenMock, getPortalLabelsMock, extractJourneyMock } = vi.hoisted(
  () => ({
    prismaMock: {} as ReturnType<typeof createPrismaMock>,
    verifyPortalTokenMock: vi.fn(),
    getPortalLabelsMock: vi.fn(() => ({ heading: "Your Returns" })),
    extractJourneyMock: vi.fn(() => [{ status: "return_initiated" }]),
  }),
);

Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));

vi.mock("../../lib/portal-auth.server", () => ({
  verifyPortalToken: verifyPortalTokenMock,
}));

vi.mock("../../lib/portal-cors.server", () => ({
  getPortalCorsHeaders: () => new Headers(),
  withCors: (res: Response) => res,
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

function mkSession(matchedReturnIds: string) {
  return {
    verifiedAt: new Date(),
    expiresAt: new Date(Date.now() + 60_000),
    matchedReturnIds,
  };
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  verifyPortalTokenMock.mockReset();
  getPortalLabelsMock.mockClear();
  extractJourneyMock.mockClear();
});

describe("api.portal.returns — authorized scope by matchedReturnIds", () => {
  it("scopes findMany to ids in matchedReturnIds AND payload.shopId", async () => {
    verifyPortalTokenMock.mockReturnValue({ sessionId: "s1", shopId: "shop-A" });
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(
      mkSession(JSON.stringify(["rc-1", "rc-2", "rc-3"])),
    );
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ portalLanguage: "en" });

    await loader({ request: mkRequest({ auth: "Bearer t" }), params: {}, context: {} } as never);

    expect(prismaMock.returnCase.findMany).toHaveBeenCalledTimes(1);
    const arg = prismaMock.returnCase.findMany.mock.calls[0][0];
    expect(arg.where).toEqual({ id: { in: ["rc-1", "rc-2", "rc-3"] }, shopId: "shop-A" });
    expect(arg.orderBy).toEqual({ createdAt: "desc" });
    expect(arg.include.items).toBe(true);
    expect(arg.include.events).toEqual({ orderBy: { happenedAt: "desc" }, take: 10 });
  });

  it("does not call findMany when matchedReturnIds is empty array", async () => {
    verifyPortalTokenMock.mockReturnValue({ sessionId: "s1", shopId: "shop-A" });
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(mkSession("[]"));
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
    verifyPortalTokenMock.mockReturnValue({ sessionId: "s1", shopId: "shop-A" });
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
      matchedReturnIds: null,
    });
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
    verifyPortalTokenMock.mockReturnValue({ sessionId: "s1", shopId: "shop-A" });
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(mkSession("not-json"));
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
    verifyPortalTokenMock.mockReturnValue({ sessionId: "s1", shopId: "shop-FROM-TOKEN" });
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(mkSession(JSON.stringify(["rc-9"])));
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ portalLanguage: "en" });

    await loader({ request: mkRequest({ auth: "Bearer t" }), params: {}, context: {} } as never);

    const arg = prismaMock.returnCase.findMany.mock.calls[0][0];
    expect(arg.where.shopId).toBe("shop-FROM-TOKEN");
  });

  it("looks up the session by payload.sessionId", async () => {
    verifyPortalTokenMock.mockReturnValue({ sessionId: "session-XYZ", shopId: "shop-A" });
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(mkSession("[]"));
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ portalLanguage: "en" });

    await loader({ request: mkRequest({ auth: "Bearer t" }), params: {}, context: {} } as never);

    expect(prismaMock.lookupSession.findUnique).toHaveBeenCalledWith({
      where: { id: "session-XYZ" },
    });
  });

  it("returns only the matched ids — caller cannot widen scope via additional ids", async () => {
    // Even if Prisma mock would return extra rows, the route trusts findMany
    // results; what we assert is the WHERE clause restricts to the exact ids
    // the verified session matched.
    verifyPortalTokenMock.mockReturnValue({ sessionId: "s1", shopId: "shop-A" });
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(mkSession(JSON.stringify(["rc-1"])));
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
    verifyPortalTokenMock.mockReturnValue({ sessionId: "s1", shopId: "shop-A" });
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(
      mkSession(JSON.stringify(["rc-1", "rc-2"])),
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
    verifyPortalTokenMock.mockReturnValue({ sessionId: "s1", shopId: "shop-A" });
    const ids = ["rc-3", "rc-1", "rc-2"];
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(mkSession(JSON.stringify(ids)));
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ portalLanguage: "en" });

    await loader({ request: mkRequest({ auth: "Bearer t" }), params: {}, context: {} } as never);

    expect(prismaMock.returnCase.findMany.mock.calls[0][0].where.id.in).toEqual(ids);
  });

  it("returns approved status with returnLabel parsed from returnLabelJson", async () => {
    verifyPortalTokenMock.mockReturnValue({ sessionId: "s1", shopId: "shop-A" });
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(mkSession(JSON.stringify(["rc-1"])));
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
    verifyPortalTokenMock.mockReturnValue({ sessionId: "s1", shopId: "shop-A" });
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(mkSession(JSON.stringify(["rc-1"])));
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
    verifyPortalTokenMock.mockReturnValue({ sessionId: "s1", shopId: "shop-A" });
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce(mkSession("[]"));
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
