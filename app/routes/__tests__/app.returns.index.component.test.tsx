/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Mocks for module-top-level imports in app/routes/app.returns._index.tsx ──
vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));

vi.mock("../db.server", () => ({
  default: {
    shop: { findUnique: vi.fn(), create: vi.fn() },
    returnCase: { findMany: vi.fn(), count: vi.fn() },
  },
}));

// boundary helpers used by the server entry — stub for safety against
// transitive module evaluation.
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

import { renderWithRouter } from "../../test/component-helpers";
import { waitFor } from "@testing-library/react";
import ReturnsList from "../app.returns._index";

const baseLoaderData = {
  returns: [],
  query: "",
  status: "",
  page: 1,
  totalCount: 0,
  totalPages: 1,
  pendingCount: 0,
  inProgressCount: 0,
  approvedCount: 0,
  rejectedCount: 0,
  allCount: 0,
  error: null,
  shopLocale: "en",
  shopTimezone: "UTC",
};

describe("ReturnsList (default export)", () => {
  it("renders the 'Returns' heading", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Returns");
    });
  });

  it("renders all five stats tiles with their labels", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector(".returns-stats-row")).toBeTruthy();
    });
    const labels = Array.from(
      container.querySelectorAll(".returns-stats-row .stat-label"),
    ).map((el) => el.textContent?.trim());
    expect(labels).toEqual(["Total", "Pending", "In Progress", "Approved", "Rejected"]);
  });

  it("renders the search form with query input and status select", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("form.returns-toolbar")).toBeTruthy();
    });
    const queryInput = container.querySelector("input[name='query']");
    const statusSelect = container.querySelector("select[name='status']");
    expect(queryInput).toBeTruthy();
    expect(statusSelect).toBeTruthy();
    // Search submit button
    const submitBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.getAttribute("type") === "submit" && b.textContent?.trim() === "Search",
    );
    expect(submitBtn).toBeTruthy();
  });

  it("renders the empty state when there are no returns", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector(".returns-empty-state")).toBeTruthy();
    });
    expect(container.textContent).toContain("No returns found");
  });

  it("renders the status legend with all statuses", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector(".returns-legend")).toBeTruthy();
    });
    const legendLabels = Array.from(
      container.querySelectorAll(".returns-legend .returns-legend-label"),
    ).map((el) => el.textContent?.trim());
    expect(legendLabels).toEqual(
      expect.arrayContaining([
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

  it("renders the 'Create Return' link to the create route", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("form.returns-toolbar")).toBeTruthy();
    });
    const createLink = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "/app/returns/create",
    );
    expect(createLink).toBeTruthy();
    expect(createLink?.textContent).toContain("Create Return");
  });

  it("does not render an error banner when error is null", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector(".returns-stats-row")).toBeTruthy();
    });
    // No "Try refreshing the page." copy when error is null
    expect(container.textContent).not.toContain("Try refreshing the page.");
  });

  it("renders an error banner when loader data includes an error", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: { ...baseLoaderData, error: "Failed to load returns. Please try again." },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Failed to load returns. Please try again.");
    });
    expect(container.textContent).toContain("Try refreshing the page.");
  });
});
