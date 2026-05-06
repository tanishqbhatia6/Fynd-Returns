/**
 * Coverage gap test for `app/lib/return-actions/index.ts`.
 *
 * The barrel file is a pure re-export module: it has no runtime logic, no
 * dispatch table, no switch, and no input parsing. To exercise every line
 * (the `export { handle... } from "./...server"` statements) we mock each
 * underlying handler module so the barrel resolves without pulling in
 * Prisma, Shopify, or observability dependencies, and then assert that
 * every documented named export is present, callable, and forwards to its
 * source module.
 *
 * Existing per-handler tests (extracted-handlers.test.ts, *-deep.test.ts)
 * cover the actual handler implementations. This file exists solely to
 * close the coverage gap on the barrel itself.
 */
import { describe, it, expect, vi } from "vitest";

// Mock each handler module BEFORE the barrel import is resolved. We use
// hoisted factories so vitest places them above the static import chain.
vi.mock("../add-note.server", () => ({
  handleAddNote: vi.fn(async () => new Response("add-note")),
}));
vi.mock("../save-notes-for-customer.server", () => ({
  handleSaveNotesForCustomer: vi.fn(async () => new Response("save-notes")),
}));
vi.mock("../update-label.server", () => ({
  handleUpdateLabel: vi.fn(async () => new Response("update-label")),
}));
vi.mock("../update-instructions.server", () => ({
  handleUpdateInstructions: vi.fn(async () => new Response("update-instructions")),
}));
vi.mock("../edit-details.server", () => ({
  handleEditDetails: vi.fn(async () => new Response("edit-details")),
}));
vi.mock("../update-status.server", () => ({
  handleUpdateStatus: vi.fn(async () => new Response("update-status")),
}));
vi.mock("../cancel-order.server", () => ({
  handleCancelOrder: vi.fn(async () => new Response("cancel-order")),
}));
vi.mock("../reject.server", () => ({
  handleReject: vi.fn(async () => new Response("reject")),
}));
vi.mock("../decline-cancellation.server", () => ({
  handleDeclineCancellation: vi.fn(async () => new Response("decline-cancellation")),
}));
vi.mock("../retry-fynd-sync.server", () => ({
  handleRetryFyndSync: vi.fn(async () => new Response("retry-fynd-sync")),
}));
vi.mock("../approve-cancellation.server", () => ({
  handleApproveCancellation: vi.fn(async () => new Response("approve-cancellation")),
}));
vi.mock("../approve.server", () => ({
  handleApprove: vi.fn(async () => new Response("approve")),
}));
vi.mock("../refresh-fynd-details.server", () => ({
  handleRefreshFyndDetails: vi.fn(async () => new Response("refresh-fynd-details")),
}));
vi.mock("../process-replacement.server", () => ({
  handleProcessReplacement: vi.fn(async () => new Response("process-replacement")),
}));
vi.mock("../process-exchange.server", () => ({
  handleProcessExchange: vi.fn(async () => new Response("process-exchange")),
}));
vi.mock("../process-refund.server", () => ({
  handleProcessRefund: vi.fn(async () => new Response("process-refund")),
}));

// Importing the barrel after mocks are registered. This evaluates every
// `export { ... } from "./..."` line in index.ts.
import * as barrel from "../index";

describe("return-actions/index barrel re-exports", () => {
  // Single source of truth: name -> body text the mock returns. The barrel
  // is asserted to surface every entry of this table exactly.
  const expectedHandlers: ReadonlyArray<readonly [keyof typeof barrel, string]> = [
    ["handleAddNote", "add-note"],
    ["handleSaveNotesForCustomer", "save-notes"],
    ["handleUpdateLabel", "update-label"],
    ["handleUpdateInstructions", "update-instructions"],
    ["handleEditDetails", "edit-details"],
    ["handleUpdateStatus", "update-status"],
    ["handleCancelOrder", "cancel-order"],
    ["handleReject", "reject"],
    ["handleDeclineCancellation", "decline-cancellation"],
    ["handleRetryFyndSync", "retry-fynd-sync"],
    ["handleApproveCancellation", "approve-cancellation"],
    ["handleApprove", "approve"],
    ["handleRefreshFyndDetails", "refresh-fynd-details"],
    ["handleProcessReplacement", "process-replacement"],
    ["handleProcessExchange", "process-exchange"],
    ["handleProcessRefund", "process-refund"],
  ];

  it("exports every handler name documented in the barrel", () => {
    for (const [name] of expectedHandlers) {
      expect(barrel, `barrel missing ${String(name)}`).toHaveProperty(name as string);
      expect(typeof (barrel as Record<string, unknown>)[name as string]).toBe("function");
    }
  });

  it("does not leak any unexpected runtime exports", () => {
    // Type-only re-exports (ReturnActionHandler, ReturnHandlerContext,
    // ReturnActionBody, ReturnCaseWithItems, ShopWithSettings) are erased
    // at compile time, so the runtime keys must equal the handler list.
    const runtimeKeys = Object.keys(barrel).sort();
    const expectedKeys = expectedHandlers.map(([n]) => n as string).sort();
    expect(runtimeKeys).toEqual(expectedKeys);
  });

  it("forwards each handler call to its source module (identity-preserving re-exports)", async () => {
    // Calling each barrel-exported handler should return the mocked
    // module's response, proving the barrel forwards the *same* function
    // reference rather than wrapping/transforming it.
    for (const [name, body] of expectedHandlers) {
      const fn = (barrel as Record<string, (...args: unknown[]) => Promise<Response>>)[
        name as string
      ];
      const res = await fn(
        // ctx and body are not inspected by our mocks — pass empty stubs.
        {} as never,
        { action: name } as never,
      );
      expect(res).toBeInstanceOf(Response);
      await expect(res.text()).resolves.toBe(body);
    }
  });

  it("each handler is uniquely identified (no accidental aliasing)", () => {
    // Defensive: protect against a future edit that accidentally points
    // two named exports at the same underlying function.
    const refs = expectedHandlers.map(([n]) => (barrel as Record<string, unknown>)[n as string]);
    const unique = new Set(refs);
    expect(unique.size).toBe(refs.length);
  });

  it("type-only re-exports compile (smoke check via runtime absence)", () => {
    // Types are erased; this assertion documents that the type-only line
    // (`export type { ReturnActionHandler, ... }`) does not introduce any
    // runtime symbol. If someone ever converts it to a value export by
    // mistake, this guard fails.
    for (const typeName of [
      "ReturnActionHandler",
      "ReturnHandlerContext",
      "ReturnActionBody",
      "ReturnCaseWithItems",
      "ShopWithSettings",
    ]) {
      expect((barrel as Record<string, unknown>)[typeName]).toBeUndefined();
    }
  });
});
