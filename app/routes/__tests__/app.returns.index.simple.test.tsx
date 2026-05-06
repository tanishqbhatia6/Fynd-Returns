/**
 * @vitest-environment jsdom
 *
 * Simple list-rendering coverage for app/routes/app.returns._index.tsx.
 * Asserts presence of text/elements only — no interactions, no navigation.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// Stub the Shopify auth module — the route imports `authenticate` for its
// loader, but the default export still pulls the file in at module-load.
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

// Prisma is only used by the loader. Stub so the route module imports cleanly.
vi.mock("../../db.server", () => ({ default: {} }));

import { renderWithRouter } from "../../test/component-helpers";
import { waitFor } from "@testing-library/react";
import ReturnsList from "../app.returns._index";

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

const variedReturns: ReturnRow[] = [
  mkReturn({
    id: "ret-1",
    status: "pending",
    shopifyOrderName: "#1001",
    returnRequestNo: "RR-001",
    customerName: "Alice Smith",
    resolutionType: "refund",
    refundAmount: 50,
    sourceChannel: null,
  }),
  mkReturn({
    id: "ret-2",
    status: "approved",
    shopifyOrderName: "#1002",
    returnRequestNo: "RR-002",
    customerName: "Bob Jones",
    customerEmailNorm: "bob@example.com",
    resolutionType: "exchange",
    refundAmount: 120,
    sourceChannel: "pos",
    fraudRiskLevel: "high",
  }),
  mkReturn({
    id: "ret-3",
    status: "rejected",
    shopifyOrderName: "#1003",
    returnRequestNo: "RR-003",
    customerName: "Carol Lee",
    resolutionType: "store_credit",
    refundAmount: 25,
    sourceChannel: "draft_order",
    fraudRiskLevel: "critical",
    fyndOrderId: "FYND-ORD-9001",
    fyndReturnNo: "FYND-RET-001",
  }),
  mkReturn({
    id: "ret-4",
    status: "processing",
    shopifyOrderName: "#1004",
    returnRequestNo: "RR-004",
    customerName: "David Kim",
    resolutionType: "replacement",
    refundAmount: 75,
    sourceChannel: "b2b",
    fyndSyncStatus: "synced",
    forwardAwb: "AWB-FWD-100",
  }),
  mkReturn({
    id: "ret-5",
    status: "completed",
    shopifyOrderName: "#1005",
    returnRequestNo: "RR-005",
    customerName: "Eve Patel",
    resolutionType: "refund",
    refundStatus: "refunded",
    refundAmount: 200,
    sourceChannel: null,
    isGiftReturn: true,
  }),
];

const baseLoaderData = {
  returns: variedReturns,
  query: "",
  status: "",
  resolutionType: "",
  sourceChannel: "",
  page: 1,
  totalCount: variedReturns.length,
  totalPages: 1,
  pendingCount: 1,
  inProgressCount: 1,
  approvedCount: 2,
  rejectedCount: 1,
  allCount: 5,
  error: null,
  shopLocale: "en",
  shopTimezone: "UTC",
};

describe("app.returns._index list rendering (simple)", () => {
  it("renders the 'Returns' page heading", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      const h1 = container.querySelector("h1");
      expect(h1?.textContent).toBe("Returns");
    });
  });

  it("renders the empty state when no returns are present", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: {
        ...baseLoaderData,
        returns: [],
        totalCount: 0,
        allCount: 0,
        pendingCount: 0,
        inProgressCount: 0,
        approvedCount: 0,
        rejectedCount: 0,
      },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("No returns found");
    });
    // Empty CTA should be visible
    expect(container.textContent).toContain("View Portal");
  });

  it("renders a row per return with the return request number", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    const tbody = container.querySelector("table.returns-table tbody");
    expect(tbody?.querySelectorAll("tr").length).toBe(5);
    expect(container.textContent).toContain("RR-001");
    expect(container.textContent).toContain("RR-005");
  });

  it("renders status pills for every row", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      const badges = container.querySelectorAll(".returns-status-badge");
      expect(badges.length).toBe(5);
    });
    const txt = container.textContent || "";
    expect(txt).toContain("pending");
    expect(txt).toContain("approved");
    expect(txt).toContain("rejected");
    expect(txt).toContain("processing");
    expect(txt).toContain("completed");
  });

  it("renders resolution-type badges for every resolution variant", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      const pills = container.querySelectorAll(".returns-res-pill");
      expect(pills.length).toBeGreaterThanOrEqual(5);
    });
    const txt = container.textContent || "";
    expect(txt).toContain("refund");
    expect(txt).toContain("exchange");
    expect(txt).toContain("store credit");
    expect(txt).toContain("replacement");
  });

  it("renders fraud-risk indicators for high/critical rows", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    const fraudDots = container.querySelectorAll('[title$="fraud risk"]');
    expect(fraudDots.length).toBe(2);
    const titles = Array.from(fraudDots).map((el) => el.getAttribute("title"));
    expect(titles).toEqual(
      expect.arrayContaining(["high fraud risk", "critical fraud risk"]),
    );
  });

  it("renders channel tags for non-web rows (POS/DRAFT/B2B)", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      const tags = container.querySelectorAll(".returns-channel-tag");
      expect(tags.length).toBe(3);
    });
    const tagTexts = Array.from(
      container.querySelectorAll(".returns-channel-tag"),
    ).map((el) => el.textContent);
    expect(tagTexts).toEqual(expect.arrayContaining(["POS", "DRAFT", "B2B"]));
  });

  it("renders customer-name column values for each row", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    const txt = container.textContent || "";
    expect(txt).toContain("Alice Smith");
    expect(txt).toContain("Bob Jones");
    expect(txt).toContain("Carol Lee");
    expect(txt).toContain("David Kim");
    expect(txt).toContain("Eve Patel");
  });

  it("renders the order-name (#1001…#1005) column for each row", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    const orderCells = container.querySelectorAll(".order-name");
    const orderTxts = Array.from(orderCells).map((el) => el.textContent);
    expect(orderTxts).toEqual(
      expect.arrayContaining(["#1001", "#1002", "#1003", "#1004", "#1005"]),
    );
  });

  it("renders the refund-status tag when refund has settled", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    // Eve's row has refundStatus="refunded" (not "none") so the tag shows.
    const refundTags = container.querySelectorAll(".returns-refund-tag");
    expect(refundTags.length).toBeGreaterThan(0);
    expect(container.textContent).toContain("refunded");
  });

  it("renders the next-page pagination button when totalPages > 1", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: { ...baseLoaderData, totalPages: 3, totalCount: 60 },
    });
    await waitFor(() => {
      expect(container.querySelector(".returns-pagination")).toBeTruthy();
    });
    // Three numbered buttons + prev + next = at least 5
    const pageBtns = container.querySelectorAll(".app-pagination-btn");
    expect(pageBtns.length).toBeGreaterThanOrEqual(5);
  });

  it("renders the status filter dropdown with all status options", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      const sel = container.querySelector(
        'select[name="status"]',
      ) as HTMLSelectElement | null;
      expect(sel).toBeTruthy();
    });
    const sel = container.querySelector(
      'select[name="status"]',
    ) as HTMLSelectElement;
    const optionValues = Array.from(sel.querySelectorAll("option")).map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(optionValues).toEqual(
      expect.arrayContaining([
        "",
        "initiated",
        "pending",
        "processing",
        "approved",
        "completed",
        "rejected",
        "cancelled",
      ]),
    );
  });

  it("renders the resolution-type filter dropdown", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      const sel = container.querySelector(
        'select[name="resolutionType"]',
      ) as HTMLSelectElement | null;
      expect(sel).toBeTruthy();
    });
    const sel = container.querySelector(
      'select[name="resolutionType"]',
    ) as HTMLSelectElement;
    const optionValues = Array.from(sel.querySelectorAll("option")).map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(optionValues).toEqual(
      expect.arrayContaining([
        "",
        "refund",
        "exchange",
        "store_credit",
        "replacement",
      ]),
    );
  });

  it("renders the channel/source filter dropdown", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      const sel = container.querySelector(
        'select[name="sourceChannel"]',
      ) as HTMLSelectElement | null;
      expect(sel).toBeTruthy();
    });
    const sel = container.querySelector(
      'select[name="sourceChannel"]',
    ) as HTMLSelectElement;
    const optionValues = Array.from(sel.querySelectorAll("option")).map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(optionValues).toEqual(
      expect.arrayContaining(["", "web", "pos", "draft_order", "b2b"]),
    );
  });

  it("renders the search query input with the right name", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      const input = container.querySelector(
        'input[name="query"]',
      ) as HTMLInputElement | null;
      expect(input).toBeTruthy();
      expect(input?.type).toBe("text");
    });
  });

  it("renders the gift-return label for gift-flagged rows", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    expect(container.textContent).toContain("GIFT");
  });

  it("renders the stats bar with all five tile labels", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector(".returns-stats-row")).toBeTruthy();
    });
    const txt = container.textContent || "";
    expect(txt).toContain("Total");
    expect(txt).toContain("Pending");
    expect(txt).toContain("In Progress");
    expect(txt).toContain("Approved");
    expect(txt).toContain("Rejected");
  });
});
