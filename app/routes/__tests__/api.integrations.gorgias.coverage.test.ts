/**
 * Extra coverage tests for /api/integrations/gorgias
 * Focus: widget HTML generation, status/risk colors, sanitization-adjacent behavior,
 * shop domain handling, customer email normalization, fallback rendering.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, decryptMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  decryptMock: vi.fn((v: string) => (v ?? "").replace(/^enc:/, "")),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/encryption.server", () => ({
  decryptIfEncrypted: decryptMock,
}));

import { loader } from "../api.integrations.gorgias";

function mkReq(qs: string, headers: Record<string, string> = {}) {
  const hasApiKey =
    /(?:^|&)api_key=/.test(qs) ||
    Object.keys(headers).some((key) => key.toLowerCase() === "x-gorgias-api-key");
  const finalQs = qs && !hasApiKey ? `${qs}&api_key=secret` : qs;
  return new Request(`https://app.example/api/integrations/gorgias?${finalQs}`, {
    headers,
  });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  decryptMock.mockReset().mockImplementation((v: string) => (v ?? "").replace(/^enc:/, ""));
});

describe("Gorgias widget — HTML generation & sanitization coverage", () => {
  it("emits valid HTML doctype + utf-8 charset for the configuration error card", async () => {
    const res = await loader({ request: mkReq(""), params: {}, context: {} } as never);
    const html = await res.text();
    expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("<style>");
    expect(html).toContain("</body></html>");
    expect(res.headers.get("Content-Type")).toBe("text/html");
  });

  it("renders subtitle 'Customer:' line using the customerName when present", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: "enc:secret" },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        returnRequestNo: "R-1",
        shopifyOrderName: "#1001",
        status: "completed",
        resolutionType: "refund",
        createdAt: new Date("2025-02-01"),
        customerName: "Alice Smith",
        isGiftReturn: false,
        fraudRiskLevel: "low",
        fraudRiskScore: 5,
        items: [{ title: "Mug", qty: 1 }],
      },
    ]);
    const res = await loader({
      request: mkReq("shop=x&email=alice@example.com"),
      params: {},
      context: {},
    } as never);
    const html = await res.text();
    expect(html).toContain("Customer: Alice Smith");
    expect(html).not.toContain("Customer: alice@example.com");
  });

  it("escapes dynamic customer, order, request, and item values before rendering HTML", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: "enc:secret" },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: 'rc-"><script>',
        returnRequestNo: '<img src=x onerror="alert(1)">',
        shopifyOrderName: '#1001"><script>alert(1)</script>',
        status: "approved",
        resolutionType: 'store_credit"><script>',
        createdAt: new Date("2025-02-01"),
        customerName: '<b onclick="x">Alice</b>',
        isGiftReturn: false,
        fraudRiskLevel: null,
        fraudRiskScore: null,
        items: [{ title: '<script>alert("x")</script>', qty: 1 }],
      },
    ]);

    const res = await loader({
      request: mkReq("shop=x&email=alice@example.com"),
      params: {},
      context: {},
    } as never);
    const html = await res.text();

    expect(html).toContain("&lt;b onclick=&quot;x&quot;&gt;Alice&lt;/b&gt;");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("#1001&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
  });

  it("falls back to email in subtitle when customerName is null", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: "enc:secret" },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-2",
        returnRequestNo: "R-2",
        shopifyOrderName: "#1002",
        status: "completed",
        resolutionType: "refund",
        createdAt: new Date("2025-02-01"),
        customerName: null,
        isGiftReturn: false,
        fraudRiskLevel: null,
        fraudRiskScore: null,
        items: [{ title: "Mug", qty: 1 }],
      },
    ]);
    const res = await loader({
      request: mkReq("shop=x&email=Bob@Example.COM"),
      params: {},
      context: {},
    } as never);
    const html = await res.text();
    // email lower-cased in loader before being used
    expect(html).toContain("Customer: bob@example.com");
  });

  it("normalizes email to lowercase + trimmed when querying", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: "enc:secret" },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    await loader({
      request: mkReq("shop=x&email=" + encodeURIComponent("  TEST@Example.COM  ")),
      params: {},
      context: {},
    } as never);
    expect(prismaMock.returnCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ customerEmailNorm: "test@example.com" }),
      }),
    );
  });

  it("uses dotted shop domain as-is (no .myshopify.com appended)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: false },
    });
    await loader({
      request: mkReq("shop=custom.example.com"),
      params: {},
      context: {},
    } as never);
    expect(prismaMock.shop.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopDomain: "custom.example.com" },
      }),
    );
  });

  it("renders status badge color for 'pending' (amber bg)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: "enc:secret" },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        returnRequestNo: "R-1",
        shopifyOrderName: "#1001",
        status: "pending",
        resolutionType: "refund",
        createdAt: new Date("2025-01-01"),
        customerName: "X",
        isGiftReturn: false,
        fraudRiskLevel: null,
        fraudRiskScore: null,
        items: [{ title: "X", qty: 1 }],
      },
    ]);
    const html = await (
      await loader({ request: mkReq("shop=x&email=a@b.com"), params: {}, context: {} } as never)
    ).text();
    expect(html).toContain("PENDING");
    expect(html).toContain("#FEF3C7"); // pending bg
    expect(html).toContain("#92400E"); // pending text
  });

  it("renders status badge color for 'rejected' (red bg)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: "enc:secret" },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        returnRequestNo: "R-1",
        shopifyOrderName: "#1001",
        status: "rejected",
        resolutionType: "refund",
        createdAt: new Date("2025-01-01"),
        customerName: "X",
        isGiftReturn: false,
        fraudRiskLevel: null,
        fraudRiskScore: null,
        items: [{ title: "X", qty: 1 }],
      },
    ]);
    const html = await (
      await loader({ request: mkReq("shop=x&email=a@b.com"), params: {}, context: {} } as never)
    ).text();
    expect(html).toContain("REJECTED");
    expect(html).toContain("#FEE2E2"); // rejected bg
  });

  it("uses default neutral color for unknown status values", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: "enc:secret" },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        returnRequestNo: "R-1",
        shopifyOrderName: "#1001",
        status: "unknown_state",
        resolutionType: "refund",
        createdAt: new Date("2025-01-01"),
        customerName: "X",
        isGiftReturn: false,
        fraudRiskLevel: null,
        fraudRiskScore: null,
        items: [{ title: "X", qty: 1 }],
      },
    ]);
    const html = await (
      await loader({ request: mkReq("shop=x&email=a@b.com"), params: {}, context: {} } as never)
    ).text();
    expect(html).toContain("UNKNOWN_STATE");
    expect(html).toContain("#F3F4F6"); // default bg
    expect(html).toContain("#374151"); // default text
  });

  it("does not render risk badge when fraudRiskLevel is 'low'", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: "enc:secret" },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        returnRequestNo: "R-1",
        shopifyOrderName: "#1001",
        status: "approved",
        resolutionType: "refund",
        createdAt: new Date("2025-01-01"),
        customerName: "X",
        isGiftReturn: false,
        fraudRiskLevel: "low",
        fraudRiskScore: 5,
        items: [{ title: "X", qty: 1 }],
      },
    ]);
    const html = await (
      await loader({ request: mkReq("shop=x&email=a@b.com"), params: {}, context: {} } as never)
    ).text();
    expect(html).not.toContain("LOW RISK");
    expect(html).not.toContain("RISK</span>");
  });

  it("renders critical risk badge with red color scheme", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: "enc:secret" },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        returnRequestNo: "R-1",
        shopifyOrderName: "#1001",
        status: "approved",
        resolutionType: "refund",
        createdAt: new Date("2025-01-01"),
        customerName: "X",
        isGiftReturn: false,
        fraudRiskLevel: "critical",
        fraudRiskScore: 95,
        items: [{ title: "X", qty: 1 }],
      },
    ]);
    const html = await (
      await loader({ request: mkReq("shop=x&email=a@b.com"), params: {}, context: {} } as never)
    ).text();
    expect(html).toContain("CRITICAL RISK");
    expect(html).toContain("#DC2626"); // critical text color
  });

  it("renders medium risk badge with amber color", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: "enc:secret" },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        returnRequestNo: "R-1",
        shopifyOrderName: "#1001",
        status: "approved",
        resolutionType: "refund",
        createdAt: new Date("2025-01-01"),
        customerName: "X",
        isGiftReturn: false,
        fraudRiskLevel: "medium",
        fraudRiskScore: 50,
        items: [{ title: "X", qty: 1 }],
      },
    ]);
    const html = await (
      await loader({ request: mkReq("shop=x&email=a@b.com"), params: {}, context: {} } as never)
    ).text();
    expect(html).toContain("MEDIUM RISK");
    expect(html).toContain("#D97706"); // medium text color
  });

  it("falls back to id slice (8 chars) when returnRequestNo is null", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: "enc:secret" },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "abcdef1234567890",
        returnRequestNo: null,
        shopifyOrderName: "#1001",
        status: "approved",
        resolutionType: "refund",
        createdAt: new Date("2025-01-01"),
        customerName: "X",
        isGiftReturn: false,
        fraudRiskLevel: null,
        fraudRiskScore: null,
        items: [{ title: "X", qty: 1 }],
      },
    ]);
    const html = await (
      await loader({ request: mkReq("shop=x&email=a@b.com"), params: {}, context: {} } as never)
    ).text();
    // Slice is first 8 chars
    expect(html).toContain(">abcdef12<");
  });

  it("renders 'No items' label when items array is empty", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: "enc:secret" },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        returnRequestNo: "R-1",
        shopifyOrderName: "#1001",
        status: "approved",
        resolutionType: "refund",
        createdAt: new Date("2025-01-01"),
        customerName: "X",
        isGiftReturn: false,
        fraudRiskLevel: null,
        fraudRiskScore: null,
        items: [],
      },
    ]);
    const html = await (
      await loader({ request: mkReq("shop=x&email=a@b.com"), params: {}, context: {} } as never)
    ).text();
    expect(html).toContain("No items");
  });

  it("replaces underscores in resolutionType with spaces (e.g. 'store_credit' → 'store credit')", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: "enc:secret" },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        returnRequestNo: "R-1",
        shopifyOrderName: "#1001",
        status: "approved",
        resolutionType: "store_credit",
        createdAt: new Date("2025-01-01"),
        customerName: "X",
        isGiftReturn: false,
        fraudRiskLevel: null,
        fraudRiskScore: null,
        items: [{ title: "X", qty: 1 }],
      },
    ]);
    const html = await (
      await loader({ request: mkReq("shop=x&email=a@b.com"), params: {}, context: {} } as never)
    ).text();
    expect(html).toContain("store credit");
    expect(html).not.toContain("store_credit");
  });

  it("produces a deep link to the app /app/returns/<id> using SHOPIFY_APP_URL when set", async () => {
    const orig = process.env.SHOPIFY_APP_URL;
    process.env.SHOPIFY_APP_URL = "https://prod-app.example.com";
    try {
      prismaMock.shop.findUnique.mockResolvedValueOnce({
        id: "shop-1",
        settings: { gorgiasEnabled: true, gorgiasApiKey: "enc:secret" },
      });
      prismaMock.returnCase.findMany.mockResolvedValueOnce([
        {
          id: "rc-xyz",
          returnRequestNo: "R-9",
          shopifyOrderName: "#9009",
          status: "approved",
          resolutionType: "refund",
          createdAt: new Date("2025-01-01"),
          customerName: "X",
          isGiftReturn: false,
          fraudRiskLevel: null,
          fraudRiskScore: null,
          items: [{ title: "X", qty: 1 }],
        },
      ]);
      const html = await (
        await loader({ request: mkReq("shop=x&email=a@b.com"), params: {}, context: {} } as never)
      ).text();
      expect(html).toContain('href="https://prod-app.example.com/app/returns/rc-xyz"');
      expect(html).toContain('target="_blank"');
    } finally {
      if (orig === undefined) delete process.env.SHOPIFY_APP_URL;
      else process.env.SHOPIFY_APP_URL = orig;
    }
  });

  it("falls back to request.url origin for app link when SHOPIFY_APP_URL is unset", async () => {
    const orig = process.env.SHOPIFY_APP_URL;
    delete process.env.SHOPIFY_APP_URL;
    try {
      prismaMock.shop.findUnique.mockResolvedValueOnce({
        id: "shop-1",
        settings: { gorgiasEnabled: true, gorgiasApiKey: "enc:secret" },
      });
      prismaMock.returnCase.findMany.mockResolvedValueOnce([
        {
          id: "rc-1",
          returnRequestNo: "R-1",
          shopifyOrderName: "#1001",
          status: "approved",
          resolutionType: "refund",
          createdAt: new Date("2025-01-01"),
          customerName: "X",
          isGiftReturn: false,
          fraudRiskLevel: null,
          fraudRiskScore: null,
          items: [{ title: "X", qty: 1 }],
        },
      ]);
      const html = await (
        await loader({ request: mkReq("shop=x&email=a@b.com"), params: {}, context: {} } as never)
      ).text();
      expect(html).toContain('href="https://app.example/app/returns/rc-1"');
    } finally {
      if (orig !== undefined) process.env.SHOPIFY_APP_URL = orig;
    }
  });

  it("renders multiple items joined by comma", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: "enc:secret" },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        returnRequestNo: "R-1",
        shopifyOrderName: "#1001",
        status: "approved",
        resolutionType: "refund",
        createdAt: new Date("2025-01-01"),
        customerName: "X",
        isGiftReturn: false,
        fraudRiskLevel: null,
        fraudRiskScore: null,
        items: [
          { title: "T-shirt", qty: 2 },
          { title: "Hat", qty: 1 },
          { title: "Socks", qty: 3 },
        ],
      },
    ]);
    const html = await (
      await loader({ request: mkReq("shop=x&email=a@b.com"), params: {}, context: {} } as never)
    ).text();
    expect(html).toContain("T-shirt (x2), Hat (x1), Socks (x3)");
  });

  it("returns 'Returns (N)' header reflecting the actual array length (cap @ take=10)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: "enc:secret" },
    });
    const cases = Array.from({ length: 3 }, (_, i) => ({
      id: `rc-${i}`,
      returnRequestNo: `R-${i}`,
      shopifyOrderName: `#10${i}`,
      status: "approved",
      resolutionType: "refund",
      createdAt: new Date("2025-01-01"),
      customerName: "X",
      isGiftReturn: false,
      fraudRiskLevel: null,
      fraudRiskScore: null,
      items: [{ title: "X", qty: 1 }],
    }));
    prismaMock.returnCase.findMany.mockResolvedValueOnce(cases);
    const html = await (
      await loader({ request: mkReq("shop=x&email=a@b.com"), params: {}, context: {} } as never)
    ).text();
    expect(html).toContain("Returns (3)");
    // Verify take=10 cap is in the prisma call
    expect(prismaMock.returnCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 10 }),
    );
  });

  it("returns 401 status when no api key provided but one is configured", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: "enc:secret" },
    });
    decryptMock.mockImplementationOnce(() => "secret");
    const res = await loader({
      request: new Request("https://app.example/api/integrations/gorgias?shop=x&email=a@b.com"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain("Unauthorized");
    expect(html).toContain("Invalid API key");
  });
});
