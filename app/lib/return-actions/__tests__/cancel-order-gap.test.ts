/**
 * Gap-coverage tests for handleCancelOrder.
 *
 * Covers branches not exercised by cancel-order-deep.test.ts:
 *   - Invalid cancel reason -> 400.
 *   - returnCase.shopifyOrderId is null/empty -> 400 ("no valid Shopify order linked").
 *   - returnCase.shopifyOrderId starts with "manual:" -> 400.
 *   - orderGid resolution: numeric-only id is wrapped into gid://shopify/Order/<id>.
 *   - orderGid resolution: non-numeric id + shopifyOrderName present, fetchOrderByOrderNumber
 *     returns a hit -> uses returned id.
 *   - orderGid resolution: non-numeric id + shopifyOrderName present, fetchOrderByOrderNumber
 *     returns null -> 400 ("Could not resolve Shopify order").
 *   - orderGid resolution: non-numeric id + shopifyOrderName missing -> 400.
 *   - shopifyOrderName with leading "#" gets stripped before lookup.
 *   - cancelReason validation runs *before* orderGid resolution / mutation.
 *   - When admin.notes is missing, falls back to existing returnCase.adminNotes
 *     (and to null when both are absent).
 *   - When `note` is provided in body, it is forwarded to update + event payload.
 *   - Catch block: non-Response Error reaches extractErrorMessage (ECONNREFUSED branch
 *     and generic Error.message branch) and returns 500.
 *   - Catch block: non-Error/non-Response thrown value falls back to default message.
 *   - Redirect response thrown inside withSpan is rethrown as-is.
 *   - Non-redirect Response thrown inside the body is rethrown as-is.
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
import type { ReturnHandlerContext } from "../types";

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

beforeEach(() => {
  resetPrismaMock(prismaMock);
  fetchOrderByOrderNumberMock.mockReset().mockResolvedValue(null);
});

describe("handleCancelOrder — gap coverage", () => {
  describe("cancelReason validation", () => {
    it("returns 400 when cancelReason is not in VALID_CANCEL_REASONS", async () => {
      const adminMock = mkAdminGraphql();
      const res = await handleCancelOrder(
        mkCtx({ admin: adminMock as never }),
        { action: "cancel_order", cancelReason: "BOGUS" } as never,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Invalid cancel reason");
      expect(body.error).toContain("BOGUS");
      expect(adminMock.graphql).not.toHaveBeenCalled();
      expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
    });

    it("invalid reason short-circuits before orderGid resolution", async () => {
      const adminMock = mkAdminGraphql();
      const res = await handleCancelOrder(
        mkCtx({
          admin: adminMock as never,
          returnCase: {
            id: "rc-1",
            adminNotes: null,
            returnRequestNo: "RQ-1",
            shopifyOrderName: "#1001",
            // intentionally invalid orderId so we'd 400 via the orderGid branch too
            shopifyOrderId: "manual:abc",
            customerEmailNorm: "u@e.com",
            status: "pending",
            items: [],
          } as never,
        }),
        { action: "cancel_order", cancelReason: "garbage" } as never,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("Invalid cancel reason");
    });
  });

  describe("missing / manual shopifyOrderId", () => {
    it("returns 400 when shopifyOrderId is null", async () => {
      const adminMock = mkAdminGraphql();
      const res = await handleCancelOrder(
        mkCtx({
          admin: adminMock as never,
          returnCase: {
            id: "rc-1",
            adminNotes: null,
            returnRequestNo: "RQ-1",
            shopifyOrderName: "#1001",
            shopifyOrderId: null,
            customerEmailNorm: "u@e.com",
            status: "pending",
            items: [],
          } as never,
        }),
        { action: "cancel_order", cancelReason: "OTHER" } as never,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Cannot cancel: no valid Shopify order linked");
      expect(adminMock.graphql).not.toHaveBeenCalled();
    });

    it("returns 400 when shopifyOrderId is an empty string", async () => {
      const adminMock = mkAdminGraphql();
      const res = await handleCancelOrder(
        mkCtx({
          admin: adminMock as never,
          returnCase: {
            id: "rc-1",
            adminNotes: null,
            returnRequestNo: "RQ-1",
            shopifyOrderName: "#1001",
            shopifyOrderId: "",
            customerEmailNorm: "u@e.com",
            status: "pending",
            items: [],
          } as never,
        }),
        { action: "cancel_order", cancelReason: "OTHER" } as never,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Cannot cancel: no valid Shopify order linked");
    });

    it("returns 400 when shopifyOrderId starts with 'manual:'", async () => {
      const adminMock = mkAdminGraphql();
      const res = await handleCancelOrder(
        mkCtx({
          admin: adminMock as never,
          returnCase: {
            id: "rc-1",
            adminNotes: null,
            returnRequestNo: "RQ-1",
            shopifyOrderName: "#1001",
            shopifyOrderId: "manual:something",
            customerEmailNorm: "u@e.com",
            status: "pending",
            items: [],
          } as never,
        }),
        { action: "cancel_order", cancelReason: "OTHER" } as never,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Cannot cancel: no valid Shopify order linked");
      expect(adminMock.graphql).not.toHaveBeenCalled();
      expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
    });
  });

  describe("orderGid resolution", () => {
    it("wraps a numeric-only shopifyOrderId into gid://shopify/Order/<id>", async () => {
      const adminMock = mkAdminGraphql();
      try {
        await handleCancelOrder(
          mkCtx({
            admin: adminMock as never,
            returnCase: {
              id: "rc-1",
              adminNotes: null,
              returnRequestNo: "RQ-1",
              shopifyOrderName: "#1001",
              shopifyOrderId: "9876543210",
              customerEmailNorm: "u@e.com",
              status: "pending",
              items: [],
            } as never,
          }),
          { action: "cancel_order", cancelReason: "CUSTOMER" } as never,
        );
        throw new Error("expected redirect");
      } catch (err) {
        expect(err).toBeInstanceOf(Response);
      }

      expect(adminMock.graphql).toHaveBeenCalledWith(
        expect.stringContaining("orderCancel"),
        expect.objectContaining({
          variables: expect.objectContaining({
            orderId: "gid://shopify/Order/9876543210",
          }),
        }),
      );

      // numeric path should not consult fetchOrderByOrderNumber
      expect(fetchOrderByOrderNumberMock).not.toHaveBeenCalled();

      // event payload includes the wrapped gid
      const eventCall = prismaMock.returnEvent.create.mock.calls[0][0];
      const payload = JSON.parse(eventCall.data.payloadJson as string);
      expect(payload.orderId).toBe("gid://shopify/Order/9876543210");
    });

    it("falls back to fetchOrderByOrderNumber for non-numeric, non-gid id and uses its returned id", async () => {
      fetchOrderByOrderNumberMock.mockResolvedValueOnce({ id: "gid://shopify/Order/55555" });
      const adminMock = mkAdminGraphql();
      try {
        await handleCancelOrder(
          mkCtx({
            admin: adminMock as never,
            returnCase: {
              id: "rc-1",
              adminNotes: null,
              returnRequestNo: "RQ-1",
              shopifyOrderName: "#1001",
              shopifyOrderId: "weird-non-numeric-id",
              customerEmailNorm: "u@e.com",
              status: "pending",
              items: [],
            } as never,
          }),
          { action: "cancel_order", cancelReason: "CUSTOMER" } as never,
        );
        throw new Error("expected redirect");
      } catch (err) {
        expect(err).toBeInstanceOf(Response);
      }

      // "#" should be stripped before lookup
      expect(fetchOrderByOrderNumberMock).toHaveBeenCalledWith(expect.anything(), "1001");
      expect(adminMock.graphql).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          variables: expect.objectContaining({ orderId: "gid://shopify/Order/55555" }),
        }),
      );
    });

    it("returns 400 when fetchOrderByOrderNumber resolves null", async () => {
      fetchOrderByOrderNumberMock.mockResolvedValueOnce(null);
      const adminMock = mkAdminGraphql();
      const res = await handleCancelOrder(
        mkCtx({
          admin: adminMock as never,
          returnCase: {
            id: "rc-1",
            adminNotes: null,
            returnRequestNo: "RQ-1",
            shopifyOrderName: "#1001",
            shopifyOrderId: "weird-non-numeric-id",
            customerEmailNorm: "u@e.com",
            status: "pending",
            items: [],
          } as never,
        }),
        { action: "cancel_order", cancelReason: "OTHER" } as never,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Could not resolve Shopify order for cancellation");
      expect(adminMock.graphql).not.toHaveBeenCalled();
    });

    it("returns 400 when fetchOrderByOrderNumber resolves a value with no id", async () => {
      fetchOrderByOrderNumberMock.mockResolvedValueOnce({ /* no id */ });
      const adminMock = mkAdminGraphql();
      const res = await handleCancelOrder(
        mkCtx({
          admin: adminMock as never,
          returnCase: {
            id: "rc-1",
            adminNotes: null,
            returnRequestNo: "RQ-1",
            shopifyOrderName: "#1001",
            shopifyOrderId: "weird-non-numeric-id",
            customerEmailNorm: "u@e.com",
            status: "pending",
            items: [],
          } as never,
        }),
        { action: "cancel_order", cancelReason: "OTHER" } as never,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Could not resolve Shopify order for cancellation");
    });

    it("returns 400 when shopifyOrderName is missing for non-numeric id (skips fetch entirely)", async () => {
      const adminMock = mkAdminGraphql();
      const res = await handleCancelOrder(
        mkCtx({
          admin: adminMock as never,
          returnCase: {
            id: "rc-1",
            adminNotes: null,
            returnRequestNo: "RQ-1",
            shopifyOrderName: null,
            shopifyOrderId: "weird-non-numeric-id",
            customerEmailNorm: "u@e.com",
            status: "pending",
            items: [],
          } as never,
        }),
        { action: "cancel_order", cancelReason: "OTHER" } as never,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Could not resolve Shopify order for cancellation");
      expect(fetchOrderByOrderNumberMock).not.toHaveBeenCalled();
    });
  });

  describe("note + adminNotes handling", () => {
    it("forwards note from body to returnCase.update + event payload", async () => {
      const adminMock = mkAdminGraphql();
      try {
        await handleCancelOrder(
          mkCtx({ admin: adminMock as never }),
          { action: "cancel_order", cancelReason: "CUSTOMER", note: "fraudulent order" } as never,
        );
        throw new Error("expected redirect");
      } catch (err) {
        expect(err).toBeInstanceOf(Response);
      }

      const updateCall = prismaMock.returnCase.update.mock.calls[0][0];
      expect(updateCall.data.adminNotes).toBe("fraudulent order");

      const eventCall = prismaMock.returnEvent.create.mock.calls[0][0];
      const payload = JSON.parse(eventCall.data.payloadJson as string);
      expect(payload.note).toBe("fraudulent order");
      expect(payload.adminEmail).toBe("admin@example.com");
    });

    it("falls back to existing adminNotes when body.note is omitted", async () => {
      const adminMock = mkAdminGraphql();
      try {
        await handleCancelOrder(
          mkCtx({
            admin: adminMock as never,
            returnCase: {
              id: "rc-1",
              adminNotes: "previous note",
              returnRequestNo: "RQ-1",
              shopifyOrderName: "#1001",
              shopifyOrderId: "gid://shopify/Order/12345",
              customerEmailNorm: "u@e.com",
              status: "pending",
              items: [],
            } as never,
          }),
          { action: "cancel_order", cancelReason: "CUSTOMER" } as never,
        );
        throw new Error("expected redirect");
      } catch (err) {
        expect(err).toBeInstanceOf(Response);
      }

      const updateCall = prismaMock.returnCase.update.mock.calls[0][0];
      expect(updateCall.data.adminNotes).toBe("previous note");

      const eventCall = prismaMock.returnEvent.create.mock.calls[0][0];
      const payload = JSON.parse(eventCall.data.payloadJson as string);
      expect(payload.note).toBeNull();
    });
  });

  describe("misc branch coverage", () => {
    it("handles missing returnRequestNo (falsy fallback to empty string in span attrs)", async () => {
      const adminMock = mkAdminGraphql();
      try {
        await handleCancelOrder(
          mkCtx({
            admin: adminMock as never,
            returnCase: {
              id: "rc-1",
              adminNotes: null,
              returnRequestNo: null,
              shopifyOrderName: "#1001",
              shopifyOrderId: "gid://shopify/Order/12345",
              customerEmailNorm: "u@e.com",
              status: "pending",
              items: [],
            } as never,
          }),
          { action: "cancel_order", cancelReason: "OTHER" } as never,
        );
        throw new Error("expected redirect");
      } catch (err) {
        expect(err).toBeInstanceOf(Response);
      }
      // success path was taken -> mutation called
      expect(adminMock.graphql).toHaveBeenCalled();
    });

    it("treats missing orderCancelUserErrors as success (?? [] branch)", async () => {
      const adminMock = {
        graphql: vi.fn(async () => ({
          json: async () => ({ data: { orderCancel: {} } }),
        })),
      };
      try {
        await handleCancelOrder(
          mkCtx({ admin: adminMock as never }),
          { action: "cancel_order", cancelReason: "OTHER" } as never,
        );
        throw new Error("expected redirect");
      } catch (err) {
        expect(err).toBeInstanceOf(Response);
        expect((err as Response).status).toBeGreaterThanOrEqual(300);
        expect((err as Response).status).toBeLessThan(400);
      }
      expect(prismaMock.returnCase.update).toHaveBeenCalled();
    });

    it("treats missing data.orderCancel as success (?? [] branch via undefined chain)", async () => {
      const adminMock = {
        graphql: vi.fn(async () => ({
          json: async () => ({ data: {} }),
        })),
      };
      try {
        await handleCancelOrder(
          mkCtx({ admin: adminMock as never }),
          { action: "cancel_order", cancelReason: "OTHER" } as never,
        );
        throw new Error("expected redirect");
      } catch (err) {
        expect(err).toBeInstanceOf(Response);
      }
      expect(prismaMock.returnCase.update).toHaveBeenCalled();
    });
  });

  describe("catch block", () => {
    it("returns 500 with generic Error.message when admin.graphql throws a plain Error", async () => {
      const adminMock = {
        graphql: vi.fn(async () => {
          throw new Error("boom internal");
        }),
      };
      const res = await handleCancelOrder(
        mkCtx({ admin: adminMock as never }),
        { action: "cancel_order", cancelReason: "OTHER" } as never,
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("boom internal");
      expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
    });

    it("maps ECONNREFUSED Error to a friendly external-service message", async () => {
      const adminMock = {
        graphql: vi.fn(async () => {
          throw new Error("connect ECONNREFUSED 127.0.0.1:80");
        }),
      };
      const res = await handleCancelOrder(
        mkCtx({ admin: adminMock as never }),
        { action: "cancel_order", cancelReason: "OTHER" } as never,
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("Unable to connect to external service. Please try again later.");
    });

    it("uses default message when extractErrorMessage returns empty", async () => {
      // throw a non-Error, non-Response value with empty string coercion -> default.
      const adminMock = {
        graphql: vi.fn(async () => {
          // eslint-disable-next-line no-throw-literal
          throw "";
        }),
      };
      const res = await handleCancelOrder(
        mkCtx({ admin: adminMock as never }),
        { action: "cancel_order", cancelReason: "OTHER" } as never,
      );
      expect(res.status).toBe(500);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe(
        "Order cancellation failed. Please try again or cancel manually in Shopify Admin.",
      );
    });

    it("rethrows a non-redirect Response thrown from prisma.returnCase.update without wrapping in 500", async () => {
      const customResponse = Response.json({ error: "downstream failure" }, { status: 503 });
      prismaMock.returnCase.update.mockImplementationOnce(async () => {
        throw customResponse;
      });
      const adminMock = mkAdminGraphql();
      try {
        await handleCancelOrder(
          mkCtx({ admin: adminMock as never }),
          { action: "cancel_order", cancelReason: "OTHER" } as never,
        );
        throw new Error("expected the Response to be re-thrown");
      } catch (err) {
        expect(err).toBe(customResponse);
        expect((err as Response).status).toBe(503);
      }
    });
  });
});
