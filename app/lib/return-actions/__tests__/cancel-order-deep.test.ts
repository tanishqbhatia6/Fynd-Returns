/**
 * Deep unit tests for handleCancelOrder.
 *
 * The shallow happy-path / error-path coverage already lives in
 * extracted-handlers.test.ts. This file targets the *combinatorial* surface
 * specific to the cancel-order handler:
 *
 *   - Every value in VALID_CANCEL_REASONS (CUSTOMER, FRAUD, INVENTORY,
 *     DECLINED, OTHER) -> reason is forwarded to Shopify and recorded on
 *     the returnEvent payload.
 *   - The cancelReason is upper-cased before validation/forwarding.
 *   - refund=true|false and restock=true|false flags are forwarded
 *     verbatim to the Shopify orderCancel mutation and to the event
 *     payload (and default to true when omitted).
 *   - When Shopify orderCancel returns *multiple* userErrors the handler
 *     concatenates them with "; " into the 400 response body.
 *
 * Pattern mirrors extracted-handlers.test.ts: vi.hoisted mocks, prisma
 * factory, mkCtx + expectRedirect helpers.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../../test/prisma-mock";

const { prismaMock, fetchOrderByOrderNumberMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  fetchOrderByOrderNumberMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify-admin.server", () => ({
  closeShopifyReturnBestEffort: vi.fn(async () => ({ ok: true })),
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
}));

import { handleCancelOrder } from "../cancel-order.server";
import type { ReturnHandlerContext, ReturnActionBody } from "../types";

function mkCtx(overrides: Partial<ReturnHandlerContext> = {}): ReturnHandlerContext {
  return {
    id: "rc-1",
    returnCase: {
      id: "rc-1",
      adminNotes: null,
      returnRequestNo: "RQ-1",
      shopifyOrderName: "#1001",
      shopifyOrderId: "gid://shopify/Order/12345",
      customerEmailNorm: "user@example.com",
      status: "pending",
      items: [],
    } as never,
    shop: { id: "shop-1", shopDomain: "store.myshopify.com", settings: null },
    admin: { graphql: vi.fn() } as never,
    shopDomain: "store.myshopify.com",
    sessionEmail: "admin@example.com",
    isTerminal: false,
    elapsed: () => 100,
    logShopifyReturnEvent: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
    ...overrides,
  };
}

function mkAdminGraphql(userErrors: Array<{ field?: string[]; message: string }> = []) {
  return {
    graphql: vi.fn(async () => ({
      json: async () => ({
        data: { orderCancel: { orderCancelUserErrors: userErrors } },
      }),
    })),
  };
}

async function expectRedirect(p: Promise<unknown>, expectedPathFrag: string) {
  try {
    await p;
    throw new Error("expected handler to throw a redirect");
  } catch (err) {
    expect(err).toBeInstanceOf(Response);
    const res = err as Response;
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("Location")).toContain(expectedPathFrag);
  }
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  fetchOrderByOrderNumberMock.mockReset().mockResolvedValue(null);
});

describe("handleCancelOrder — deep coverage", () => {
  describe("every VALID_CANCEL_REASONS value", () => {
    const REASONS = ["CUSTOMER", "FRAUD", "INVENTORY", "DECLINED", "OTHER"] as const;

    for (const reason of REASONS) {
      it(`forwards reason=${reason} to Shopify and records it on the event`, async () => {
        const adminMock = mkAdminGraphql();
        await expectRedirect(
          handleCancelOrder(
            mkCtx({ admin: adminMock as never }),
            { action: "cancel_order", cancelReason: reason } as never,
          ),
          "/app/returns/rc-1",
        );

        // Forwarded to Shopify
        expect(adminMock.graphql).toHaveBeenCalledWith(
          expect.stringContaining("orderCancel"),
          expect.objectContaining({
            variables: expect.objectContaining({ reason }),
          }),
        );

        // Recorded in returnEvent payload
        const eventCall = prismaMock.returnEvent.create.mock.calls[0][0];
        const payload = JSON.parse(eventCall.data.payloadJson as string);
        expect(payload.reason).toBe(reason);
      });
    }
  });

  describe("cancelReason normalization", () => {
    it("upper-cases lowercase cancelReason before validating + forwarding", async () => {
      const adminMock = mkAdminGraphql();
      await expectRedirect(
        handleCancelOrder(
          mkCtx({ admin: adminMock as never }),
          { action: "cancel_order", cancelReason: "customer" } as never,
        ),
        "/app/returns/rc-1",
      );
      expect(adminMock.graphql).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ variables: expect.objectContaining({ reason: "CUSTOMER" }) }),
      );
    });

    it("defaults cancelReason to OTHER when omitted from body", async () => {
      const adminMock = mkAdminGraphql();
      await expectRedirect(
        handleCancelOrder(
          mkCtx({ admin: adminMock as never }),
          { action: "cancel_order" } as ReturnActionBody,
        ),
        "/app/returns/rc-1",
      );
      expect(adminMock.graphql).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ variables: expect.objectContaining({ reason: "OTHER" }) }),
      );
    });
  });

  describe("refund + restock flag matrix", () => {
    const cases: Array<{ refund?: boolean; restock?: boolean; expRefund: boolean; expRestock: boolean }> = [
      { refund: true,  restock: true,  expRefund: true,  expRestock: true  },
      { refund: true,  restock: false, expRefund: true,  expRestock: false },
      { refund: false, restock: true,  expRefund: false, expRestock: true  },
      { refund: false, restock: false, expRefund: false, expRestock: false },
    ];

    for (const c of cases) {
      it(`refund=${c.refund} + restock=${c.restock} forwards verbatim to Shopify and event payload`, async () => {
        const adminMock = mkAdminGraphql();
        await expectRedirect(
          handleCancelOrder(
            mkCtx({ admin: adminMock as never }),
            {
              action: "cancel_order",
              cancelReason: "CUSTOMER",
              refund: c.refund,
              restock: c.restock,
            } as never,
          ),
          "/app/returns/rc-1",
        );

        expect(adminMock.graphql).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            variables: expect.objectContaining({
              refund: c.expRefund,
              restock: c.expRestock,
            }),
          }),
        );

        const eventCall = prismaMock.returnEvent.create.mock.calls[0][0];
        const payload = JSON.parse(eventCall.data.payloadJson as string);
        expect(payload.refund).toBe(c.expRefund);
        expect(payload.restock).toBe(c.expRestock);
      });
    }

    it("defaults both refund and restock to true when omitted from body", async () => {
      const adminMock = mkAdminGraphql();
      await expectRedirect(
        handleCancelOrder(
          mkCtx({ admin: adminMock as never }),
          { action: "cancel_order", cancelReason: "OTHER" } as never,
        ),
        "/app/returns/rc-1",
      );
      expect(adminMock.graphql).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          variables: expect.objectContaining({ refund: true, restock: true }),
        }),
      );
    });
  });

  describe("Shopify orderCancel multiple userErrors", () => {
    it("concatenates two userErrors with '; ' in the 400 response body", async () => {
      const adminMock = mkAdminGraphql([
        { message: "order already cancelled" },
        { message: "refund not allowed" },
      ]);
      const res = await handleCancelOrder(
        mkCtx({ admin: adminMock as never }),
        { action: "cancel_order", cancelReason: "FRAUD" } as never,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe(
        "Order cancellation failed: order already cancelled; refund not allowed",
      );

      // No DB writes should occur on userErrors path.
      expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
      expect(prismaMock.returnEvent.create).not.toHaveBeenCalled();
    });

    it("concatenates three userErrors and skips DB writes on userErrors path", async () => {
      const adminMock = mkAdminGraphql([
        { message: "err1" },
        { message: "err2" },
        { message: "err3" },
      ]);
      const res = await handleCancelOrder(
        mkCtx({ admin: adminMock as never }),
        { action: "cancel_order", cancelReason: "INVENTORY" } as never,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Order cancellation failed: err1; err2; err3");
      expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
    });
  });
});
