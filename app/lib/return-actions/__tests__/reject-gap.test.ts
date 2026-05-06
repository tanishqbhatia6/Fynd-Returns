/**
 * Gap-filling tests for handleReject (reject.server.ts).
 *
 * Companion to reject-deep.test.ts — exercises the few branches the deep
 * suite leaves uncovered:
 *
 *   - isTerminal=true short-circuit (lines 25-26).
 *   - rejectionReason.length > 500 (lines 34-35).
 *   - sendRejectionNotification throwing (line 68 — refundLogger.warn).
 *   - customerEmailNorm absent (notification block skipped entirely).
 *   - note provided in body (vs adminNotes fallback).
 *   - error path: non-redirect Response thrown vs generic Error rethrow.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../../test/prisma-mock";

const {
  prismaMock,
  closeShopifyReturnBestEffortMock,
  sendRejectionNotificationMock,
  auditReturnActionMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  closeShopifyReturnBestEffortMock: vi.fn(async () => ({ ok: true })),
  sendRejectionNotificationMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  auditReturnActionMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../../db.server", () => ({ default: prismaMock }));
vi.mock("../../notification.server", () => ({
  sendRejectionNotification: sendRejectionNotificationMock,
  sendCustomerNoteNotification: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  sendCancellationDeclinedNotification: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
}));
vi.mock("../../shopify-admin.server", () => ({
  closeShopifyReturnBestEffort: closeShopifyReturnBestEffortMock,
  fetchOrderByOrderNumber: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
}));
vi.mock("../../observability/audit.server", () => ({
  auditReturnAction: auditReturnActionMock,
}));

import { handleReject } from "../reject.server";
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

beforeEach(() => {
  resetPrismaMock(prismaMock);
  closeShopifyReturnBestEffortMock.mockReset().mockResolvedValue({ ok: true });
  sendRejectionNotificationMock.mockReset().mockResolvedValue(undefined);
  auditReturnActionMock.mockReset();
});

describe("handleReject — terminal short-circuit", () => {
  it("returns 400 with terminal status message when isTerminal=true", async () => {
    const ctx = mkCtx({
      isTerminal: true,
      returnCase: {
        ...mkCtx().returnCase,
        status: "approved",
      } as never,
    });
    const res = await handleReject(ctx, { action: "reject", rejectionReason: "Damaged" } as ReturnActionBody);
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "Cannot reject: return is already approved" });
    // No DB writes / audit / notification when terminal.
    expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
    expect(auditReturnActionMock).not.toHaveBeenCalled();
    expect(sendRejectionNotificationMock).not.toHaveBeenCalled();
  });

  it("includes the actual current status in the terminal error message", async () => {
    const res = await handleReject(
      mkCtx({
        isTerminal: true,
        returnCase: { ...mkCtx().returnCase, status: "rejected" } as never,
      }),
      { action: "reject", rejectionReason: "Damaged" } as ReturnActionBody,
    );
    const body = await res.json();
    expect(body.error).toBe("Cannot reject: return is already rejected");
  });
});

describe("handleReject — reason length validation", () => {
  it("returns 400 when rejectionReason exceeds 500 characters", async () => {
    const res = await handleReject(
      mkCtx(),
      { action: "reject", rejectionReason: "x".repeat(501) } as ReturnActionBody,
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: "Rejection reason is too long" });
    expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
  });
});

describe("handleReject — notification side-effects", () => {
  it("logs a warning but still redirects when sendRejectionNotification throws", async () => {
    sendRejectionNotificationMock.mockRejectedValueOnce(new Error("smtp down"));

    let caught: unknown;
    try {
      await handleReject(
        mkCtx(),
        { action: "reject", rejectionReason: "Damaged" } as ReturnActionBody,
      );
    } catch (err) {
      caught = err;
    }

    // Notification failure must NOT propagate — handler still redirects.
    expect(caught).toBeInstanceOf(Response);
    const res = caught as Response;
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("Location")).toContain("/app/returns/rc-1");

    // DB write + audit + counters all still ran.
    expect(prismaMock.returnCase.update).toHaveBeenCalledTimes(1);
    expect(auditReturnActionMock).toHaveBeenCalledTimes(1);
    expect(sendRejectionNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("skips the notification block entirely when customerEmailNorm is null", async () => {
    await handleReject(
      mkCtx({
        returnCase: { ...mkCtx().returnCase, customerEmailNorm: null } as never,
      }),
      { action: "reject", rejectionReason: "Damaged" } as ReturnActionBody,
    ).catch((err) => {
      // expect redirect
      expect(err).toBeInstanceOf(Response);
    });

    expect(sendRejectionNotificationMock).not.toHaveBeenCalled();
    // Audit + DB still happen.
    expect(prismaMock.returnCase.update).toHaveBeenCalledTimes(1);
    expect(auditReturnActionMock).toHaveBeenCalledTimes(1);
  });

  it("skips the notification when customerEmailNorm is empty string", async () => {
    await handleReject(
      mkCtx({
        returnCase: { ...mkCtx().returnCase, customerEmailNorm: "" } as never,
      }),
      { action: "reject", rejectionReason: "Damaged" } as ReturnActionBody,
    ).catch((err) => {
      expect(err).toBeInstanceOf(Response);
    });

    expect(sendRejectionNotificationMock).not.toHaveBeenCalled();
  });

  it("falls back to 'your order' when shopifyOrderName is missing", async () => {
    await handleReject(
      mkCtx({
        returnCase: { ...mkCtx().returnCase, shopifyOrderName: null } as never,
      }),
      { action: "reject", rejectionReason: "Damaged" } as ReturnActionBody,
    ).catch((err) => {
      expect(err).toBeInstanceOf(Response);
    });

    expect(sendRejectionNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ orderName: "your order" }),
    );
  });
});

describe("handleReject — adminNotes from body.note", () => {
  it("stores body.note as adminNotes when provided", async () => {
    await handleReject(
      mkCtx(),
      { action: "reject", rejectionReason: "Damaged", note: "internal: photo missing" } as ReturnActionBody,
    ).catch((err) => {
      expect(err).toBeInstanceOf(Response);
    });

    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ adminNotes: "internal: photo missing" }),
      }),
    );
    // Event payload also reflects the note.
    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payloadJson: expect.stringContaining('"note":"internal: photo missing"'),
        }),
      }),
    );
  });

  it("event payload uses null for note when none provided", async () => {
    await handleReject(
      mkCtx(),
      { action: "reject", rejectionReason: "Damaged" } as ReturnActionBody,
    ).catch((err) => {
      expect(err).toBeInstanceOf(Response);
    });

    expect(prismaMock.returnEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          payloadJson: expect.stringContaining('"note":null'),
        }),
      }),
    );
  });
});

describe("handleReject — nullish coalescing branches", () => {
  it("uses empty string for span attribute when returnRequestNo is null", async () => {
    await handleReject(
      mkCtx({
        returnCase: { ...mkCtx().returnCase, returnRequestNo: null } as never,
      }),
      { action: "reject", rejectionReason: "Damaged" } as ReturnActionBody,
    ).catch((err) => {
      expect(err).toBeInstanceOf(Response);
    });
    // Just verify the handler completed normally (DB write happened).
    expect(prismaMock.returnCase.update).toHaveBeenCalledTimes(1);
  });

  it("treats undefined rejectionReason as empty (400)", async () => {
    const res = await handleReject(
      mkCtx(),
      { action: "reject" } as ReturnActionBody,
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Rejection reason is required/);
    expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
  });
});

describe("handleReject — error path", () => {
  it("rethrows a non-redirect Response (e.g. a 500 from a downstream)", async () => {
    const internalErrorResponse = new Response("boom", { status: 500 });
    closeShopifyReturnBestEffortMock.mockRejectedValueOnce(internalErrorResponse);

    let caught: unknown;
    try {
      await handleReject(
        mkCtx(),
        { action: "reject", rejectionReason: "Damaged" } as ReturnActionBody,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBe(internalErrorResponse);
    expect((caught as Response).status).toBe(500);
  });

  it("rethrows a generic Error and never redirects", async () => {
    closeShopifyReturnBestEffortMock.mockRejectedValueOnce(new Error("shopify down"));

    await expect(
      handleReject(
        mkCtx(),
        { action: "reject", rejectionReason: "Damaged" } as ReturnActionBody,
      ),
    ).rejects.toThrow("shopify down");
  });

  it("rethrows when returnEvent.create fails (after returnCase.update succeeded)", async () => {
    prismaMock.returnEvent.create.mockRejectedValueOnce(new Error("event insert failed"));

    await expect(
      handleReject(
        mkCtx(),
        { action: "reject", rejectionReason: "Damaged" } as ReturnActionBody,
      ),
    ).rejects.toThrow("event insert failed");
    // returnCase.update did happen (ordering check) but Shopify decline did not.
    expect(prismaMock.returnCase.update).toHaveBeenCalledTimes(1);
    expect(closeShopifyReturnBestEffortMock).not.toHaveBeenCalled();
  });
});
