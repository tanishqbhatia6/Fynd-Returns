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

beforeEach(() => {
  resetPrismaMock(prismaMock);
  verifyPortalTokenMock.mockReset();
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
  });

  it("401 when Authorization header missing", async () => {
    const res = await loader({ request: mkRequest(), params: {}, context: {} } as never);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("401 when token fails verification", async () => {
    verifyPortalTokenMock.mockReturnValueOnce(null);
    const res = await loader({
      request: mkRequest({ auth: "Bearer bad" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Invalid token" });
  });

  it("401 when session not verified", async () => {
    verifyPortalTokenMock.mockReturnValueOnce({ sessionId: "s1", shopId: "shop-1" });
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      verifiedAt: null,
      expiresAt: new Date(Date.now() + 10000),
      matchedReturnIds: "[]",
    });
    const res = await loader({
      request: mkRequest({ auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Session not verified" });
  });

  it("401 when session expired", async () => {
    verifyPortalTokenMock.mockReturnValueOnce({ sessionId: "s1", shopId: "shop-1" });
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() - 1000),
      matchedReturnIds: "[]",
    });
    const res = await loader({
      request: mkRequest({ auth: "Bearer t" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({
      error: "Session expired. Please look up your return again.",
    });
  });

  it("returns empty returns array when matchedReturnIds is '[]'", async () => {
    verifyPortalTokenMock.mockReturnValueOnce({ sessionId: "s1", shopId: "shop-1" });
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 60000),
      matchedReturnIds: "[]",
    });
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
    verifyPortalTokenMock.mockReturnValueOnce({ sessionId: "s1", shopId: "shop-1" });
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 60000),
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
    verifyPortalTokenMock.mockReturnValueOnce({ sessionId: "s1", shopId: "shop-1" });
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 60000),
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
    verifyPortalTokenMock.mockReturnValueOnce({ sessionId: "s1", shopId: "shop-1" });
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 60000),
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
    verifyPortalTokenMock.mockReturnValueOnce({ sessionId: "s1", shopId: "shop-1" });
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 60000),
      matchedReturnIds: "[]",
    });
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      portalLanguage: "fr",
      portalLabelsJson: JSON.stringify({ heading: "Mes Retours" }),
    });
    await loader({ request: mkRequest({ auth: "Bearer t" }), params: {}, context: {} } as never);
    expect(getPortalLabelsMock).toHaveBeenCalledWith("fr", { heading: "Mes Retours" });
  });

  it("tolerates malformed portalLabelsJson", async () => {
    verifyPortalTokenMock.mockReturnValueOnce({ sessionId: "s1", shopId: "shop-1" });
    prismaMock.lookupSession.findUnique.mockResolvedValueOnce({
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + 60000),
      matchedReturnIds: "[]",
    });
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
