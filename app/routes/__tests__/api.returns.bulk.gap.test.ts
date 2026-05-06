/**
 * Coverage gap: `app/routes/api.returns.bulk.ts` lines 237-238.
 *
 * The catch block inside the `bulk_reject` per-row loop logs and pushes a
 * failure result when `prisma.returnCase.update` throws. The existing
 * suites cover happy / terminal / notification paths, but never let the
 * underlying status-flip throw — that's the gap this file closes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateMock, sendApprovalMock, sendRejectionMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  sendApprovalMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
  sendRejectionMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../lib/notification.server", () => ({
  sendApprovalNotification: sendApprovalMock,
  sendRejectionNotification: sendRejectionMock,
}));

import { action } from "../api.returns.bulk";

function mkJsonReq(body: unknown, method = "POST") {
  const init: RequestInit = { method };
  if (method !== "GET" && method !== "HEAD") {
    init.headers = { "Content-Type": "application/json" };
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request("https://app.example/api/returns/bulk", init);
}

function call(body: unknown) {
  return action({ request: mkJsonReq(body), params: {}, context: {} } as never);
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  sendApprovalMock.mockReset().mockResolvedValue(undefined);
  sendRejectionMock.mockReset().mockResolvedValue(undefined);
  prismaMock.shop.findUnique.mockResolvedValue({ id: "shop-1" });
});

describe("bulk_reject — per-row update failure (lines 237-238)", () => {
  it("captures Error.message in results when prisma.returnCase.update throws", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-throw", status: "pending", customerEmailNorm: null, shopifyOrderName: "#1" },
    ]);
    prismaMock.returnCase.update.mockRejectedValueOnce(new Error("update-blew-up"));

    const res = await call({
      action: "bulk_reject",
      returnIds: ["rc-throw"],
      rejectionReason: "fraud",
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.successCount).toBe(0);
    expect(body.errorCount).toBe(1);
    expect(body.results).toEqual([
      { id: "rc-throw", success: false, error: "update-blew-up" },
    ]);
    // No event row should be persisted when the status-flip itself failed.
    expect(prismaMock.returnEvent.create).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("[BulkReject] Failed for rc-throw:"),
      expect.any(Error),
    );
    errSpy.mockRestore();
  });

  it("falls back to 'Unknown error' when the thrown value is not an Error instance", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-string-throw", status: "pending", customerEmailNorm: null, shopifyOrderName: "#1" },
    ]);
    // Non-Error rejection — the route's `err instanceof Error` branch flips false.
    prismaMock.returnCase.update.mockImplementationOnce(async () => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "raw-string-failure";
    });

    const body = await (
      await call({
        action: "bulk_reject",
        returnIds: ["rc-string-throw"],
        rejectionReason: "fraud",
      })
    ).json();

    expect(body.errorCount).toBe(1);
    expect(body.results).toEqual([
      { id: "rc-string-throw", success: false, error: "Unknown error" },
    ]);
    errSpy.mockRestore();
  });

  it("isolates a single failing row in a mixed batch — other rows still reject normally", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      { id: "rc-ok-1", status: "pending", customerEmailNorm: null, shopifyOrderName: "#1" },
      { id: "rc-bad", status: "pending", customerEmailNorm: null, shopifyOrderName: "#1" },
      { id: "rc-ok-2", status: "pending", customerEmailNorm: null, shopifyOrderName: "#1" },
    ]);
    prismaMock.returnCase.update.mockImplementation(async ({ where }: { where: { id: string } }) => {
      if (where.id === "rc-bad") throw new Error("row-locked");
      return { id: where.id };
    });

    const body = await (
      await call({
        action: "bulk_reject",
        returnIds: ["rc-ok-1", "rc-bad", "rc-ok-2"],
        rejectionReason: "duplicate",
      })
    ).json();

    expect(body.successCount).toBe(2);
    expect(body.errorCount).toBe(1);
    const bad = body.results.find((r: { id: string }) => r.id === "rc-bad");
    expect(bad).toEqual({ id: "rc-bad", success: false, error: "row-locked" });
    // Event rows only persisted for the two successful flips.
    expect(prismaMock.returnEvent.create).toHaveBeenCalledTimes(2);
    errSpy.mockRestore();
  });
});
