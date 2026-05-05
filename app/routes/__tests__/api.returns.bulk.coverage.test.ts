/**
 * Extra integration coverage for `app/routes/api.returns.bulk.ts`.
 *
 * The companion file (api.returns.bulk.test.ts) covers the basic happy /
 * guard paths. This file leans on **batched N>10** scenarios — large
 * fan-out across mixed statuses, mixed-shop ownership, terminal-status
 * skips, notification fan-out, event emission, idempotency, and the
 * resolutionType happy/failure mix — to catch regressions in the per-row
 * loop accounting (successCount / errorCount / results array).
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

// ──────────────────────────────────────────────────────────────────────
//  bulk_approve — large batch scenarios
// ──────────────────────────────────────────────────────────────────────

describe("bulk_approve — N>10 batched", () => {
  it("processes 15 pending returns in one shot (all success)", async () => {
    const ids = Array.from({ length: 15 }, (_, i) => `rc-${i}`);
    prismaMock.returnCase.findMany.mockResolvedValueOnce(
      ids.map((id) => ({ id, status: "pending", customerEmailNorm: null, shopifyOrderName: `#${id}` })),
    );
    prismaMock.returnCase.updateMany.mockResolvedValue({ count: 1 });

    const res = await call({ action: "bulk_approve", returnIds: ids });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.successCount).toBe(15);
    expect(body.errorCount).toBe(0);
    expect(body.results).toHaveLength(15);
    expect(prismaMock.returnEvent.create).toHaveBeenCalledTimes(15);
  });

  it("mixes 12 pending + 3 already-approved → 12 successes, 3 terminal errors", async () => {
    const pending = Array.from({ length: 12 }, (_, i) => ({
      id: `rc-p${i}`, status: "pending", customerEmailNorm: null, shopifyOrderName: "#1",
    }));
    const terminal = Array.from({ length: 3 }, (_, i) => ({
      id: `rc-a${i}`, status: "approved", customerEmailNorm: null, shopifyOrderName: "#1",
    }));
    prismaMock.returnCase.findMany.mockResolvedValueOnce([...pending, ...terminal]);
    prismaMock.returnCase.updateMany.mockResolvedValue({ count: 1 });

    const ids = [...pending, ...terminal].map((r) => r.id);
    const body = await (await call({ action: "bulk_approve", returnIds: ids })).json();

    expect(body.successCount).toBe(12);
    expect(body.errorCount).toBe(3);
    expect(body.results.filter((r: { error?: string }) => r.error?.includes("already approved"))).toHaveLength(3);
  });

  it("fans out approval emails for all 11 customers with email addresses", async () => {
    const cases = Array.from({ length: 11 }, (_, i) => ({
      id: `rc-${i}`, status: "pending", customerEmailNorm: `u${i}@x.com`, shopifyOrderName: `#${1000 + i}`,
    }));
    prismaMock.returnCase.findMany.mockResolvedValueOnce(cases);
    prismaMock.returnCase.updateMany.mockResolvedValue({ count: 1 });

    await call({ action: "bulk_approve", returnIds: cases.map((c) => c.id) });
    expect(sendApprovalMock).toHaveBeenCalledTimes(11);
  });

  it("treats updateMany.count=0 as already-approved across a batch of 13", async () => {
    const ids = Array.from({ length: 13 }, (_, i) => `rc-${i}`);
    prismaMock.returnCase.findMany.mockResolvedValueOnce(
      ids.map((id) => ({ id, status: "pending", customerEmailNorm: null, shopifyOrderName: "#1" })),
    );
    prismaMock.returnCase.updateMany.mockResolvedValue({ count: 0 });

    const body = await (await call({ action: "bulk_approve", returnIds: ids })).json();
    // count=0 still counts as success per route, with "Already approved" hint.
    expect(body.successCount).toBe(13);
    expect(body.results.every((r: { error?: string }) => r.error === "Already approved")).toBe(true);
    // No event row when no actual update happened.
    expect(prismaMock.returnEvent.create).not.toHaveBeenCalled();
  });

  it("partial DB failures: 1 of 12 throws, results stay aligned", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `rc-${i}`);
    prismaMock.returnCase.findMany.mockResolvedValueOnce(
      ids.map((id) => ({ id, status: "pending", customerEmailNorm: null, shopifyOrderName: "#1" })),
    );
    let nthCall = 0;
    prismaMock.returnCase.updateMany.mockImplementation(async () => {
      nthCall += 1;
      if (nthCall === 5) throw new Error("simulated-deadlock");
      return { count: 1 };
    });

    const body = await (await call({ action: "bulk_approve", returnIds: ids })).json();
    expect(body.errorCount).toBe(1);
    expect(body.successCount).toBe(11);
    const failed = body.results.find((r: { error?: string }) => r.error?.includes("simulated-deadlock"));
    expect(failed).toBeDefined();
  });

  it("merges 10 found + 5 missing-shop ids into a 15-row result", async () => {
    const found = Array.from({ length: 10 }, (_, i) => `rc-found-${i}`);
    const missing = Array.from({ length: 5 }, (_, i) => `rc-miss-${i}`);
    prismaMock.returnCase.findMany.mockResolvedValueOnce(
      found.map((id) => ({ id, status: "pending", customerEmailNorm: null, shopifyOrderName: "#1" })),
    );
    prismaMock.returnCase.updateMany.mockResolvedValue({ count: 1 });

    const body = await (await call({ action: "bulk_approve", returnIds: [...found, ...missing] })).json();
    expect(body.results).toHaveLength(15);
    expect(body.successCount).toBe(10);
    expect(body.errorCount).toBe(5);
    const missingErrors = body.results.filter((r: { error?: string }) => r.error?.includes("not found"));
    expect(missingErrors).toHaveLength(5);
  });

  it("applies overridden resolutionType to every row in a 12-batch", async () => {
    const ids = Array.from({ length: 12 }, (_, i) => `rc-${i}`);
    prismaMock.returnCase.findMany.mockResolvedValueOnce(
      ids.map((id) => ({ id, status: "pending", customerEmailNorm: null })),
    );
    prismaMock.returnCase.updateMany.mockResolvedValue({ count: 1 });

    await call({ action: "bulk_approve", returnIds: ids, resolutionType: "store_credit" });
    const calls = prismaMock.returnCase.updateMany.mock.calls;
    expect(calls).toHaveLength(12);
    for (const [arg] of calls) {
      expect(arg.data.resolutionType).toBe("store_credit");
    }
  });

  it("falls back to default 'refund' when resolutionType is invalid", async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `rc-${i}`);
    prismaMock.returnCase.findMany.mockResolvedValueOnce(
      ids.map((id) => ({ id, status: "pending", customerEmailNorm: null })),
    );
    prismaMock.returnCase.updateMany.mockResolvedValue({ count: 1 });

    await call({ action: "bulk_approve", returnIds: ids, resolutionType: "bogus" });
    const calls = prismaMock.returnCase.updateMany.mock.calls;
    for (const [arg] of calls) {
      expect(arg.data.resolutionType).toBe("refund");
    }
  });
});

// ──────────────────────────────────────────────────────────────────────
//  bulk_reject — large batch scenarios
// ──────────────────────────────────────────────────────────────────────

describe("bulk_reject — N>10 batched", () => {
  it("rejects 14 pending returns and stamps every event with the same reason", async () => {
    const ids = Array.from({ length: 14 }, (_, i) => `rc-${i}`);
    prismaMock.returnCase.findMany.mockResolvedValueOnce(
      ids.map((id) => ({ id, status: "pending", customerEmailNorm: null, shopifyOrderName: "#1" })),
    );

    const reason = "duplicate-order";
    const body = await (await call({ action: "bulk_reject", returnIds: ids, rejectionReason: reason })).json();
    expect(body.successCount).toBe(14);
    expect(prismaMock.returnEvent.create).toHaveBeenCalledTimes(14);
    for (const [arg] of prismaMock.returnEvent.create.mock.calls) {
      const payload = JSON.parse(arg.data.payloadJson);
      expect(payload.rejectionReason).toBe(reason);
      expect(payload.bulk).toBe(true);
    }
  });

  it("trims whitespace-padded rejectionReason before storing", async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `rc-${i}`);
    prismaMock.returnCase.findMany.mockResolvedValueOnce(
      ids.map((id) => ({ id, status: "pending", customerEmailNorm: null, shopifyOrderName: "#1" })),
    );
    await call({ action: "bulk_reject", returnIds: ids, rejectionReason: "   damaged   " });
    for (const [arg] of prismaMock.returnCase.update.mock.calls) {
      expect(arg.data.rejectionReason).toBe("damaged");
    }
  });

  it("skips the 4 terminal rows, rejects the 8 pending ones (12 total)", async () => {
    const pending = Array.from({ length: 8 }, (_, i) => ({
      id: `rc-p${i}`, status: "pending", customerEmailNorm: null, shopifyOrderName: "#1",
    }));
    const terminals = [
      { id: "rc-app", status: "approved", customerEmailNorm: null, shopifyOrderName: "#1" },
      { id: "rc-rej", status: "rejected", customerEmailNorm: null, shopifyOrderName: "#1" },
      { id: "rc-cmp", status: "completed", customerEmailNorm: null, shopifyOrderName: "#1" },
      { id: "rc-can", status: "cancelled", customerEmailNorm: null, shopifyOrderName: "#1" },
    ];
    prismaMock.returnCase.findMany.mockResolvedValueOnce([...pending, ...terminals]);

    const ids = [...pending, ...terminals].map((r) => r.id);
    const body = await (await call({ action: "bulk_reject", returnIds: ids, rejectionReason: "x" })).json();
    expect(body.successCount).toBe(8);
    expect(body.errorCount).toBe(4);
    expect(prismaMock.returnCase.update).toHaveBeenCalledTimes(8);
  });

  it("notifies only customers with an email (mixed batch of 12)", async () => {
    const cases = Array.from({ length: 12 }, (_, i) => ({
      id: `rc-${i}`,
      status: "pending",
      customerEmailNorm: i % 2 === 0 ? `u${i}@x.com` : null,
      shopifyOrderName: "#1",
    }));
    prismaMock.returnCase.findMany.mockResolvedValueOnce(cases);
    await call({ action: "bulk_reject", returnIds: cases.map((c) => c.id), rejectionReason: "dup" });
    // 6 even-indexed rows have an email.
    expect(sendRejectionMock).toHaveBeenCalledTimes(6);
  });

  it("notification failure on one row does not break the per-row success", async () => {
    const cases = Array.from({ length: 11 }, (_, i) => ({
      id: `rc-${i}`, status: "pending", customerEmailNorm: `u${i}@x.com`, shopifyOrderName: "#1",
    }));
    prismaMock.returnCase.findMany.mockResolvedValueOnce(cases);
    sendRejectionMock.mockRejectedValueOnce(new Error("smtp-fail"));

    const body = await (await call({ action: "bulk_reject", returnIds: cases.map((c) => c.id), rejectionReason: "dup" })).json();
    expect(body.successCount).toBe(11);
    expect(body.errorCount).toBe(0);
  });
});

// ──────────────────────────────────────────────────────────────────────
//  bulk_change_resolution — large batch scenarios
// ──────────────────────────────────────────────────────────────────────

describe("bulk_change_resolution — N>10 batched", () => {
  it("changes resolution on 13 mixed-status rows (skipping 2 rejected/cancelled)", async () => {
    const cases = [
      ...Array.from({ length: 13 }, (_, i) => ({
        id: `rc-ok${i}`, status: i % 2 === 0 ? "pending" : "approved", resolutionType: "refund",
      })),
      { id: "rc-skip-rej", status: "rejected", resolutionType: "refund" },
      { id: "rc-skip-can", status: "cancelled", resolutionType: "refund" },
    ];
    prismaMock.returnCase.findMany.mockResolvedValueOnce(cases);
    const body = await (await call({
      action: "bulk_change_resolution",
      returnIds: cases.map((c) => c.id),
      resolutionType: "exchange",
    })).json();

    expect(body.successCount).toBe(13);
    expect(body.errorCount).toBe(2);
    expect(prismaMock.returnCase.update).toHaveBeenCalledTimes(13);
  });

  it("emits resolution_changed event with previousType for every successful row (12 rows)", async () => {
    const cases = Array.from({ length: 12 }, (_, i) => ({
      id: `rc-${i}`,
      status: "pending",
      resolutionType: i % 2 === 0 ? "refund" : "store_credit",
    }));
    prismaMock.returnCase.findMany.mockResolvedValueOnce(cases);
    await call({
      action: "bulk_change_resolution",
      returnIds: cases.map((c) => c.id),
      resolutionType: "replacement",
    });
    expect(prismaMock.returnEvent.create).toHaveBeenCalledTimes(12);
    for (let i = 0; i < 12; i++) {
      const arg = prismaMock.returnEvent.create.mock.calls[i][0];
      const payload = JSON.parse(arg.data.payloadJson);
      expect(payload.resolutionType).toBe("replacement");
      expect(payload.bulk).toBe(true);
      expect(payload.previousType).toBe(i % 2 === 0 ? "refund" : "store_credit");
    }
  });

  it("isolates per-row DB failures across an 11-batch", async () => {
    const cases = Array.from({ length: 11 }, (_, i) => ({
      id: `rc-${i}`, status: "pending", resolutionType: "refund",
    }));
    prismaMock.returnCase.findMany.mockResolvedValueOnce(cases);
    let nth = 0;
    prismaMock.returnCase.update.mockImplementation(async ({ where, data }) => {
      nth += 1;
      if (nth === 3 || nth === 7) throw new Error(`db-fail-${nth}`);
      return { ...where, ...data };
    });

    const body = await (await call({
      action: "bulk_change_resolution",
      returnIds: cases.map((c) => c.id),
      resolutionType: "exchange",
    })).json();

    expect(body.successCount).toBe(9);
    expect(body.errorCount).toBe(2);
    const failures = body.results.filter((r: { success: boolean }) => !r.success);
    expect(failures.map((f: { error?: string }) => f.error)).toEqual(
      expect.arrayContaining([expect.stringMatching(/db-fail-3/), expect.stringMatching(/db-fail-7/)]),
    );
  });

  it("rejects unknown resolutionType (validation guard) before any DB call", async () => {
    const ids = Array.from({ length: 11 }, (_, i) => `rc-${i}`);
    const res = await call({ action: "bulk_change_resolution", returnIds: ids, resolutionType: "gift_card" });
    expect(res.status).toBe(400);
    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
  });

  it("appends not-found entries for ids that don't belong to the shop (10 found + 4 missing)", async () => {
    const found = Array.from({ length: 10 }, (_, i) => ({
      id: `rc-${i}`, status: "pending", resolutionType: "refund",
    }));
    const missing = ["rc-x1", "rc-x2", "rc-x3", "rc-x4"];
    prismaMock.returnCase.findMany.mockResolvedValueOnce(found);

    const body = await (await call({
      action: "bulk_change_resolution",
      returnIds: [...found.map((f) => f.id), ...missing],
      resolutionType: "exchange",
    })).json();

    expect(body.results).toHaveLength(14);
    expect(body.successCount).toBe(10);
    expect(body.errorCount).toBe(4);
    expect(body.results.filter((r: { error?: string }) => r.error?.includes("not found"))).toHaveLength(4);
  });
});
