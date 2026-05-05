/**
 * Smoke tests for /api/fix-order-ids — admin diagnostic + repair endpoint
 * for return cases whose shopifyOrderId never resolved to a real GID.
 *
 * Critical invariant under test: this endpoint MUST be authenticated and
 * tenant-scoped. Earlier audit flagged it as a P0 because it used to dump
 * cross-tenant PII without auth. The loader now requires `authenticate.admin`
 * and filters by `session.shop`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({
  authenticate: { admin: authenticateMock },
}));
vi.mock("../../lib/fynd-payload.server", () => ({
  extractAffiliateOrderIdFromFyndPayload: vi.fn(() => null),
  extractCustomerFromFyndPayload: vi.fn(() => null),
}));

import { loader, action } from "../api.fix-order-ids";

function mkReq(method = "GET", path = "/api/fix-order-ids") {
  return new Request(`https://app.example${path}`, { method });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({
    session: { shop: "store.myshopify.com", accessToken: "tok" },
    admin: {},
  });
});

describe("loader: GET /api/fix-order-ids", () => {
  it("404 when shop not found", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(404);
  });

  it("returns tenant-scoped summary on happy path", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", shopDomain: "store.myshopify.com" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        returnRequestNo: "R-1",
        shopifyOrderId: "FYNDSHOPIFYX14126",  // not a valid GID
        shopifyOrderName: "#1001",
        status: "approved",
        refundStatus: null,
        fyndPayloadJson: null,
        customerName: "Jane",
        customerEmailNorm: "u@example.com",
        customerPhoneNorm: null,
        customerCity: null,
        customerCountry: null,
        items: [{ id: "i-1", shopifyLineItemId: "gid://shopify/LineItem/1", sku: "SKU", title: "T", qty: 1 }],
      },
    ]);
    prismaMock.session.findFirst.mockResolvedValueOnce({ shop: "store.myshopify.com", accessToken: "tok" });

    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const body = await res.json();

    // Verify the loader scopes by shopId — that's the cross-tenant fix.
    expect(prismaMock.returnCase.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopId: "shop-1" },
      }),
    );
    // Cases array carries the diagnostic flags.
    expect(Array.isArray(body.cases)).toBe(true);
    expect(body.cases[0].isValidShopifyId).toBe(false);
  });

  it("propagates redirect from authenticate.admin (Shopify auth flow)", async () => {
    const redirect = new Response(null, { status: 302, headers: { Location: "/auth?shop=x" } });
    authenticateMock.mockRejectedValueOnce(redirect);
    await expect(
      loader({ request: mkReq(), params: {}, context: {} } as never),
    ).rejects.toBeInstanceOf(Response);
  });
});

describe("action: POST /api/fix-order-ids", () => {
  it("404 when shop not found", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await action({ request: mkReq("POST"), params: {}, context: {} } as never);
    expect(res.status).toBe(404);
  });

  it("authentication is required (auth throw propagates)", async () => {
    authenticateMock.mockRejectedValueOnce(new Response(null, { status: 401 }));
    await expect(
      action({ request: mkReq("POST"), params: {}, context: {} } as never),
    ).rejects.toBeInstanceOf(Response);
  });
});
