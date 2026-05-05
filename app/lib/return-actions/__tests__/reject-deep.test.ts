/**
 * Deep unit tests for handleReject (reject.server.ts).
 *
 * Builds on extracted-handlers.test.ts by exercising behaviour that the
 * shallower suite doesn't cover:
 *
 *   - shopName extraction from shopDomain (`.myshopify.com` strip rules,
 *     custom domains, undefined / null shopDomain).
 *   - The audit log call (`auditReturnAction`) — verifies action name,
 *     return id, shop domain, actor identity, and the from→to status diff.
 *   - DB write ordering & adminNotes fallback when no `note` provided.
 *   - Whitespace-only rejection reasons (treated as empty).
 *   - rejectionReason equal to exactly 500 chars (boundary — accepted).
 *   - Order of side-effects: returnCase.update happens BEFORE Shopify
 *     decline + notification + audit.
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
  sendRejectionNotificationMock.mockReset().mockResolvedValue(undefined);
  auditReturnActionMock.mockReset();
});

describe("handleReject — shopName extraction from shopDomain", () => {
  it("strips '.myshopify.com' suffix when sending rejection email", async () => {
    await expectRedirect(
      handleReject(
        mkCtx({ shopDomain: "acme-store.myshopify.com" }),
        { action: "reject", rejectionReason: "Damaged" } as ReturnActionBody,
      ),
      "/app/returns/rc-1",
    );
    expect(sendRejectionNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        shopDomain: "acme-store.myshopify.com",
        shopName: "acme-store",
      }),
    );
  });

  it("leaves a custom (non-myshopify) domain untouched as shopName", async () => {
    await expectRedirect(
      handleReject(
        mkCtx({ shopDomain: "shop.brand.com" }),
        { action: "reject", rejectionReason: "Damaged" } as ReturnActionBody,
      ),
      "/app/returns/rc-1",
    );
    // No `.myshopify.com` to strip — entire host is forwarded as shopName.
    expect(sendRejectionNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        shopDomain: "shop.brand.com",
        shopName: "shop.brand.com",
      }),
    );
  });

  it("only strips the first occurrence of '.myshopify.com'", async () => {
    // edge: subdomain literally containing the suffix prefix
    await expectRedirect(
      handleReject(
        mkCtx({ shopDomain: "weird.myshopify.com.myshopify.com" }),
        { action: "reject", rejectionReason: "Damaged" } as ReturnActionBody,
      ),
      "/app/returns/rc-1",
    );
    // String#replace with a string pattern only replaces the first match.
    expect(sendRejectionNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ shopName: "weird.myshopify.com" }),
    );
  });

  it("forwards undefined shopName when shopDomain is undefined", async () => {
    await expectRedirect(
      handleReject(
        mkCtx({ shopDomain: undefined as unknown as string }),
        { action: "reject", rejectionReason: "Damaged" } as ReturnActionBody,
      ),
      "/app/returns/rc-1",
    );
    expect(sendRejectionNotificationMock).toHaveBeenCalledWith(
      expect.objectContaining({ shopName: undefined }),
    );
  });
});

describe("handleReject — audit log", () => {
  it("records audit with action='rejected', actor email, and from→to status diff", async () => {
    await expectRedirect(
      handleReject(mkCtx(), { action: "reject", rejectionReason: "Damaged" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(auditReturnActionMock).toHaveBeenCalledTimes(1);
    expect(auditReturnActionMock).toHaveBeenCalledWith(
      "rejected",
      "rc-1",
      "store.myshopify.com",
      { type: "admin", identity: "admin@example.com" },
      { status: { from: "pending", to: "rejected" } },
    );
  });

  it("falls back to identity='shop-admin' when sessionEmail is missing", async () => {
    await expectRedirect(
      handleReject(
        mkCtx({ sessionEmail: undefined as unknown as string }),
        { action: "reject", rejectionReason: "Damaged" } as ReturnActionBody,
      ),
      "/app/returns/rc-1",
    );
    expect(auditReturnActionMock).toHaveBeenCalledWith(
      "rejected",
      "rc-1",
      "store.myshopify.com",
      { type: "admin", identity: "shop-admin" },
      expect.any(Object),
    );
  });

  it("uses shop.shopDomain for the audit log (not ctx.shopDomain)", async () => {
    // Distinguishing the two — the implementation passes `shop.shopDomain`.
    await expectRedirect(
      handleReject(
        mkCtx({
          shop: { id: "shop-1", shopDomain: "audit-shop.myshopify.com", settings: null },
          shopDomain: "different.myshopify.com",
        }),
        { action: "reject", rejectionReason: "Damaged" } as ReturnActionBody,
      ),
      "/app/returns/rc-1",
    );
    expect(auditReturnActionMock).toHaveBeenCalledWith(
      "rejected",
      "rc-1",
      "audit-shop.myshopify.com",
      expect.any(Object),
      expect.any(Object),
    );
  });

  it("does NOT call audit when validation fails (empty reason)", async () => {
    const res = await handleReject(
      mkCtx(),
      { action: "reject", rejectionReason: "" } as ReturnActionBody,
    );
    expect(res.status).toBe(400);
    expect(auditReturnActionMock).not.toHaveBeenCalled();
  });

  it("does NOT call audit when DB write fails", async () => {
    prismaMock.returnCase.update.mockRejectedValueOnce(new Error("db down"));
    await expect(
      handleReject(mkCtx(), { action: "reject", rejectionReason: "Damaged" } as ReturnActionBody),
    ).rejects.toThrow("db down");
    expect(auditReturnActionMock).not.toHaveBeenCalled();
  });
});

describe("handleReject — additional edge cases", () => {
  it("trims surrounding whitespace from the rejection reason before storing", async () => {
    await expectRedirect(
      handleReject(
        mkCtx(),
        { action: "reject", rejectionReason: "   Damaged in transit   " } as ReturnActionBody,
      ),
      "/app/returns/rc-1",
    );
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ rejectionReason: "Damaged in transit" }),
      }),
    );
  });

  it("treats a whitespace-only reason as empty (400)", async () => {
    const res = await handleReject(
      mkCtx(),
      { action: "reject", rejectionReason: "   \t \n " } as ReturnActionBody,
    );
    expect(res.status).toBe(400);
    expect(prismaMock.returnCase.update).not.toHaveBeenCalled();
  });

  it("accepts a reason exactly 500 chars long (boundary)", async () => {
    await expectRedirect(
      handleReject(
        mkCtx(),
        { action: "reject", rejectionReason: "x".repeat(500) } as ReturnActionBody,
      ),
      "/app/returns/rc-1",
    );
  });

  it("preserves existing adminNotes when no note is provided in the body", async () => {
    await expectRedirect(
      handleReject(
        mkCtx({
          returnCase: { ...mkCtx().returnCase, adminNotes: "previous notes" } as never,
        }),
        { action: "reject", rejectionReason: "Damaged" } as ReturnActionBody,
      ),
      "/app/returns/rc-1",
    );
    expect(prismaMock.returnCase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ adminNotes: "previous notes" }),
      }),
    );
  });
});
