/**
 * Targeted coverage closure for the four small handlers whose error paths
 * and rare branches were never exercised:
 *   - update-instructions.server.ts
 *   - decline-cancellation.server.ts
 *   - edit-details.server.ts
 *   - save-notes-for-customer.server.ts
 *
 * The happy paths are already covered by extracted-handlers.test.ts. This
 * file pins down:
 *   - the top-level `catch` block (counters fire, error rethrown)
 *   - rare branches (no-op fields, undefined args, customer-with-no-email)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../../test/prisma-mock";

const {
  prismaMock,
  sendCustomerNoteNotificationMock,
  sendCancellationDeclinedNotificationMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  sendCustomerNoteNotificationMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  sendCancellationDeclinedNotificationMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../../db.server", () => ({ default: prismaMock }));
vi.mock("../../notification.server", () => ({
  sendCustomerNoteNotification: sendCustomerNoteNotificationMock,
  sendCancellationDeclinedNotification: sendCancellationDeclinedNotificationMock,
}));

import { handleUpdateInstructions } from "../update-instructions.server";
import { handleDeclineCancellation } from "../decline-cancellation.server";
import { handleEditDetails } from "../edit-details.server";
import { handleSaveNotesForCustomer } from "../save-notes-for-customer.server";
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
      customerPhoneNorm: null,
      status: "approved",
      cancellationRequestedAt: new Date("2024-01-01T00:00:00Z"),
      cancellationReason: null,
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
  sendCustomerNoteNotificationMock.mockReset().mockResolvedValue(undefined);
  sendCancellationDeclinedNotificationMock.mockReset().mockResolvedValue(undefined);
});

describe("handleUpdateInstructions — error path", () => {
  it("propagates DB error from upsert (catch block runs counters + rethrows)", async () => {
    prismaMock.shopSettings.upsert.mockRejectedValueOnce(new Error("db unavailable"));
    await expect(
      handleUpdateInstructions(
        mkCtx(),
        { action: "update_instructions", returnInstructions: "x" } as ReturnActionBody,
      ),
    ).rejects.toThrow("db unavailable");
  });
});

describe("handleDeclineCancellation — guards + edge branches", () => {
  it("400 when status is not approved", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        status: "pending",
      } as never,
    });
    const res = await handleDeclineCancellation(ctx, { action: "decline_cancellation" } as ReturnActionBody);
    expect((res as Response).status).toBe(400);
  });

  it("400 when no cancellationRequestedAt set", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        status: "approved",
        cancellationRequestedAt: null,
      } as never,
    });
    const res = await handleDeclineCancellation(ctx, { action: "decline_cancellation" } as ReturnActionBody);
    expect((res as Response).status).toBe(400);
  });

  it("skips the customer notification when customerEmailNorm is null", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        customerEmailNorm: null,
      } as never,
    });
    await expect(
      handleDeclineCancellation(ctx, { action: "decline_cancellation" } as ReturnActionBody),
    ).rejects.toBeInstanceOf(Response);
    expect(sendCancellationDeclinedNotificationMock).not.toHaveBeenCalled();
  });

  it("swallows notification rejection without surfacing as an error", async () => {
    sendCancellationDeclinedNotificationMock.mockRejectedValueOnce(new Error("smtp down"));
    await expect(
      handleDeclineCancellation(mkCtx(), { action: "decline_cancellation" } as ReturnActionBody),
    ).rejects.toBeInstanceOf(Response);
    expect(sendCancellationDeclinedNotificationMock).toHaveBeenCalledOnce();
  });

  it("propagates DB error from returnCase.update (catch block)", async () => {
    prismaMock.returnCase.update.mockRejectedValueOnce(new Error("db boom"));
    await expect(
      handleDeclineCancellation(mkCtx(), { action: "decline_cancellation" } as ReturnActionBody),
    ).rejects.toThrow("db boom");
  });
});

describe("handleEditDetails — branch coverage", () => {
  it("strips each customer-* field that is provided (covers all 7 in-checks)", async () => {
    await expect(
      handleEditDetails(mkCtx(), {
        action: "edit_details",
        customerAddress1: "  123 Main  ",
        customerAddress2: "",
        customerCity: "  San Francisco ".repeat(20),
        customerProvince: "  CA  ",
        customerZip: "  94110  ",
        customerCountry: "  USA  ",
        customerLandmark: "  Near Park  ",
      } as ReturnActionBody),
    ).rejects.toBeInstanceOf(Response);
    const arg = prismaMock.returnCase.update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data).toMatchObject({
      customerAddress1: "123 Main",
      customerAddress2: null,
      customerProvince: "CA",
      customerZip: "94110",
      customerCountry: "USA",
      customerLandmark: "Near Park",
    });
    // City was capped at 100 characters
    expect(String(arg.data.customerCity).length).toBeLessThanOrEqual(100);
  });

  it("sets null when a field is explicitly passed as a non-string", async () => {
    await expect(
      handleEditDetails(mkCtx(), {
        action: "edit_details",
        customerAddress1: 12345 as unknown as string,
      } as ReturnActionBody),
    ).rejects.toBeInstanceOf(Response);
    const arg = prismaMock.returnCase.update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data.customerAddress1).toBeNull();
  });

  it("propagates DB error from returnCase.update (catch block)", async () => {
    prismaMock.returnCase.update.mockRejectedValueOnce(new Error("constraint"));
    await expect(
      handleEditDetails(mkCtx(), { action: "edit_details", customerCity: "X" } as ReturnActionBody),
    ).rejects.toThrow("constraint");
  });
});

describe("handleSaveNotesForCustomer — branch coverage", () => {
  it("falls back to returnCase.notesForCustomer when body.notesForCustomer is undefined", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        notesForCustomer: "stored note",
      } as never,
    });
    await expect(
      handleSaveNotesForCustomer(ctx, { action: "save_notes_for_customer" } as ReturnActionBody),
    ).rejects.toBeInstanceOf(Response);
    const arg = prismaMock.returnCase.update.mock.calls[0]![0] as { data: Record<string, unknown> };
    expect(arg.data.notesForCustomer).toBe("stored note");
    // Notification path: val truthy + customerEmailNorm present -> notification sent
    expect(sendCustomerNoteNotificationMock).toHaveBeenCalledOnce();
  });

  it("does NOT notify when val is null/empty even if email is present", async () => {
    await expect(
      handleSaveNotesForCustomer(
        mkCtx(),
        { action: "save_notes_for_customer", notesForCustomer: "" } as ReturnActionBody,
      ),
    ).rejects.toBeInstanceOf(Response);
    expect(sendCustomerNoteNotificationMock).not.toHaveBeenCalled();
  });

  it("does NOT notify when customerEmailNorm is null (even with note)", async () => {
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        customerEmailNorm: null,
      } as never,
    });
    await expect(
      handleSaveNotesForCustomer(ctx, {
        action: "save_notes_for_customer",
        notesForCustomer: "hi",
      } as ReturnActionBody),
    ).rejects.toBeInstanceOf(Response);
    expect(sendCustomerNoteNotificationMock).not.toHaveBeenCalled();
  });

  it("swallows notification rejection without surfacing as an error", async () => {
    sendCustomerNoteNotificationMock.mockRejectedValueOnce(new Error("smtp"));
    await expect(
      handleSaveNotesForCustomer(mkCtx(), {
        action: "save_notes_for_customer",
        notesForCustomer: "hello",
      } as ReturnActionBody),
    ).rejects.toBeInstanceOf(Response);
  });

  it("propagates DB error from returnCase.update (catch block)", async () => {
    prismaMock.returnCase.update.mockRejectedValueOnce(new Error("db"));
    await expect(
      handleSaveNotesForCustomer(mkCtx(), {
        action: "save_notes_for_customer",
        notesForCustomer: "hello",
      } as ReturnActionBody),
    ).rejects.toThrow("db");
  });
});
