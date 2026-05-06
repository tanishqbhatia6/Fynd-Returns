/**
 * Unit tests for the extracted return-action handlers. These verify that:
 *   1. Each handler writes the expected DB rows (returnCase update + event).
 *   2. Each handler throws a redirect Response on success.
 *   3. Each handler propagates real errors (not redirects).
 *
 * Behavior must match what the inline switch in api.returns.$id.actions.ts
 * did before the extraction. Existing route-level tests
 * (api.returns.id.actions.test.ts) prove the *integration* is correct;
 * these prove the *unit* contracts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../../test/prisma-mock";

const {
  prismaMock,
  sendCustomerNoteNotificationMock,
  closeShopifyReturnBestEffortMock,
  fetchOrderByOrderNumberMock,
  sendRejectionNotificationMock,
  sendCancellationDeclinedNotificationMock,
  createFyndClientOrErrorMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  sendCustomerNoteNotificationMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(
    async () => undefined,
  ),
  closeShopifyReturnBestEffortMock: vi.fn(async () => ({ ok: true })),
  fetchOrderByOrderNumberMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  sendRejectionNotificationMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(
    async () => undefined,
  ),
  sendCancellationDeclinedNotificationMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(
    async () => undefined,
  ),
  createFyndClientOrErrorMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    ok: false,
    error: "disabled",
  })),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../../db.server", () => ({ default: prismaMock }));
vi.mock("../../notification.server", () => ({
  sendCustomerNoteNotification: sendCustomerNoteNotificationMock,
  sendRejectionNotification: sendRejectionNotificationMock,
  sendCancellationDeclinedNotification: sendCancellationDeclinedNotificationMock,
}));
vi.mock("../../shopify-admin.server", () => ({
  closeShopifyReturnBestEffort: closeShopifyReturnBestEffortMock,
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
}));
vi.mock("../../fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
}));

import { handleAddNote } from "../add-note.server";
import { handleSaveNotesForCustomer } from "../save-notes-for-customer.server";
import { handleUpdateLabel } from "../update-label.server";
import { handleUpdateInstructions } from "../update-instructions.server";
import { handleEditDetails } from "../edit-details.server";
import { handleUpdateStatus } from "../update-status.server";
import { handleCancelOrder } from "../cancel-order.server";
import { handleReject } from "../reject.server";
import { handleDeclineCancellation } from "../decline-cancellation.server";
import { handleRefreshFyndDetails } from "../refresh-fynd-details.server";
import type { ReturnHandlerContext, ReturnActionBody } from "../types";

function mkCtx(overrides: Partial<ReturnHandlerContext> = {}): ReturnHandlerContext {
  return {
    id: "rc-1",
    returnCase: {
      id: "rc-1",
      adminNotes: null,
      returnRequestNo: "RQ-1",
      shopifyOrderName: "#1001",
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
  sendCustomerNoteNotificationMock.mockReset().mockResolvedValue(undefined);
  closeShopifyReturnBestEffortMock.mockReset().mockResolvedValue({ ok: true });
  fetchOrderByOrderNumberMock.mockReset().mockResolvedValue(null);
  sendRejectionNotificationMock.mockReset().mockResolvedValue(undefined);
  sendCancellationDeclinedNotificationMock.mockReset().mockResolvedValue(undefined);
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({ ok: false, error: "disabled" });
});

function mkAdminGraphql(userErrors: Array<{ field?: string[]; message: string }> = []) {
  return {
    graphql: vi.fn(async () => ({
      json: async () => ({
        data: { orderCancel: { orderCancelUserErrors: userErrors } },
      }),
    })),
  };
}

describe("handleAddNote", () => {
  it("writes adminNotes + event and throws redirect", async () => {
    await expectRedirect(
      handleAddNote(mkCtx(), { action: "add_note", note: "hello" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith({
      where: { id: "rc-1" },
      data: { adminNotes: "hello" },
    });
    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "note_added",
          source: "admin",
        }),
      }),
    );
  });

  it("propagates non-redirect errors", async () => {
    prismaMock.returnCase.update.mockRejectedValueOnce(new Error("db"));
    await expect(
      handleAddNote(mkCtx(), { action: "add_note", note: "x" } as ReturnActionBody),
    ).rejects.toThrow("db");
  });

  it("falls back to existing adminNotes when note is undefined", async () => {
    await expectRedirect(
      handleAddNote(mkCtx({ returnCase: { ...mkCtx().returnCase, adminNotes: "prev" } as never }), {
        action: "add_note",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith({
      where: { id: "rc-1" },
      data: { adminNotes: "prev" },
    });
  });
});

describe("handleSaveNotesForCustomer", () => {
  it("writes notesForCustomer + event and dispatches notification", async () => {
    await expectRedirect(
      handleSaveNotesForCustomer(mkCtx(), {
        action: "save_notes_for_customer",
        notesForCustomer: "Please ship via X",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith({
      where: { id: "rc-1" },
      data: { notesForCustomer: "Please ship via X" },
    });
    expect(sendCustomerNoteNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        shopDomain: "store.myshopify.com",
        to: "user@example.com",
        orderName: "#1001",
        note: "Please ship via X",
      }),
    );
  });

  it("does not notify when value is null", async () => {
    await expectRedirect(
      handleSaveNotesForCustomer(mkCtx(), {
        action: "save_notes_for_customer",
        notesForCustomer: "",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(sendCustomerNoteNotificationMock).not.toHaveBeenCalled();
  });

  it("notification rejection does not abort the action", async () => {
    sendCustomerNoteNotificationMock.mockRejectedValueOnce(new Error("smtp"));
    await expectRedirect(
      handleSaveNotesForCustomer(mkCtx(), {
        action: "save_notes_for_customer",
        notesForCustomer: "hi",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });
});

describe("handleUpdateLabel", () => {
  it("stores trimmed label fields + event", async () => {
    await expectRedirect(
      handleUpdateLabel(mkCtx(), {
        action: "update_label",
        carrier: "  UPS  ",
        trackingNumber: " 123 ",
        labelUrl: " https://x/y ",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const update = prismaMock.returnCase.update.mock.calls[0][0];
    const stored = JSON.parse(update.data.returnLabelJson as string);
    expect(stored.carrier).toBe("UPS");
    expect(stored.trackingNumber).toBe("123");
    expect(stored.labelUrl).toBe("https://x/y");
    expect(update.data.returnLabelUrl).toBe("https://x/y");
  });

  it("nulls fields when empty strings provided", async () => {
    await expectRedirect(
      handleUpdateLabel(mkCtx(), { action: "update_label", carrier: "" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const stored = JSON.parse(
      prismaMock.returnCase.update.mock.calls[0][0].data.returnLabelJson as string,
    );
    expect(stored.carrier).toBeNull();
  });
});

describe("handleUpdateInstructions", () => {
  it("upserts shopSettings.defaultReturnInstructions and writes event", async () => {
    await expectRedirect(
      handleUpdateInstructions(mkCtx(), {
        action: "update_instructions",
        returnInstructions: "  Please pack original box  ",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(prismaMock.shopSettings.upsert).toHaveBeenCalledWith({
      where: { shopId: "shop-1" },
      create: { shopId: "shop-1", defaultReturnInstructions: "Please pack original box" },
      update: { defaultReturnInstructions: "Please pack original box" },
    });
  });

  it("stores null when instructions blank", async () => {
    await expectRedirect(
      handleUpdateInstructions(mkCtx(), {
        action: "update_instructions",
        returnInstructions: "",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const arg = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(arg.update.defaultReturnInstructions).toBeNull();
  });
});

describe("handleUpdateStatus", () => {
  it("400 when no status provided", async () => {
    const res = await handleUpdateStatus(mkCtx(), { action: "update_status" } as ReturnActionBody);
    expect(res.status).toBe(400);
  });

  it("400 on invalid status", async () => {
    const res = await handleUpdateStatus(mkCtx(), {
      action: "update_status",
      status: "bogus",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
  });

  it("updates returnCase + writes event on valid status", async () => {
    await expectRedirect(
      handleUpdateStatus(mkCtx(), {
        action: "update_status",
        status: "processing",
        note: "hi",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "rc-1" },
        data: expect.objectContaining({ status: "processing" }),
      }),
    );
    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: "status_updated" }),
      }),
    );
  });

  it("calls close on terminal completed status", async () => {
    await expectRedirect(
      handleUpdateStatus(mkCtx(), {
        action: "update_status",
        status: "completed",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(closeShopifyReturnBestEffortMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: "close" }),
    );
  });

  it("calls decline on rejected status (with declineReason)", async () => {
    await expectRedirect(
      handleUpdateStatus(mkCtx(), {
        action: "update_status",
        status: "rejected",
        note: "Damaged in customer photos",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(closeShopifyReturnBestEffortMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        action: "decline",
        declineReason: "Damaged in customer photos",
      }),
    );
  });
});

describe("handleReject", () => {
  it("400 when return is already terminal", async () => {
    const res = await handleReject(mkCtx({ isTerminal: true }), {
      action: "reject",
      rejectionReason: "x",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
  });

  it("400 when rejection reason is empty", async () => {
    const res = await handleReject(mkCtx(), {
      action: "reject",
      rejectionReason: "",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
  });

  it("400 when rejection reason exceeds 500 chars", async () => {
    const res = await handleReject(mkCtx(), {
      action: "reject",
      rejectionReason: "x".repeat(501),
    } as ReturnActionBody);
    expect(res.status).toBe(400);
  });

  it("happy path: status=rejected, declines Shopify return, dispatches notification", async () => {
    await expectRedirect(
      handleReject(mkCtx(), {
        action: "reject",
        rejectionReason: "Damaged in customer photos",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: "rejected",
          rejectionReason: "Damaged in customer photos",
        }),
      }),
    );
    expect(closeShopifyReturnBestEffortMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ action: "decline", declineReason: "Damaged in customer photos" }),
    );
    expect(sendRejectionNotificationMock).toHaveBeenCalled();
  });

  it("notification rejection does not abort the action", async () => {
    sendRejectionNotificationMock.mockRejectedValueOnce(new Error("smtp"));
    await expectRedirect(
      handleReject(mkCtx(), { action: "reject", rejectionReason: "ok" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });

  it("does not send notification when no customerEmail", async () => {
    await expectRedirect(
      handleReject(
        mkCtx({ returnCase: { ...mkCtx().returnCase, customerEmailNorm: null } as never }),
        { action: "reject", rejectionReason: "ok" } as ReturnActionBody,
      ),
      "/app/returns/rc-1",
    );
    expect(sendRejectionNotificationMock).not.toHaveBeenCalled();
  });
});

describe("handleDeclineCancellation", () => {
  function ctxWithPendingCancel() {
    return mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        status: "approved",
        cancellationRequestedAt: new Date(),
        cancellationReason: "user changed mind",
      } as never,
    });
  }

  it("400 when status is not 'approved'", async () => {
    const res = await handleDeclineCancellation(mkCtx(), {
      action: "decline_cancellation",
    } as ReturnActionBody);
    expect(res.status).toBe(400);
  });

  it("400 when no cancellationRequestedAt set", async () => {
    const res = await handleDeclineCancellation(
      mkCtx({
        returnCase: {
          ...mkCtx().returnCase,
          status: "approved",
          cancellationRequestedAt: null,
        } as never,
      }),
      { action: "decline_cancellation" } as ReturnActionBody,
    );
    expect(res.status).toBe(400);
  });

  it("clears cancellationRequestedAt and writes declined event", async () => {
    await expectRedirect(
      handleDeclineCancellation(ctxWithPendingCancel(), {
        action: "decline_cancellation",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const update = prismaMock.returnCase.update.mock.calls[0][0];
    expect(update.data.cancellationRequestedAt).toBeNull();
    expect(update.data.cancellationDeclinedAt).toBeInstanceOf(Date);
    expect(update.data.cancellationDeclinedBy).toBe("admin@example.com");
    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: "cancellation_declined" }),
      }),
    );
  });

  it("dispatches notification when customer email present", async () => {
    await expectRedirect(
      handleDeclineCancellation(ctxWithPendingCancel(), {
        action: "decline_cancellation",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(sendCancellationDeclinedNotificationMock).toHaveBeenCalled();
  });
});

describe("handleCancelOrder", () => {
  function ctxWithOrder(overrides: Partial<ReturnHandlerContext["returnCase"]> = {}) {
    return mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        shopifyOrderId: "gid://shopify/Order/12345",
        ...overrides,
      } as never,
      admin: mkAdminGraphql() as never,
    });
  }

  it("400 on invalid cancel reason", async () => {
    const res = await handleCancelOrder(ctxWithOrder(), {
      action: "cancel_order",
      cancelReason: "BOGUS",
    } as never);
    expect(res.status).toBe(400);
  });

  it("400 when no Shopify order linked", async () => {
    const res = await handleCancelOrder(
      mkCtx({ returnCase: { ...mkCtx().returnCase, shopifyOrderId: null } as never }),
      { action: "cancel_order" } as ReturnActionBody,
    );
    expect(res.status).toBe(400);
  });

  it("400 when shopifyOrderId starts with 'manual:'", async () => {
    const res = await handleCancelOrder(
      mkCtx({ returnCase: { ...mkCtx().returnCase, shopifyOrderId: "manual:abc" } as never }),
      { action: "cancel_order" } as ReturnActionBody,
    );
    expect(res.status).toBe(400);
  });

  it("resolves numeric shopifyOrderId to GID", async () => {
    const adminMock = mkAdminGraphql();
    await expectRedirect(
      handleCancelOrder(
        mkCtx({
          returnCase: { ...mkCtx().returnCase, shopifyOrderId: "98765" } as never,
          admin: adminMock as never,
        }),
        { action: "cancel_order" } as ReturnActionBody,
      ),
      "/app/returns/rc-1",
    );
    expect(adminMock.graphql).toHaveBeenCalledWith(
      expect.stringContaining("orderCancel"),
      expect.objectContaining({
        variables: expect.objectContaining({ orderId: "gid://shopify/Order/98765" }),
      }),
    );
  });

  it("falls back to fetchOrderByOrderNumber when shopifyOrderId is non-numeric & non-GID", async () => {
    fetchOrderByOrderNumberMock.mockResolvedValueOnce({ id: "gid://shopify/Order/55555" });
    const adminMock = mkAdminGraphql();
    await expectRedirect(
      handleCancelOrder(
        mkCtx({
          returnCase: {
            ...mkCtx().returnCase,
            shopifyOrderId: "not-a-gid",
            shopifyOrderName: "#1001",
          } as never,
          admin: adminMock as never,
        }),
        { action: "cancel_order" } as ReturnActionBody,
      ),
      "/app/returns/rc-1",
    );
    expect(fetchOrderByOrderNumberMock).toHaveBeenCalledWith(expect.anything(), "1001");
  });

  it("400 when Shopify orderCancel returns userErrors", async () => {
    const adminMock = mkAdminGraphql([{ message: "order already cancelled" }]);
    const res = await handleCancelOrder(
      mkCtx({
        returnCase: { ...mkCtx().returnCase, shopifyOrderId: "gid://shopify/Order/1" } as never,
        admin: adminMock as never,
      }),
      { action: "cancel_order" } as ReturnActionBody,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("order already cancelled");
  });

  it("happy path: writes status=cancelled + event + redirect", async () => {
    await expectRedirect(
      handleCancelOrder(ctxWithOrder(), {
        action: "cancel_order",
        cancelReason: "CUSTOMER",
      } as never),
      "/app/returns/rc-1",
    );
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "cancelled" }),
      }),
    );
    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: "order_cancelled" }),
      }),
    );
  });

  it("500 on unexpected thrown error from Shopify graphql", async () => {
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, shopifyOrderId: "gid://shopify/Order/1" } as never,
      admin: {
        graphql: vi.fn(async () => {
          throw new Error("network down");
        }),
      } as never,
    });
    const res = await handleCancelOrder(ctx, { action: "cancel_order" } as ReturnActionBody);
    expect(res.status).toBe(500);
  });
});

describe("handleRefreshFyndDetails", () => {
  function ctxWithOrder(overrides: Partial<ReturnHandlerContext["returnCase"]> = {}) {
    return mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        shopifyOrderName: "#1001",
        shopifyOrderId: "gid://shopify/Order/1",
        ...overrides,
      } as never,
      shop: {
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { fyndApiType: "platform" },
      },
    });
  }

  it("redirects with fyndError when order has manual: prefix", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        shopifyOrderId: "manual:abc",
        shopifyOrderName: "",
      } as never,
    });
    await expectRedirect(
      handleRefreshFyndDetails(ctx, { action: "refresh_fynd_details" } as ReturnActionBody),
      "fyndError=",
    );
  });

  it("redirects with fyndError when no order number", async () => {
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, shopifyOrderName: "" } as never,
    });
    await expectRedirect(
      handleRefreshFyndDetails(ctx, { action: "refresh_fynd_details" } as ReturnActionBody),
      "fyndError=",
    );
  });

  it("redirects with fyndError when shop has no settings", async () => {
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, shopifyOrderName: "#1001" } as never,
      shop: { id: "shop-1", shopDomain: "store.myshopify.com", settings: null },
    });
    await expectRedirect(
      handleRefreshFyndDetails(ctx, { action: "refresh_fynd_details" } as ReturnActionBody),
      "fyndError=",
    );
  });

  it("redirects with fyndError when Fynd client construction fails", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: false, error: "no creds" });
    await expectRedirect(
      handleRefreshFyndDetails(ctxWithOrder(), {
        action: "refresh_fynd_details",
      } as ReturnActionBody),
      "fyndError=",
    );
  });

  it("redirects with fyndError when Fynd client lacks searchShipmentsByExternalOrderId (storefront)", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: true, client: {} });
    await expectRedirect(
      handleRefreshFyndDetails(ctxWithOrder(), {
        action: "refresh_fynd_details",
      } as ReturnActionBody),
      "fyndError=",
    );
  });

  it("redirects with fyndError when Fynd returns no shipments", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: vi.fn(async () => ({ items: [] })) },
    });
    await expectRedirect(
      handleRefreshFyndDetails(ctxWithOrder(), {
        action: "refresh_fynd_details",
      } as ReturnActionBody),
      "fyndError=",
    );
  });

  it("happy path: stores fyndPayloadJson on success and redirects with fyndRefresh=1", async () => {
    const search = vi.fn(async () => ({
      orderId: "FY-1",
      items: [{ shipment_id: "SH-1", journey_type: "forward" }],
    }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: search },
    });
    await expectRedirect(
      handleRefreshFyndDetails(ctxWithOrder(), {
        action: "refresh_fynd_details",
      } as ReturnActionBody),
      "fyndRefresh=1",
    );
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fyndOrderId: "FY-1" }),
      }),
    );
  });

  it("backfills returnLabelJson + returnAwb when a return shipment carries DP details", async () => {
    const search = vi.fn(async () => ({
      orderId: "FY-1",
      items: [
        {
          shipment_id: "RET-1",
          journey_type: "return",
          delivery_partner_details: { display_name: "BlueDart", awb_no: "BD123" },
        },
      ],
    }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: search },
    });
    await expectRedirect(
      handleRefreshFyndDetails(ctxWithOrder(), {
        action: "refresh_fynd_details",
      } as ReturnActionBody),
      "fyndRefresh=1",
    );
    const update = prismaMock.returnCase.update.mock.calls[0][0];
    const stored = JSON.parse(update.data.returnLabelJson as string);
    expect(stored.carrier).toBe("BlueDart");
    expect(stored.trackingNumber).toBe("BD123");
    expect(update.data.returnAwb).toBe("BD123");
  });
});

describe("handleEditDetails", () => {
  it("trims and stores per-field address values", async () => {
    await expectRedirect(
      handleEditDetails(mkCtx(), {
        action: "edit_details",
        customerAddress1: "  123 Main St  ",
        customerCity: "  Berlin  ",
        customerZip: "10115",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const data = prismaMock.returnCase.update.mock.calls[0][0].data;
    expect(data.customerAddress1).toBe("123 Main St");
    expect(data.customerCity).toBe("Berlin");
    expect(data.customerZip).toBe("10115");
  });

  it("converts empty strings to null", async () => {
    await expectRedirect(
      handleEditDetails(mkCtx(), {
        action: "edit_details",
        customerAddress1: "   ",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(prismaMock.returnCase.update.mock.calls[0][0].data.customerAddress1).toBeNull();
  });

  it("only updates fields explicitly present in the body", async () => {
    await expectRedirect(
      handleEditDetails(mkCtx(), {
        action: "edit_details",
        customerCity: "Paris",
      } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const data = prismaMock.returnCase.update.mock.calls[0][0].data;
    expect(Object.keys(data)).toEqual(["customerCity"]);
  });
});
