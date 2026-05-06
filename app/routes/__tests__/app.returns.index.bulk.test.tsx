/**
 * @vitest-environment jsdom
 *
 * Bulk-action UI coverage for `app/routes/app.returns._index.tsx`.
 * Drives the row-selection checkboxes, the floating bulk-action bar (Approve,
 * Reject, Change-resolution dropdown, Clear), and the rejection-confirmation
 * modal. NEVER modifies source.
 *
 * The component reads `useLoaderData<typeof loader>()` so we use
 * `renderWithRouter` from `app/test/component-helpers` to mount it inside a
 * memory-router stub.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Module stubs (kept identical to the simple sibling suite) ──
vi.mock("../../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: {
    error: vi.fn(() => null),
    headers: vi.fn(() => ({})),
  },
  shopifyApp: vi.fn(() => ({
    addDocumentResponseHeaders: vi.fn(),
    authenticate: { admin: vi.fn() },
    unauthenticated: {},
    login: vi.fn(),
    registerWebhooks: vi.fn(),
    sessionStorage: {},
  })),
  ApiVersion: { January25: "2025-01" },
  AppDistribution: { AppStore: "app_store" },
  DeliveryMethod: { Http: "http" },
}));

vi.mock("../../db.server", () => ({ default: {} }));

import { renderWithRouter } from "../../test/component-helpers";
import { fireEvent, waitFor, act } from "@testing-library/react";
import ReturnsList from "../app.returns._index";

// ── Fixture builder — only the columns the component reads ──
type ReturnRow = {
  id: string;
  status: string;
  shopifyOrderName: string | null;
  returnRequestNo: string | null;
  customerName: string | null;
  customerEmailNorm: string | null;
  customerPhoneNorm: string | null;
  resolutionType: string | null;
  refundStatus: string | null;
  refundAmount: number | null;
  fyndOrderId: string | null;
  fyndReturnId: string | null;
  fyndReturnNo: string | null;
  fyndShipmentId: string | null;
  forwardAwb: string | null;
  returnAwb: string | null;
  fyndSyncStatus: string | null;
  sourceChannel: string | null;
  fraudRiskLevel: string | null;
  isGiftReturn: boolean;
  cancellationRequestedAt: Date | null;
  createdAt: Date;
};

function mkReturn(overrides: Partial<ReturnRow> = {}): ReturnRow {
  return {
    id: "ret-1",
    status: "pending",
    shopifyOrderName: "#1001",
    returnRequestNo: "RR-001",
    customerName: "Alice",
    customerEmailNorm: "a@example.com",
    customerPhoneNorm: null,
    resolutionType: "refund",
    refundStatus: null,
    refundAmount: 50,
    fyndOrderId: null,
    fyndReturnId: null,
    fyndReturnNo: null,
    fyndShipmentId: null,
    forwardAwb: null,
    returnAwb: null,
    fyndSyncStatus: null,
    sourceChannel: null,
    fraudRiskLevel: null,
    isGiftReturn: false,
    cancellationRequestedAt: null,
    createdAt: new Date("2026-04-12T10:30:00Z"),
    ...overrides,
  };
}

// Two selectable (pending/processing) + one non-selectable (approved).
const rows: ReturnRow[] = [
  mkReturn({ id: "ret-1", status: "pending", returnRequestNo: "RR-001" }),
  mkReturn({ id: "ret-2", status: "processing", returnRequestNo: "RR-002" }),
  mkReturn({ id: "ret-3", status: "approved", returnRequestNo: "RR-003" }),
];

const baseLoaderData = {
  returns: rows,
  query: "",
  status: "",
  resolutionType: "",
  sourceChannel: "",
  page: 1,
  totalCount: rows.length,
  totalPages: 1,
  pendingCount: 1,
  inProgressCount: 1,
  approvedCount: 1,
  rejectedCount: 0,
  allCount: 3,
  error: null,
  shopLocale: "en",
  shopTimezone: "UTC",
};

// Helpers — query the table row checkboxes / select-all checkbox.
function getSelectAllCheckbox(container: HTMLElement): HTMLInputElement {
  const cb = container.querySelector(
    'th.checkbox-th input[type="checkbox"]',
  ) as HTMLInputElement | null;
  if (!cb) throw new Error("select-all checkbox not found");
  return cb;
}
function getRowCheckboxes(container: HTMLElement): HTMLInputElement[] {
  return Array.from(
    container.querySelectorAll('td.checkbox-cell input[type="checkbox"]'),
  ) as HTMLInputElement[];
}
function getRowCheckboxCells(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll("td.checkbox-cell"),
  ) as HTMLElement[];
}
function getBulkBar(container: HTMLElement): HTMLElement | null {
  return container.querySelector(".returns-bulk-bar") as HTMLElement | null;
}
function getButtonByText(container: HTMLElement, text: string): HTMLElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (b) => (b.textContent || "").trim() === text,
  );
}

describe("app.returns._index — bulk-action UI", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async () =>
      // Default: bulk endpoint returns success for all selected ids.
      ({
        ok: true,
        json: async () => ({ successCount: 2, errorCount: 0, results: [] }),
      }) as unknown as Response,
    );
    // Vitest jsdom env doesn't ship a fetch — install the spy globally.
    (globalThis as { fetch?: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as { fetch?: typeof fetch }).fetch;
  });

  it("renders the floating bulk bar in the hidden state when nothing is selected", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    const bar = getBulkBar(container);
    expect(bar).toBeTruthy();
    expect(bar?.className).toContain("returns-bulk-bar--hidden");
    expect(bar?.className).not.toContain("returns-bulk-bar--visible");
  });

  it("select-all checkbox marks every actionable row as selected", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    const selectAll = getSelectAllCheckbox(container);
    expect(selectAll.checked).toBe(false);
    fireEvent.click(selectAll);
    await waitFor(() => expect(selectAll.checked).toBe(true));
    // The bar should flip to visible with "2 selected" (3rd row is approved → not selectable).
    const bar = getBulkBar(container)!;
    expect(bar.className).toContain("returns-bulk-bar--visible");
    expect(bar.textContent).toContain("2 selected");
    // Both selectable row-checkboxes flip to checked; the approved row stays unchecked.
    const rowCbs = getRowCheckboxes(container);
    expect(rowCbs[0].checked).toBe(true);
    expect(rowCbs[1].checked).toBe(true);
    expect(rowCbs[2].checked).toBe(false);
  });

  it("clicking select-all again deselects every row and hides the bulk bar", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    const selectAll = getSelectAllCheckbox(container);
    fireEvent.click(selectAll); // select
    fireEvent.click(selectAll); // deselect
    await waitFor(() => expect(selectAll.checked).toBe(false));
    const bar = getBulkBar(container)!;
    expect(bar.className).toContain("returns-bulk-bar--hidden");
    const rowCbs = getRowCheckboxes(container);
    expect(rowCbs.every((c) => !c.checked)).toBe(true);
  });

  it("toggling a single row checkbox shows the bulk bar with '1 selected'", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    const cells = getRowCheckboxCells(container);
    fireEvent.click(cells[0]);
    await waitFor(() => {
      expect(getBulkBar(container)?.className).toContain(
        "returns-bulk-bar--visible",
      );
    });
    expect(getBulkBar(container)?.textContent).toContain("1 selected");
    // Selected row gets the .row-selected class.
    expect(container.querySelectorAll("tr.row-selected").length).toBe(1);
  });

  it("clicking the same row checkbox cell again deselects it", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    const cells = getRowCheckboxCells(container);
    fireEvent.click(cells[0]);
    fireEvent.click(cells[0]);
    await waitFor(() => {
      expect(getBulkBar(container)?.className).toContain(
        "returns-bulk-bar--hidden",
      );
    });
    expect(container.querySelectorAll("tr.row-selected").length).toBe(0);
  });

  it("non-selectable (approved) row checkbox is disabled and click is a no-op", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    const rowCbs = getRowCheckboxes(container);
    expect(rowCbs[2].disabled).toBe(true);
    const cells = getRowCheckboxCells(container);
    fireEvent.click(cells[2]); // non-selectable row
    expect(getBulkBar(container)?.className).toContain(
      "returns-bulk-bar--hidden",
    );
  });

  it("bulk Approve button calls /api/returns/bulk with bulk_approve action", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    fireEvent.click(getRowCheckboxCells(container)[0]);
    const approveBtn = getButtonByText(container, "Approve");
    expect(approveBtn).toBeTruthy();
    await act(async () => {
      fireEvent.click(approveBtn!);
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("/api/returns/bulk");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.action).toBe("bulk_approve");
    expect(body.returnIds).toEqual(["ret-1"]);
  });

  it("clicking bulk Reject opens the rejection-confirmation modal", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    fireEvent.click(getRowCheckboxCells(container)[0]);
    const rejectBtn = getButtonByText(container, "Reject");
    fireEvent.click(rejectBtn!);
    await waitFor(() => {
      expect(container.querySelector(".returns-modal-overlay")).toBeTruthy();
    });
    // Modal title reflects selection count (1 → singular "Return").
    expect(container.textContent).toContain("Reject 1 Return");
    // Textarea placeholder lives on the attribute, not textContent.
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(ta.getAttribute("placeholder")).toContain("Rejection reason (required)");
  });

  it("rejection modal title pluralises when multiple rows are selected", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    fireEvent.click(getSelectAllCheckbox(container));
    fireEvent.click(getButtonByText(container, "Reject")!);
    await waitFor(() => {
      expect(container.querySelector(".returns-modal-overlay")).toBeTruthy();
    });
    expect(container.textContent).toContain("Reject 2 Returns");
  });

  it("rejection modal Reject-All is disabled when reason is blank", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    fireEvent.click(getRowCheckboxCells(container)[0]);
    fireEvent.click(getButtonByText(container, "Reject")!);
    await waitFor(() => {
      expect(container.querySelector(".returns-modal-overlay")).toBeTruthy();
    });
    const rejectAll = getButtonByText(container, "Reject All") as HTMLButtonElement;
    expect(rejectAll.disabled).toBe(true);
    // Click is a no-op while disabled — no fetch yet.
    fireEvent.click(rejectAll);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("rejection modal submits with the typed reason and closes on confirm", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    fireEvent.click(getRowCheckboxCells(container)[0]);
    fireEvent.click(getButtonByText(container, "Reject")!);
    await waitFor(() => {
      expect(container.querySelector(".returns-modal-overlay")).toBeTruthy();
    });
    const textarea = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "items damaged on arrival" } });
    // 24-char reason → counter shows 24/500.
    expect(container.textContent).toContain("24/500");
    await act(async () => {
      fireEvent.click(getButtonByText(container, "Reject All")!);
    });
    // Modal must close on confirm.
    expect(container.querySelector(".returns-modal-overlay")).toBeFalsy();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body);
    expect(body.action).toBe("bulk_reject");
    expect(body.rejectionReason).toBe("items damaged on arrival");
  });

  it("rejection modal Cancel button closes without firing fetch", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    fireEvent.click(getRowCheckboxCells(container)[0]);
    fireEvent.click(getButtonByText(container, "Reject")!);
    await waitFor(() => {
      expect(container.querySelector(".returns-modal-overlay")).toBeTruthy();
    });
    fireEvent.click(getButtonByText(container, "Cancel")!);
    await waitFor(() => {
      expect(container.querySelector(".returns-modal-overlay")).toBeFalsy();
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("clicking the rejection modal overlay closes the modal", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    fireEvent.click(getRowCheckboxCells(container)[0]);
    fireEvent.click(getButtonByText(container, "Reject")!);
    await waitFor(() => {
      expect(container.querySelector(".returns-modal-overlay")).toBeTruthy();
    });
    fireEvent.click(container.querySelector(".returns-modal-overlay") as HTMLElement);
    await waitFor(() => {
      expect(container.querySelector(".returns-modal-overlay")).toBeFalsy();
    });
  });

  it("change-resolution dropdown fires bulk_change_resolution with the picked value", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    fireEvent.click(getRowCheckboxCells(container)[0]);
    const select = container.querySelector(
      ".returns-bulk-bar select.bulk-select",
    ) as HTMLSelectElement;
    expect(select).toBeTruthy();
    await act(async () => {
      fireEvent.change(select, { target: { value: "store_credit" } });
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body);
    expect(body.action).toBe("bulk_change_resolution");
    expect(body.resolutionType).toBe("store_credit");
  });

  it("change-resolution dropdown lists all four resolution options", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    const select = container.querySelector(
      ".returns-bulk-bar select.bulk-select",
    ) as HTMLSelectElement;
    const values = Array.from(select.querySelectorAll("option")).map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(values).toEqual(
      expect.arrayContaining(["refund", "exchange", "store_credit", "replacement"]),
    );
  });

  it("Clear button (deselect-all) wipes selection and hides the bulk bar", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    fireEvent.click(getSelectAllCheckbox(container));
    expect(getBulkBar(container)?.className).toContain("returns-bulk-bar--visible");
    fireEvent.click(getButtonByText(container, "Clear")!);
    await waitFor(() => {
      expect(getBulkBar(container)?.className).toContain("returns-bulk-bar--hidden");
    });
    expect(container.querySelectorAll("tr.row-selected").length).toBe(0);
  });

  it("selected-count text updates as rows are individually toggled", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    const cells = getRowCheckboxCells(container);
    fireEvent.click(cells[0]);
    expect(getBulkBar(container)?.textContent).toContain("1 selected");
    fireEvent.click(cells[1]);
    expect(getBulkBar(container)?.textContent).toContain("2 selected");
    fireEvent.click(cells[1]);
    expect(getBulkBar(container)?.textContent).toContain("1 selected");
  });

  it("bulk-approve success toast + selection cleared after a successful response", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ successCount: 1, errorCount: 0, results: [] }),
    } as unknown as Response);
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    fireEvent.click(getRowCheckboxCells(container)[0]);
    await act(async () => {
      fireEvent.click(getButtonByText(container, "Approve")!);
    });
    await waitFor(() => {
      expect(container.textContent).toContain("1 return approved successfully");
    });
    // Selection state is reset → bar hides again.
    expect(getBulkBar(container)?.className).toContain("returns-bulk-bar--hidden");
  });

  it("bulk-approve surfaces a per-row error banner when the API reports failures", async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        successCount: 0,
        errorCount: 1,
        results: [{ id: "ret-1", success: false, error: "fynd not configured" }],
      }),
    } as unknown as Response);
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    fireEvent.click(getRowCheckboxCells(container)[0]);
    await act(async () => {
      fireEvent.click(getButtonByText(container, "Approve")!);
    });
    await waitFor(() => {
      expect(container.textContent).toContain("fynd not configured");
    });
    expect(container.textContent).toContain("0 approved, 1 failed");
  });

  it("bulk-approve renders the network-error banner when fetch rejects", async () => {
    fetchSpy.mockRejectedValueOnce(new Error("offline"));
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    fireEvent.click(getRowCheckboxCells(container)[0]);
    await act(async () => {
      fireEvent.click(getButtonByText(container, "Approve")!);
    });
    await waitFor(() => {
      expect(container.textContent).toContain("offline");
    });
  });
});
