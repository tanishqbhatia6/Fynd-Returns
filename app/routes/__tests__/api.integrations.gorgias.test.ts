import { describe, it, expect, vi, beforeEach } from "vitest";
import crypto from "node:crypto";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, decryptMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  decryptMock: vi.fn((v: string) => v), // no-op by default (treat as plaintext)
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/encryption.server", () => ({
  decryptIfEncrypted: decryptMock,
}));

import { loader } from "../api.integrations.gorgias";

function mkReq(qs: string, headers: Record<string, string> = {}) {
  return new Request(`https://app.example/api/integrations/gorgias?${qs}`, {
    headers,
  });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  decryptMock.mockReset().mockImplementation((v: string) => v);
});

describe("GET /api/integrations/gorgias (widget)", () => {
  it("renders a configuration-error card when shop param missing", async () => {
    const res = await loader({ request: mkReq(""), params: {}, context: {} } as never);
    expect(res.headers.get("Content-Type")).toBe("text/html");
    const html = await res.text();
    expect(html).toContain("Configuration Error");
  });

  it("renders 'Not Configured' card when shop has no Gorgias enabled", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: false },
    });
    const res = await loader({ request: mkReq("shop=x"), params: {}, context: {} } as never);
    const html = await res.text();
    expect(html).toContain("Not Configured");
  });

  it("401 + Unauthorized card when API key mismatches", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: "enc:realkey" },
    });
    decryptMock.mockImplementationOnce(() => "realkey");
    const res = await loader({
      request: mkReq("shop=x&api_key=wrong"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain("Unauthorized");
  });

  it("renders 'No Data' card when neither email nor order provided", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: null },
    });
    const res = await loader({ request: mkReq("shop=x"), params: {}, context: {} } as never);
    const html = await res.text();
    expect(html).toContain("No Data");
  });

  it("renders 'No Returns' card when none found by email", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: null },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    const res = await loader({
      request: mkReq("shop=x&email=a@b.com"),
      params: {},
      context: {},
    } as never);
    const html = await res.text();
    expect(html).toContain("No Returns");
  });

  it("renders return cards on match (with risk + gift badges when applicable)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: null },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        returnRequestNo: "R-1",
        shopifyOrderName: "#1001",
        status: "pending",
        resolutionType: "refund",
        createdAt: new Date("2025-01-01"),
        customerName: "Jane",
        isGiftReturn: true,
        fraudRiskLevel: "high",
        fraudRiskScore: 82,
        items: [{ title: "T-shirt", qty: 2 }],
      },
    ]);
    const res = await loader({
      request: mkReq("shop=x&email=jane@example.com"),
      params: {},
      context: {},
    } as never);
    const html = await res.text();
    expect(html).toContain("Returns (1)");
    expect(html).toContain("R-1");
    expect(html).toContain("GIFT");
    expect(html).toContain("HIGH RISK");
    expect(html).toContain("T-shirt (x2)");
  });

  it("falls back to query-without-new-fields when select throws", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: null },
    });
    // First call throws (missing column), second call succeeds with smaller select
    prismaMock.returnCase.findMany
      .mockRejectedValueOnce(new Error('column "isGiftReturn" does not exist'))
      .mockResolvedValueOnce([
        {
          id: "rc-1",
          returnRequestNo: "R-1",
          shopifyOrderName: "#1001",
          status: "approved",
          resolutionType: "refund",
          createdAt: new Date("2025-01-01"),
          customerName: "Jane",
          items: [{ title: "Widget", qty: 1 }],
        },
      ]);
    const res = await loader({
      request: mkReq("shop=x&email=jane@example.com"),
      params: {},
      context: {},
    } as never);
    const html = await res.text();
    expect(html).toContain("Widget (x1)");
    // No GIFT badge expected since fallback defaults isGiftReturn=false
    expect(html).not.toContain("GIFT");
  });

  it("matches order param when email absent", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: null },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    await loader({ request: mkReq("shop=x&order=%231001"), params: {}, context: {} } as never);
    expect(prismaMock.returnCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ shopifyOrderName: "#1001" }),
      }),
    );
  });

  it("normalizes non-dotted shop to .myshopify.com", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: false },
    });
    await loader({ request: mkReq("shop=mystore"), params: {}, context: {} } as never);
    expect(prismaMock.shop.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopDomain: "mystore.myshopify.com" },
      }),
    );
  });

  it("authenticates successfully when api key matches", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: "enc:secret" },
    });
    decryptMock.mockImplementationOnce(() => "secret");
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    const res = await loader({
      request: mkReq("shop=x&email=a@b.com&api_key=secret"),
      params: {},
      context: {},
    } as never);
    // Did not 401 — renders the normal "No Returns" card
    expect(res.status).not.toBe(401);
  });

  it("accepts api key via x-gorgias-api-key header", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: "enc:secret" },
    });
    decryptMock.mockImplementationOnce(() => "secret");
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    const res = await loader({
      request: mkReq("shop=x&email=a@b.com", { "x-gorgias-api-key": "secret" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).not.toBe(401);
  });
});
