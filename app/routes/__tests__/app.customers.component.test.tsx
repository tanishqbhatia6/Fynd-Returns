/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Mocks for module-top-level imports in app/routes/app.customers.tsx ──
// The route pulls in shopify.server / db.server / lib/* purely for the
// loader. Stub them so importing the component in jsdom doesn't crash on
// Node-only deps.
vi.mock("../../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../../db.server", () => ({
  default: {
    returnCase: {
      groupBy: vi.fn(),
      count: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));
vi.mock("../../lib/shop.server", () => ({
  findOrCreateShop: vi.fn(),
}));
vi.mock("../../lib/return-request-id", () => ({
  formatReturnRequestId: vi.fn((id: string) => `RR-${id}`),
}));
vi.mock("../../lib/status-colors", () => ({
  getStatusColor: vi.fn(() => "#6b7280"),
  getStatusBg: vi.fn(() => "#f3f4f6"),
}));
vi.mock("../../lib/shopify-admin.server", () => ({
  fetchOrdersForCustomer: vi.fn(async () => []),
}));

// AppPage shouldn't pull in embedded-Shopify host machinery during test —
// passthrough render the heading + children.
vi.mock("../../components/AppPage", () => ({
  AppPage: ({ heading, children }: { heading: string; children: React.ReactNode }) => (
    <div data-testid="app-page">
      <h1 data-testid="app-page-heading">{heading}</h1>
      {children}
    </div>
  ),
}));

import { renderWithRouter } from "../../test/component-helpers";
import { waitFor } from "@testing-library/react";
import CustomersPage from "../app.customers";

const baseLoaderData = {
  customers: [] as unknown[],
  totalCustomers: 0,
  totalReturns: 0,
  totalRefunded: 0,
  serialReturners: 0,
  page: 1,
  totalPages: 1,
  totalFilteredCustomers: 0,
  query: "",
  sortBy: "count",
  shopLocale: "en",
  shopCurrency: "USD",
  shopTimezone: "UTC",
};

describe("CustomersPage (default export) — empty state", () => {
  it("renders inside the AppPage wrapper with the Customers heading", async () => {
    const { findByTestId } = renderWithRouter(CustomersPage, {
      initialEntries: ["/app/customers"],
      loaderData: baseLoaderData,
    });
    const heading = await findByTestId("app-page-heading");
    expect(heading.textContent).toBe("Customers");
  });

  it("renders the search input with the customers placeholder", async () => {
    const { container } = renderWithRouter(CustomersPage, {
      initialEntries: ["/app/customers"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("input[aria-label='Search customers']")).toBeTruthy();
    });
    const input = container.querySelector("input[aria-label='Search customers']") as HTMLInputElement;
    expect(input.placeholder).toMatch(/search by name, email, phone/i);
  });

  it("shows the empty state when there are no customers", async () => {
    const { container } = renderWithRouter(CustomersPage, {
      initialEntries: ["/app/customers"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("No customer data yet");
    });
  });

  it("shows a query-specific empty state when a search yields no results", async () => {
    const { container } = renderWithRouter(CustomersPage, {
      initialEntries: ["/app/customers?q=alice"],
      loaderData: { ...baseLoaderData, query: "alice" },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("No customers found");
    });
    expect(container.textContent).toContain('No customers match "alice"');
  });

  it("renders the four summary stat cards", async () => {
    const { container } = renderWithRouter(CustomersPage, {
      initialEntries: ["/app/customers"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Total Customers");
    });
    expect(container.textContent).toContain("Total Returns");
    expect(container.textContent).toContain("Total Refunded");
    expect(container.textContent).toContain("Serial Returners");
  });

  it("renders all three sort buttons with the count sort active", async () => {
    const { container } = renderWithRouter(CustomersPage, {
      initialEntries: ["/app/customers"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelectorAll("button").length).toBeGreaterThan(0);
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const labels = buttons.map((b) => b.textContent?.trim());
    expect(labels).toEqual(
      expect.arrayContaining(["Most Returns", "Highest Refund", "Most Recent"]),
    );
  });

  it("does not render pagination controls when totalPages is 1", async () => {
    const { container, findByTestId } = renderWithRouter(CustomersPage, {
      initialEntries: ["/app/customers"],
      loaderData: baseLoaderData,
    });
    await findByTestId("app-page-heading");
    expect(container.querySelector(".returns-pagination")).toBeNull();
  });

  it("does not render the Clear button when there is no active query", async () => {
    const { container } = renderWithRouter(CustomersPage, {
      initialEntries: ["/app/customers"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelectorAll("button").length).toBeGreaterThan(0);
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const clear = buttons.find((b) => b.textContent?.trim() === "Clear");
    expect(clear).toBeFalsy();
  });
});
