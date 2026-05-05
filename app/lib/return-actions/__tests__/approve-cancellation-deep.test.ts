/**
 * Deep unit tests for handleApproveCancellation.
 *
 * The handler has subtle invariants that the broader extracted-handlers.test.ts
 * does not cover:
 *
 *   1. closeShopifyReturnBestEffort failing must short-circuit with 502, must
 *      NOT flip local status to "cancelled", and must log a
 *      "cancellation_blocked_by_shopify" event so admins can retry.
 *   2. Fynd updateShipmentStatus is best-effort: a thrown error must NOT abort
 *      the action, must log a "fynd_cancel_failed" event, and the status flip
 *      to cancelled must already be persisted.
 *   3. Customer notification is fire-and-forget: a rejection from
 *      sendCancellationNotification must not surface to the caller.
 *   4. dispatchWebhookEvent must be called with the correct payload after
 *      success.
 *
 * These tests replicate the mock pattern in extracted-handlers.test.ts so they
 * can run side-by-side without affecting global module state.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../../test/prisma-mock";

const {
  prismaMock,
  closeShopifyReturnBestEffortMock,
  createFyndClientOrErrorMock,
  sendCancellationNotificationMock,
  dispatchWebhookEventMock,
  auditReturnActionMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  closeShopifyReturnBestEffortMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: true })),
  createFyndClientOrErrorMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({ ok: false, error: "disabled" })),
  sendCancellationNotificationMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => undefined),
  dispatchWebhookEventMock: vi.fn(),
  auditReturnActionMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify-admin.server", () => ({
  closeShopifyReturnBestEffort: closeShopifyReturnBestEffortMock,
}));
vi.mock("../../fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
}));
vi.mock("../../notification.server", () => ({
  sendCancellationNotification: sendCancellationNotificationMock,
}));
vi.mock("../../webhook-dispatch.server", () => ({
  dispatchWebhookEvent: dispatchWebhookEventMock,
}));
vi.mock("../../observability/audit.server", () => ({
  auditReturnAction: auditReturnActionMock,
}));

import { handleApproveCancellation } from "../approve-cancellation.server";
import type { ReturnHandlerContext, ReturnActionBody } from "../types";

const APPROVE_BODY: ReturnActionBody = { action: "approve_cancellation" };

function mkCtx(overrides: Partial<ReturnHandlerContext> = {}): ReturnHandlerContext {
  return {
    id: "rc-1",
    returnCase: {
      id: "rc-1",
      status: "approved",
      cancellationRequestedAt: new Date("2026-01-01T00:00:00Z"),
      cancellationReason: "user changed mind",
      returnRequestNo: "RQ-1",
      shopifyOrderName: "#1001",
      customerEmailNorm: "user@example.com",
      customerPhoneNorm: "+15555550101",
      fyndReturnId: null,
      fyndShipmentId: null,
      fyndOrderId: null,
      fyndSyncStatus: null,
      items: [],
    } as never,
    shop: {
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndApiType: "platform" },
    },
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
  closeShopifyReturnBestEffortMock.mockReset().mockResolvedValue({ ok: true });
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({ ok: false, error: "disabled" });
  sendCancellationNotificationMock.mockReset().mockResolvedValue(undefined);
  dispatchWebhookEventMock.mockReset();
  auditReturnActionMock.mockReset();
});

describe("handleApproveCancellation: pre-conditions", () => {
  it("returns 400 when status is not 'approved'", async () => {
    const res = await handleApproveCancellation(
      mkCtx({ returnCase: { ...mkCtx().returnCase, status: "pending" } as never }),
      APPROVE_BODY,
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("No pending cancellation");
    expect(closeShopifyReturnBestEffortMock).not.toHaveBeenCalled();
  });

  it("returns 400 when cancellationRequestedAt is null", async () => {
    const res = await handleApproveCancellation(
      mkCtx({ returnCase: { ...mkCtx().returnCase, cancellationRequestedAt: null } as never }),
      APPROVE_BODY,
    );
    expect(res.status).toBe(400);
    expect(closeShopifyReturnBestEffortMock).not.toHaveBeenCalled();
  });
});

describe("handleApproveCancellation: closeShopifyReturn failure", () => {
  it("returns 502 with the canonical retry message when close fails", async () => {
    closeShopifyReturnBestEffortMock.mockResolvedValueOnce({ ok: false, error: "shopify down" });
    const res = await handleApproveCancellation(mkCtx(), APPROVE_BODY);
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toContain("Could not close the Shopify return");
    expect(body.error).toContain("retry");
  });

  it("does NOT flip local status when close fails (admin retries are safe)", async () => {
    closeShopifyReturnBestEffortMock.mockResolvedValueOnce({ ok: false, error: "fail" });
    await handleApproveCancellation(mkCtx(), APPROVE_BODY);
    expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
  });

  it("logs a 'cancellation_blocked_by_shopify' event with the close error", async () => {
    closeShopifyReturnBestEffortMock.mockResolvedValueOnce({ ok: false, error: "boom" });
    await handleApproveCancellation(mkCtx(), APPROVE_BODY);
    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          returnCaseId: "rc-1",
          source: "admin",
          eventType: "cancellation_blocked_by_shopify",
        }),
      }),
    );
    const call = prismaMock.returnEvent.create.mock.calls.find(
      (c: unknown[]) => (c[0] as { data: { eventType: string } }).data.eventType === "cancellation_blocked_by_shopify",
    );
    expect(call).toBeTruthy();
    const payload = JSON.parse((call![0] as { data: { payloadJson: string } }).data.payloadJson);
    expect(payload.error).toBe("boom");
    expect(payload.adminEmail).toBe("admin@example.com");
  });

  it("does not dispatch webhook or notification on close failure", async () => {
    closeShopifyReturnBestEffortMock.mockResolvedValueOnce({ ok: false, error: "x" });
    await handleApproveCancellation(mkCtx(), APPROVE_BODY);
    expect(dispatchWebhookEventMock).not.toHaveBeenCalled();
    expect(sendCancellationNotificationMock).not.toHaveBeenCalled();
  });

  it("does not abort if blocked-event create itself rejects", async () => {
    closeShopifyReturnBestEffortMock.mockResolvedValueOnce({ ok: false, error: "x" });
    prismaMock.returnEvent.create.mockRejectedValueOnce(new Error("db blip"));
    const res = await handleApproveCancellation(mkCtx(), APPROVE_BODY);
    // .catch(() => {}) on the create swallows the error; outer handler still
    // returns the 502 to the admin.
    expect(res.status).toBe(502);
  });
});

describe("handleApproveCancellation: happy path", () => {
  it("flips status to 'cancelled' and writes 'cancellation_approved' event", async () => {
    await expectRedirect(
      handleApproveCancellation(mkCtx(), APPROVE_BODY),
      "/app/returns/rc-1",
    );
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith({
      where: { id: "rc-1" },
      data: { status: "cancelled" },
    });
    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          eventType: "cancellation_approved",
          source: "admin",
        }),
      }),
    );
  });

  it("dispatches the 'return.cancelled' webhook with the expected payload", async () => {
    await expectRedirect(
      handleApproveCancellation(mkCtx(), APPROVE_BODY),
      "/app/returns/rc-1",
    );
    expect(dispatchWebhookEventMock).toHaveBeenCalledWith(
      "shop-1",
      "return.cancelled",
      expect.objectContaining({
        returnCaseId: "rc-1",
        returnRequestNo: "RQ-1",
        shopifyOrderName: "#1001",
        previousStatus: "approved",
        cancelledBy: "admin_approved_customer_request",
        reason: "user changed mind",
      }),
    );
  });

  it("audits the action with from/to status transition", async () => {
    await expectRedirect(
      handleApproveCancellation(mkCtx(), APPROVE_BODY),
      "/app/returns/rc-1",
    );
    expect(auditReturnActionMock).toHaveBeenCalledWith(
      "cancellation_approved",
      "rc-1",
      "store.myshopify.com",
      expect.objectContaining({ type: "admin", identity: "admin@example.com" }),
      expect.objectContaining({ status: { from: "approved", to: "cancelled" } }),
    );
  });
});

describe("handleApproveCancellation: customer notification (fire-and-forget)", () => {
  it("invokes sendCancellationNotification when customer email present", async () => {
    await expectRedirect(
      handleApproveCancellation(mkCtx(), APPROVE_BODY),
      "/app/returns/rc-1",
    );
    expect(sendCancellationNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        shopDomain: "store.myshopify.com",
        to: "user@example.com",
        orderName: "#1001",
        returnId: "RQ-1",
        customerPhone: "+15555550101",
      }),
    );
  });

  it("does NOT invoke notification when customerEmailNorm is missing", async () => {
    await expectRedirect(
      handleApproveCancellation(
        mkCtx({ returnCase: { ...mkCtx().returnCase, customerEmailNorm: null } as never }),
        APPROVE_BODY,
      ),
      "/app/returns/rc-1",
    );
    expect(sendCancellationNotificationMock).not.toHaveBeenCalled();
  });

  it("notification rejection does not abort the redirect (fire-and-forget)", async () => {
    sendCancellationNotificationMock.mockRejectedValueOnce(new Error("smtp boom"));
    await expectRedirect(
      handleApproveCancellation(mkCtx(), APPROVE_BODY),
      "/app/returns/rc-1",
    );
    // status flip + webhook still happened
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith({
      where: { id: "rc-1" },
      data: { status: "cancelled" },
    });
    expect(dispatchWebhookEventMock).toHaveBeenCalled();
  });
});

describe("handleApproveCancellation: Fynd best-effort cancel", () => {
  function ctxWithFynd(overrides: Partial<ReturnHandlerContext["returnCase"]> = {}) {
    return mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndReturnId: "FY-RET-1",
        fyndShipmentId: "FY-SH-1",
        fyndOrderId: "FY-ORD-1",
        ...overrides,
      } as never,
    });
  }

  it("skips Fynd entirely when no shipment id (and no synced flag)", async () => {
    await expectRedirect(
      handleApproveCancellation(mkCtx(), APPROVE_BODY),
      "/app/returns/rc-1",
    );
    expect(createFyndClientOrErrorMock).not.toHaveBeenCalled();
  });

  it("skips Fynd when shipment id present but neither return id nor synced flag", async () => {
    await expectRedirect(
      handleApproveCancellation(
        mkCtx({
          returnCase: {
            ...mkCtx().returnCase,
            fyndShipmentId: "SH-only",
            fyndReturnId: null,
            fyndSyncStatus: null,
          } as never,
        }),
        APPROVE_BODY,
      ),
      "/app/returns/rc-1",
    );
    expect(createFyndClientOrErrorMock).not.toHaveBeenCalled();
  });

  it("invokes updateShipmentStatus with return_request_cancelled payload on success", async () => {
    const updateShipmentStatus = vi.fn(async () => ({ ok: true }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus },
    });
    await expectRedirect(
      handleApproveCancellation(ctxWithFynd(), APPROVE_BODY),
      "/app/returns/rc-1",
    );
    expect(updateShipmentStatus).toHaveBeenCalledWith(
      "FY-ORD-1", // callId prefers orderId when present
      expect.objectContaining({
        statuses: [
          expect.objectContaining({
            shipments: [{ identifier: "FY-SH-1" }],
            status: "return_request_cancelled",
          }),
        ],
        task: false,
        force_transition: false,
      }),
    );
  });

  it("falls back to shipmentId for callId when fyndOrderId is null", async () => {
    const updateShipmentStatus = vi.fn(async () => ({ ok: true }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus },
    });
    await expectRedirect(
      handleApproveCancellation(
        ctxWithFynd({ fyndOrderId: null }),
        APPROVE_BODY,
      ),
      "/app/returns/rc-1",
    );
    expect(updateShipmentStatus).toHaveBeenCalledWith("FY-SH-1", expect.anything());
  });

  it("uses synced status (without fyndReturnId) to trigger Fynd cancel", async () => {
    const updateShipmentStatus = vi.fn(async () => ({ ok: true }));
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus },
    });
    await expectRedirect(
      handleApproveCancellation(
        mkCtx({
          returnCase: {
            ...mkCtx().returnCase,
            fyndReturnId: null,
            fyndSyncStatus: "synced",
            fyndShipmentId: "FY-SH-9",
            fyndOrderId: "FY-ORD-9",
          } as never,
        }),
        APPROVE_BODY,
      ),
      "/app/returns/rc-1",
    );
    expect(updateShipmentStatus).toHaveBeenCalledTimes(1);
  });

  it("Fynd thrown error is best-effort: redirect still happens, status still flipped", async () => {
    const updateShipmentStatus = vi.fn(async () => { throw new Error("fynd 500"); });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus },
    });
    await expectRedirect(
      handleApproveCancellation(ctxWithFynd(), APPROVE_BODY),
      "/app/returns/rc-1",
    );
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith({
      where: { id: "rc-1" },
      data: { status: "cancelled" },
    });
    // dispatch + audit still ran after the swallowed error
    expect(dispatchWebhookEventMock).toHaveBeenCalled();
    expect(auditReturnActionMock).toHaveBeenCalled();
  });

  it("logs a 'fynd_cancel_failed' event with the error message and shipmentId", async () => {
    const updateShipmentStatus = vi.fn(async () => { throw new Error("fynd 500"); });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus },
    });
    await expectRedirect(
      handleApproveCancellation(ctxWithFynd(), APPROVE_BODY),
      "/app/returns/rc-1",
    );
    const failedEvent = prismaMock.returnEvent.create.mock.calls.find(
      (c: unknown[]) => (c[0] as { data: { eventType: string } }).data.eventType === "fynd_cancel_failed",
    );
    expect(failedEvent).toBeTruthy();
    const payload = JSON.parse((failedEvent![0] as { data: { payloadJson: string } }).data.payloadJson);
    expect(payload.error).toContain("fynd 500");
    expect(payload.shipmentId).toBe("FY-SH-1");
  });

  it("client without updateShipmentStatus method is a no-op (storefront client)", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { searchShipmentsByExternalOrderId: vi.fn() },
    });
    await expectRedirect(
      handleApproveCancellation(ctxWithFynd(), APPROVE_BODY),
      "/app/returns/rc-1",
    );
    // No fynd_cancel_failed event written (no error path entered)
    const failed = prismaMock.returnEvent.create.mock.calls.find(
      (c: unknown[]) => (c[0] as { data: { eventType: string } }).data.eventType === "fynd_cancel_failed",
    );
    expect(failed).toBeFalsy();
  });

  it("createFyndClientOrError ok=false skips updateShipmentStatus silently", async () => {
    createFyndClientOrErrorMock.mockResolvedValueOnce({ ok: false, error: "no creds" });
    await expectRedirect(
      handleApproveCancellation(ctxWithFynd(), APPROVE_BODY),
      "/app/returns/rc-1",
    );
    // Still flips status and dispatches webhook
    expect(dispatchWebhookEventMock).toHaveBeenCalled();
    const failed = prismaMock.returnEvent.create.mock.calls.find(
      (c: unknown[]) => (c[0] as { data: { eventType: string } }).data.eventType === "fynd_cancel_failed",
    );
    expect(failed).toBeFalsy();
  });

  it("skips Fynd block entirely when shop.settings is null", async () => {
    await expectRedirect(
      handleApproveCancellation(
        mkCtx({
          returnCase: {
            ...mkCtx().returnCase,
            fyndReturnId: "FY-1",
            fyndShipmentId: "FY-SH-1",
          } as never,
          shop: { id: "shop-1", shopDomain: "store.myshopify.com", settings: null },
        }),
        APPROVE_BODY,
      ),
      "/app/returns/rc-1",
    );
    expect(createFyndClientOrErrorMock).not.toHaveBeenCalled();
  });
});

describe("handleApproveCancellation: error handling", () => {
  it("returns 500 when post-close DB update unexpectedly throws", async () => {
    prismaMock.returnCase.update.mockRejectedValueOnce(new Error("db down"));
    const res = await handleApproveCancellation(mkCtx(), APPROVE_BODY);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBeTruthy();
  });
});
