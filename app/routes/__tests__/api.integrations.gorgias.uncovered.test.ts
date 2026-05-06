/**
 * Targeted coverage for the last uncovered branches in
 * `app/routes/api.integrations.gorgias.ts`.
 *
 * Lines covered here:
 *   - 49  : catch branch when crypto.timingSafeEqual throws despite
 *           length-equal buffers (defensive guard against host quirks)
 *   - 167 : status === "cancelled" branch in getStatusColor
 *   - 177 : default branch in getRiskColor (non low/medium/high/critical)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, decryptMock, timingSafeEqualMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  decryptMock: vi.fn((v: string) => v),
  timingSafeEqualMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/encryption.server", () => ({
  decryptIfEncrypted: decryptMock,
}));

// Override node:crypto so we can force timingSafeEqual to throw on demand
// while leaving the rest of the module untouched.
vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return {
    ...actual,
    default: {
      ...actual,
      timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) =>
        timingSafeEqualMock(a, b),
    },
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) =>
      timingSafeEqualMock(a, b),
  };
});

import { loader } from "../api.integrations.gorgias";

function mkReq(qs: string, headers: Record<string, string> = {}) {
  return new Request(`https://app.example/api/integrations/gorgias?${qs}`, {
    headers,
  });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  decryptMock.mockReset().mockImplementation((v: string) => v);
  timingSafeEqualMock.mockReset();
});

describe("Gorgias widget — uncovered-branch coverage", () => {
  it("returns 401 Unauthorized when crypto.timingSafeEqual throws (line 49 catch)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: "enc:secret" },
    });
    decryptMock.mockImplementationOnce(() => "secret");
    // Force the timingSafeEqual call to throw even though both buffers
    // have equal length — this exercises the `catch { ok = false; }` branch.
    timingSafeEqualMock.mockImplementationOnce(() => {
      throw new Error("simulated host crypto failure");
    });

    const res = await loader({
      request: mkReq("shop=x&email=a@b.com&api_key=secret"),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(401);
    const html = await res.text();
    expect(html).toContain("Unauthorized");
    expect(html).toContain("Invalid API key");
    // The catch path must have been entered exactly once.
    expect(timingSafeEqualMock).toHaveBeenCalledTimes(1);
  });

  it("renders 'cancelled' status with the dedicated neutral palette (line 167)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: null },
    });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-cancel",
        returnRequestNo: "R-C",
        shopifyOrderName: "#1010",
        status: "cancelled",
        resolutionType: "refund",
        createdAt: new Date("2025-03-03"),
        customerName: "Cancel Customer",
        isGiftReturn: false,
        fraudRiskLevel: null,
        fraudRiskScore: null,
        items: [{ title: "Hat", qty: 1 }],
      },
    ]);

    const res = await loader({
      request: mkReq("shop=x&email=cancel@example.com"),
      params: {},
      context: {},
    } as never);

    const html = await res.text();
    expect(html).toContain("CANCELLED");
    // Cancelled-specific palette literal — same colors as default but the
    // case branch (line 167) must be the one taken before the `default`.
    expect(html).toContain("#F3F4F6");
    expect(html).toContain("#374151");
  });

  it("uses default risk palette for an unrecognized fraudRiskLevel (line 177)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: null },
    });
    // fraudRiskLevel is truthy and !== "low", so the badge is rendered;
    // but it's not one of critical/high/medium, so getRiskColor falls
    // through to the `default` branch (line 177).
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-unknown-risk",
        returnRequestNo: "R-UR",
        shopifyOrderName: "#1011",
        status: "approved",
        resolutionType: "refund",
        createdAt: new Date("2025-03-04"),
        customerName: "Risky",
        isGiftReturn: false,
        fraudRiskLevel: "unspecified",
        fraudRiskScore: 42,
        items: [{ title: "Mug", qty: 1 }],
      },
    ]);

    const res = await loader({
      request: mkReq("shop=x&email=risky@example.com"),
      params: {},
      context: {},
    } as never);

    const html = await res.text();
    expect(html).toContain("UNSPECIFIED RISK");
    // Default risk palette literals
    expect(html).toContain("#F3F4F6"); // bg
    expect(html).toContain("#6B7280"); // text — unique to the risk default
  });
});
