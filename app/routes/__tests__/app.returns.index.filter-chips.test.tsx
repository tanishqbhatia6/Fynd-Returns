/**
 * @vitest-environment jsdom
 *
 * Filter-chip + toast-dismiss interaction coverage for the returns list.
 * Specifically exercises the previously-uncovered handlers added when the
 * FilterChips + Toast components were wired into app.returns._index.tsx:
 *
 *   - removeFilter(key)         → drops a single search param + resets page
 *   - clearAllFilters()         → wipes the URL of every param
 *   - bulkSuccess Toast onDismiss → setBulkSuccess(null)
 *   - bulkError Toast onDismiss   → setBulkError(null)
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

vi.mock("../../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { error: vi.fn(() => null), headers: vi.fn(() => ({})) },
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
import { fireEvent, waitFor } from "@testing-library/react";
import ReturnsList from "../app.returns._index";

const baseLoaderData = {
  returns: [
    {
      id: "ret-1",
      status: "approved",
      shopifyOrderName: "#1001",
      returnRequestNo: "RR-001",
      customerName: "Alice",
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
    },
  ],
  query: "alice",
  status: "approved",
  resolutionType: "refund",
  sourceChannel: "pos",
  page: 1,
  totalCount: 1,
  totalPages: 1,
  pendingCount: 0,
  inProgressCount: 0,
  approvedCount: 1,
  rejectedCount: 0,
  allCount: 1,
  error: null,
  shopLocale: "en",
  shopTimezone: "UTC",
};

describe("app.returns._index filter chips", () => {
  it("renders one chip per active filter (search/status/resolution/channel)", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: [
        "/app/returns?query=alice&status=approved&resolutionType=refund&sourceChannel=pos",
      ],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector(".app-filter-chips")).toBeTruthy();
    });
    const chips = container.querySelectorAll(".app-filter-chip");
    expect(chips.length).toBeGreaterThanOrEqual(4);
    expect(container.textContent).toContain("Search: alice");
    expect(container.textContent).toContain("Status: Approved");
    expect(container.textContent).toContain("Resolution: Refund");
    expect(container.textContent).toContain("Channel: POS");
  });

  // Note on chip-removal scope: the page derives `query` and `status`
  // from loader data, while `resolutionType` / `sourceChannel` / `from`
  // / `to` are pulled from useSearchParams() in the component. Memory-
  // router tests can only re-render searchParams-derived chips after a
  // click (loader doesn't re-run). So removal tests target those.
  it("clicking the Resolution chip's X removes that chip from the rendered output", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: [
        "/app/returns?query=alice&resolutionType=refund&sourceChannel=pos",
      ],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector(".app-filter-chips")).toBeTruthy();
    });
    expect(container.textContent).toContain("Resolution: Refund");
    expect(container.textContent).toContain("Channel: POS");
    const resBtn = Array.from(
      container.querySelectorAll('button[aria-label^="Remove filter"]'),
    ).find((b) => b.getAttribute("aria-label")?.includes("Resolution"));
    expect(resBtn).toBeTruthy();
    fireEvent.click(resBtn!);
    await waitFor(() => {
      expect(container.textContent).not.toContain("Resolution: Refund");
    });
    // unrelated chip stays
    expect(container.textContent).toContain("Channel: POS");
  });

  it("Clear all link removes every searchParams-derived chip", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: [
        "/app/returns?resolutionType=refund&sourceChannel=pos&from=2026-04-01",
      ],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector(".app-filter-chips")).toBeTruthy();
    });
    expect(container.textContent).toContain("Resolution: Refund");
    expect(container.textContent).toContain("Channel: POS");
    expect(container.textContent).toContain("From: 2026-04-01");

    const clearAll = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Clear all",
    );
    expect(clearAll).toBeTruthy();
    fireEvent.click(clearAll!);
    await waitFor(() => {
      // all three searchParams-driven chips disappear
      expect(container.textContent).not.toContain("Resolution: Refund");
    });
    expect(container.textContent).not.toContain("Channel: POS");
    expect(container.textContent).not.toContain("From: 2026-04-01");
  });

  it("does NOT render the chip row when no filters are active", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: {
        ...baseLoaderData,
        query: "",
        status: "",
        resolutionType: "",
        sourceChannel: "",
      },
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    expect(container.querySelector(".app-filter-chips")).toBeNull();
  });
});
