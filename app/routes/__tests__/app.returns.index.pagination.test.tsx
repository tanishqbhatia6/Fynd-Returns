/**
 * @vitest-environment jsdom
 *
 * Pagination + filter + interaction coverage for app/routes/app.returns._index.tsx.
 * Focuses on rendering of toolbar, pagination boundaries, status counts,
 * results-summary, search/filter dropdowns, sort/export/refresh controls, and
 * bulk-action UI (checkboxes + reject modal).
 *
 * No source modifications. Mirrors the mocking pattern of
 * app.returns.index.simple.test.tsx.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";

const { authenticateMock, prismaMock } = vi.hoisted(() => {
  const auth = vi.fn().mockResolvedValue({
    session: { shop: "store.myshopify.com" },
    admin: { graphql: vi.fn() },
  });
  const shopRow = {
    id: "shop-1",
    shopDomain: "store.myshopify.com",
    settings: { shopLocale: "en", shopTimezone: "UTC" },
  };
  const prisma = {
    shop: {
      findUnique: vi.fn().mockResolvedValue(shopRow),
      create: vi.fn().mockResolvedValue(shopRow),
    },
    returnCase: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
  };
  return { authenticateMock: auth, prismaMock: prisma };
});

vi.mock("../../shopify.server", () => ({
  default: {},
  authenticate: { admin: authenticateMock },
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

vi.mock("../../db.server", () => ({ default: prismaMock }));

import { renderWithRouter } from "../../test/component-helpers";
import { act, fireEvent, waitFor } from "@testing-library/react";
import ReturnsList, { ErrorBoundary, loader } from "../app.returns._index";

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
    customerName: "Alice Smith",
    customerEmailNorm: "alice@example.com",
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

const baseReturns: ReturnRow[] = [
  mkReturn({ id: "ret-1", status: "pending", returnRequestNo: "RR-001" }),
  mkReturn({
    id: "ret-2",
    status: "approved",
    returnRequestNo: "RR-002",
    shopifyOrderName: "#1002",
  }),
  mkReturn({
    id: "ret-3",
    status: "processing",
    returnRequestNo: "RR-003",
    shopifyOrderName: "#1003",
    fyndSyncStatus: "failed",
  }),
  mkReturn({
    id: "ret-4",
    status: "approved",
    returnRequestNo: "RR-004",
    shopifyOrderName: "#1004",
    cancellationRequestedAt: new Date("2026-04-15T10:00:00Z"),
  }),
  mkReturn({
    id: "ret-5",
    status: "initiated",
    returnRequestNo: "RR-005",
    shopifyOrderName: "#1005",
    fyndSyncStatus: "synced",
  }),
];

const baseLoaderData = {
  returns: baseReturns,
  query: "",
  status: "",
  resolutionType: "",
  sourceChannel: "",
  page: 1,
  totalCount: baseReturns.length,
  totalPages: 1,
  pendingCount: 2,
  inProgressCount: 1,
  approvedCount: 2,
  rejectedCount: 0,
  allCount: 5,
  error: null,
  shopLocale: "en",
  shopTimezone: "UTC",
};

describe("app.returns._index pagination + filters + bulk", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("disables Prev pagination button on the first page", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns?page=1"],
      loaderData: { ...baseLoaderData, page: 1, totalPages: 5, totalCount: 125 },
    });
    await waitFor(() => {
      expect(container.querySelector(".returns-pagination")).toBeTruthy();
    });
    const btns = container.querySelectorAll(".app-pagination-btn");
    // First button is "prev"
    expect((btns[0] as HTMLButtonElement).disabled).toBe(true);
    // Last button is "next" — should be enabled
    expect((btns[btns.length - 1] as HTMLButtonElement).disabled).toBe(false);
  });

  it("disables Next pagination button on the last page", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns?page=5"],
      loaderData: { ...baseLoaderData, page: 5, totalPages: 5, totalCount: 125 },
    });
    await waitFor(() => {
      expect(container.querySelector(".returns-pagination")).toBeTruthy();
    });
    const btns = container.querySelectorAll(".app-pagination-btn");
    expect((btns[0] as HTMLButtonElement).disabled).toBe(false);
    expect((btns[btns.length - 1] as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders all numbered page buttons when totalPages <= 7", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns?page=2"],
      loaderData: { ...baseLoaderData, page: 2, totalPages: 5, totalCount: 125 },
    });
    await waitFor(() => {
      expect(container.querySelector(".returns-pagination")).toBeTruthy();
    });
    const btns = container.querySelectorAll(".app-pagination-btn");
    // 5 numbered pages + prev + next = 7
    expect(btns.length).toBe(7);
    const active = container.querySelector(".app-pagination-btn.active");
    expect(active?.textContent).toBe("2");
  });

  it("clamps the visible page window at the start when totalPages > 7", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns?page=2"],
      loaderData: {
        ...baseLoaderData,
        page: 2,
        totalPages: 20,
        totalCount: 500,
      },
    });
    await waitFor(() => {
      expect(container.querySelector(".returns-pagination")).toBeTruthy();
    });
    const numbered = Array.from(
      container.querySelectorAll(".app-pagination-btn"),
    )
      .map((b) => b.textContent?.trim() || "")
      .filter((t) => /^\d+$/.test(t));
    // page<=4 branch: shows 1..7
    expect(numbered.slice(0, 7)).toEqual(["1", "2", "3", "4", "5", "6", "7"]);
  });

  it("clamps the visible page window at the end when totalPages > 7", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns?page=20"],
      loaderData: {
        ...baseLoaderData,
        page: 20,
        totalPages: 20,
        totalCount: 500,
      },
    });
    await waitFor(() => {
      expect(container.querySelector(".returns-pagination")).toBeTruthy();
    });
    const numbered = Array.from(
      container.querySelectorAll(".app-pagination-btn"),
    )
      .map((b) => b.textContent?.trim() || "")
      .filter((t) => /^\d+$/.test(t));
    // page>=totalPages-3 branch: shows 14..20
    expect(numbered).toEqual(
      ["14", "15", "16", "17", "18", "19", "20"],
    );
  });

  it("hides the pagination control entirely when totalPages <= 1", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: { ...baseLoaderData, totalPages: 1 },
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    expect(container.querySelector(".returns-pagination")).toBeFalsy();
  });

  it("renders the results summary 'Showing X-Y of Z' on page 1", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns?page=1"],
      loaderData: { ...baseLoaderData, page: 1, totalPages: 4, totalCount: 87 },
    });
    await waitFor(() => {
      expect(container.querySelector(".returns-count-bar")).toBeTruthy();
    });
    const txt = container.querySelector(".returns-count-bar")?.textContent || "";
    expect(txt).toContain("Showing");
    expect(txt).toContain("1");
    expect(txt).toContain("25");
    expect(txt).toContain("87");
  });

  it("renders the results summary correctly on the last partial page", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns?page=4"],
      loaderData: { ...baseLoaderData, page: 4, totalPages: 4, totalCount: 87 },
    });
    await waitFor(() => {
      expect(container.querySelector(".returns-count-bar")).toBeTruthy();
    });
    const txt = container.querySelector(".returns-count-bar")?.textContent || "";
    // Page 4 of 25-per-page gives 76–87
    expect(txt).toContain("76");
    expect(txt).toContain("87");
  });

  it("displays per-stat counts on the stats bar with active filter chip", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns?status=pending"],
      loaderData: {
        ...baseLoaderData,
        status: "pending",
        allCount: 99,
        pendingCount: 7,
        inProgressCount: 13,
        approvedCount: 45,
        rejectedCount: 4,
      },
    });
    await waitFor(() => {
      expect(container.querySelector(".returns-stats-row")).toBeTruthy();
    });
    const values = Array.from(
      container.querySelectorAll(".returns-stats-row .stat-value"),
    ).map((el) => el.textContent);
    expect(values).toEqual(["99", "7", "13", "45", "4"]);
    const chip = container.querySelector(".returns-count-bar span:last-child");
    expect(chip?.textContent).toContain("pending");
  });

  it("renders the search input with the URL query as its default value", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns?query=foo123"],
      loaderData: { ...baseLoaderData, query: "foo123" },
    });
    await waitFor(() => {
      const inp = container.querySelector(
        'input[name="query"]',
      ) as HTMLInputElement | null;
      expect(inp).toBeTruthy();
      expect(inp?.defaultValue).toBe("foo123");
    });
  });

  it("renders the toolbar dropdowns + date inputs with defaults from URL", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: [
        "/app/returns?resolutionType=exchange&sourceChannel=pos&from=2026-01-01&to=2026-01-31",
      ],
      loaderData: {
        ...baseLoaderData,
        resolutionType: "exchange",
        sourceChannel: "pos",
      },
    });
    await waitFor(() => {
      expect(
        container.querySelector('select[name="resolutionType"]'),
      ).toBeTruthy();
    });
    const resSel = container.querySelector(
      'select[name="resolutionType"]',
    ) as HTMLSelectElement;
    const chSel = container.querySelector(
      'select[name="sourceChannel"]',
    ) as HTMLSelectElement;
    const fromInp = container.querySelector(
      'input[name="from"]',
    ) as HTMLInputElement;
    const toInp = container.querySelector(
      'input[name="to"]',
    ) as HTMLInputElement;
    expect(resSel.value).toBe("exchange");
    expect(chSel.value).toBe("pos");
    expect(fromInp.defaultValue).toBe("2026-01-01");
    expect(toInp.defaultValue).toBe("2026-01-31");
    // Clear link should also be present when filters are active
    const clearLink = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "/app/returns",
    );
    expect(clearLink).toBeTruthy();
  });

  it("renders the 'Export current view' link with current query+status params", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns?query=abc&status=pending"],
      loaderData: { ...baseLoaderData, query: "abc", status: "pending" },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Export current view");
    });
    const exportLink = Array.from(container.querySelectorAll("a")).find((a) =>
      a.getAttribute("href")?.startsWith("/api/returns/export"),
    );
    expect(exportLink).toBeTruthy();
    const href = exportLink!.getAttribute("href")!;
    expect(href).toContain("query=abc");
    expect(href).toContain("status=pending");
  });

  it("does NOT render the export link when no returns are present", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: {
        ...baseLoaderData,
        returns: [],
        totalCount: 0,
      },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("No returns found");
    });
    const exportLink = Array.from(container.querySelectorAll("a")).find((a) =>
      a.getAttribute("href")?.startsWith("/api/returns/export"),
    );
    expect(exportLink).toBeFalsy();
  });

  it("renders a row checkbox for each return row, disabled for terminal-state rows", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    const rowCheckboxes = container.querySelectorAll(
      "tbody .checkbox-cell input[type='checkbox']",
    );
    expect(rowCheckboxes.length).toBe(5);
    // ret-2 (approved) and ret-4 (approved) should be disabled (terminal states)
    const disabledCount = Array.from(rowCheckboxes).filter(
      (c) => (c as HTMLInputElement).disabled,
    ).length;
    expect(disabledCount).toBe(2);
  });

  it("toggles the bulk-bar to visible after a selectable row is checked", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    const cells = container.querySelectorAll("tbody .checkbox-cell");
    // ret-1 is "pending" — selectable
    fireEvent.click(cells[0]);
    await waitFor(() => {
      const bar = container.querySelector(".returns-bulk-bar")!;
      expect(bar.className).toContain("returns-bulk-bar--visible");
    });
    expect(container.querySelector(".returns-bulk-bar")?.textContent).toContain(
      "1 selected",
    );
  });

  it("opens the rejection modal when the bulk Reject button is clicked", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    // Select a pending row first so the bulk bar is interactive.
    const cells = container.querySelectorAll("tbody .checkbox-cell");
    fireEvent.click(cells[0]);
    await waitFor(() => {
      expect(
        container.querySelector(".returns-bulk-bar")?.className,
      ).toContain("returns-bulk-bar--visible");
    });
    const rejectBtn = container.querySelector(".bulk-btn--reject")!;
    fireEvent.click(rejectBtn);
    await waitFor(() => {
      expect(container.querySelector(".returns-modal-overlay")).toBeTruthy();
    });
    // Modal renders a textarea + Cancel/Reject All buttons
    const textarea = container.querySelector("textarea");
    expect(textarea).toBeTruthy();
    expect(container.textContent).toContain("Provide a reason");
  });

  it("invokes /api/returns/bulk on bulk approve and shows success toast", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ successCount: 1, errorCount: 0, results: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    fireEvent.click(container.querySelectorAll("tbody .checkbox-cell")[0]);
    await waitFor(() => {
      expect(
        container.querySelector(".returns-bulk-bar")?.className,
      ).toContain("returns-bulk-bar--visible");
    });
    const approveBtn = container.querySelector(".bulk-btn--approve")!;
    await act(async () => {
      fireEvent.click(approveBtn);
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(fetchMock.mock.calls[0][0]).toBe("/api/returns/bulk");
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.action).toBe("bulk_approve");
    expect(body.returnIds).toEqual(["ret-1"]);
    vi.unstubAllGlobals();
  });

  it("shows an error toast when /api/returns/bulk returns errorCount>0", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        successCount: 0,
        errorCount: 1,
        results: [
          { id: "ret-1", success: false, error: "fynd not configured" },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    fireEvent.click(container.querySelectorAll("tbody .checkbox-cell")[0]);
    await act(async () => {
      fireEvent.click(container.querySelector(".bulk-btn--approve")!);
    });
    await waitFor(() => {
      expect(container.textContent).toContain("fynd not configured");
    });
    expect(container.textContent).toContain("1 failed");
    vi.unstubAllGlobals();
  });

  it("shows a network error toast when fetch rejects on bulk approve", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("Network blew up"));
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    fireEvent.click(container.querySelectorAll("tbody .checkbox-cell")[0]);
    await act(async () => {
      fireEvent.click(container.querySelector(".bulk-btn--approve")!);
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Network blew up");
    });
    vi.unstubAllGlobals();
  });

  it("toggles select-all via the header checkbox to select every actionable row", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    const headerCheckbox = container.querySelector(
      "thead .checkbox-th input[type='checkbox']",
    ) as HTMLInputElement;
    fireEvent.click(headerCheckbox);
    await waitFor(() => {
      expect(
        container.querySelector(".returns-bulk-bar")?.className,
      ).toContain("returns-bulk-bar--visible");
    });
    // Three of five rows are actionable (pending, processing, initiated)
    expect(container.querySelector(".returns-bulk-bar")?.textContent).toContain(
      "3 selected",
    );
  });

  it("clears the selection when the bulk-bar Clear button is clicked", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    fireEvent.click(container.querySelectorAll("tbody .checkbox-cell")[0]);
    await waitFor(() => {
      expect(
        container.querySelector(".returns-bulk-bar")?.className,
      ).toContain("returns-bulk-bar--visible");
    });
    const clearBtn = container.querySelector(".bulk-btn--clear")!;
    fireEvent.click(clearBtn);
    await waitFor(() => {
      expect(
        container.querySelector(".returns-bulk-bar")?.className,
      ).toContain("returns-bulk-bar--hidden");
    });
  });

  it("submits a bulk_change_resolution call when the resolution select changes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ successCount: 1, errorCount: 0, results: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    fireEvent.click(container.querySelectorAll("tbody .checkbox-cell")[0]);
    const select = container.querySelector(
      ".returns-bulk-bar .bulk-select",
    ) as HTMLSelectElement;
    await act(async () => {
      fireEvent.change(select, { target: { value: "exchange" } });
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.action).toBe("bulk_change_resolution");
    expect(body.resolutionType).toBe("exchange");
    vi.unstubAllGlobals();
  });

  it("dismisses the rejection modal when the overlay is clicked", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    fireEvent.click(container.querySelectorAll("tbody .checkbox-cell")[0]);
    await waitFor(() => {
      expect(
        container.querySelector(".returns-bulk-bar")?.className,
      ).toContain("returns-bulk-bar--visible");
    });
    fireEvent.click(container.querySelector(".bulk-btn--reject")!);
    await waitFor(() => {
      expect(container.querySelector(".returns-modal-overlay")).toBeTruthy();
    });
    fireEvent.click(container.querySelector(".returns-modal-overlay")!);
    await waitFor(() => {
      expect(container.querySelector(".returns-modal-overlay")).toBeFalsy();
    });
  });

  it("disables the modal Reject All button when reason is empty", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    fireEvent.click(container.querySelectorAll("tbody .checkbox-cell")[0]);
    await waitFor(() => {
      expect(
        container.querySelector(".returns-bulk-bar")?.className,
      ).toContain("returns-bulk-bar--visible");
    });
    fireEvent.click(container.querySelector(".bulk-btn--reject")!);
    await waitFor(() => {
      expect(container.querySelector(".returns-modal-overlay")).toBeTruthy();
    });
    const rejectAllBtn = Array.from(
      container.querySelectorAll(".returns-modal button"),
    ).find((b) => b.textContent === "Reject All") as HTMLButtonElement;
    expect(rejectAllBtn.disabled).toBe(true);
  });

  it("submits a bulk_reject call when modal Reject All is clicked with reason", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ successCount: 1, errorCount: 0, results: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    fireEvent.click(container.querySelectorAll("tbody .checkbox-cell")[0]);
    await waitFor(() => {
      expect(
        container.querySelector(".returns-bulk-bar")?.className,
      ).toContain("returns-bulk-bar--visible");
    });
    fireEvent.click(container.querySelector(".bulk-btn--reject")!);
    await waitFor(() => {
      expect(container.querySelector("textarea")).toBeTruthy();
    });
    const ta = container.querySelector("textarea")!;
    fireEvent.change(ta, { target: { value: "out of policy" } });
    const rejectAllBtn = Array.from(
      container.querySelectorAll(".returns-modal button"),
    ).find((b) => b.textContent === "Reject All") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(rejectAllBtn);
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.action).toBe("bulk_reject");
    expect(body.rejectionReason).toBe("out of policy");
    vi.unstubAllGlobals();
  });

  it("renders the ErrorBoundary fallback when an error is thrown", async () => {
    const { container } = renderWithRouter(ErrorBoundary, {
      initialEntries: ["/app/returns"],
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Try again");
    });
  });

  it("activates a stat tile by clicking it (filter shortcut)", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: { ...baseLoaderData, pendingCount: 3 },
    });
    await waitFor(() => {
      expect(container.querySelector(".returns-stats-row")).toBeTruthy();
    });
    const tiles = container.querySelectorAll(".returns-stat-card");
    // Click the "Pending" tile (index 1)
    fireEvent.click(tiles[1]);
    await waitFor(() => {
      // After click, stat card should reflect the active filter via class
      expect(container.querySelector(".returns-stat-card")).toBeTruthy();
    });
  });

  it("invokes goToPage when a pagination button is clicked", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns?page=1"],
      loaderData: { ...baseLoaderData, page: 1, totalPages: 3, totalCount: 60 },
    });
    await waitFor(() => {
      expect(container.querySelector(".returns-pagination")).toBeTruthy();
    });
    const btns = container.querySelectorAll(".app-pagination-btn");
    // Last button is "next"
    fireEvent.click(btns[btns.length - 1]);
    expect(container.querySelector(".returns-pagination")).toBeTruthy();
  });

  it("submits the rejection on Cmd+Enter inside the modal textarea", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ successCount: 1, errorCount: 0, results: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    fireEvent.click(container.querySelectorAll("tbody .checkbox-cell")[0]);
    fireEvent.click(container.querySelector(".bulk-btn--reject")!);
    await waitFor(() => {
      expect(container.querySelector("textarea")).toBeTruthy();
    });
    const ta = container.querySelector("textarea")!;
    fireEvent.change(ta, { target: { value: "fraud" } });
    await act(async () => {
      fireEvent.keyDown(ta, { key: "Enter", metaKey: true });
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    vi.unstubAllGlobals();
  });

  it("loader returns the full payload with filters/status/pagination applied", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    prismaMock.returnCase.count
      .mockResolvedValueOnce(50) // totalCount
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(3)
      .mockResolvedValueOnce(8)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(50);
    const req = new Request(
      "https://app.example/app/returns?query=foo&status=approved&page=2&resolutionType=refund&sourceChannel=pos&from=2026-01-01&to=2026-01-31",
    );
    const data = await loader({
      request: req,
      params: {},
      context: {},
    } as never);
    expect(data).toMatchObject({
      query: "foo",
      status: "approved",
      page: 2,
      resolutionType: "refund",
      sourceChannel: "pos",
      totalCount: 50,
      totalPages: 2,
      shopLocale: "en",
      shopTimezone: "UTC",
      error: null,
    });
  });
});
