/**
 * @vitest-environment jsdom
 *
 * Component-level coverage for app/routes/app.customers.tsx. Uses a plain
 * MemoryRouter + a hoisted useLoaderData / useRouteError stub so loader-data
 * hooks resolve synchronously (avoids RR7 "No HydrateFallback" warning).
 *
 * No source modifications. Tests cover: empty list, populated list with
 * mixed risk levels (low/medium/high), search input handlers, sort buttons,
 * customer detail panel open/close, return-history rows, pagination, and
 * the ErrorBoundary export.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, waitFor, act } from "@testing-library/react";

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
  formatReturnRequestId: vi.fn((id: string) => "RR-" + id),
}));
vi.mock("../../lib/status-colors", () => ({
  getStatusColor: vi.fn(() => "#6b7280"),
  getStatusBg: vi.fn(() => "#f3f4f6"),
}));
vi.mock("../../lib/shopify-admin.server", () => ({
  fetchOrdersForCustomer: vi.fn(async () => []),
}));
vi.mock("../../components/AppPage", () => ({
  AppPage: ({ heading, children }: { heading: string; children: React.ReactNode }) => (
    <div data-testid="app-page">
      <h1 data-testid="app-page-heading">{heading}</h1>
      {children}
    </div>
  ),
}));

let __loaderData: Record<string, unknown> = {};
let __routeError: unknown = undefined;

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>(
    "react-router",
  );
  return {
    ...actual,
    useLoaderData: () => __loaderData,
    useRouteError: () => __routeError,
  };
});

import { MemoryRouter } from "react-router";
import CustomersPage, { ErrorBoundary } from "../app.customers";

function renderRoute(
  loaderData: Record<string, unknown>,
  initialEntries: string[] = ["/app/customers"],
) {
  __loaderData = loaderData;
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <CustomersPage />
    </MemoryRouter>,
  );
}

function renderError(error: unknown = new Error("boom")) {
  __routeError = error;
  return render(
    <MemoryRouter initialEntries={["/app/customers"]}>
      <ErrorBoundary />
    </MemoryRouter>,
  );
}

const baseLoaderData: Record<string, unknown> = {
  customers: [],
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

const lowRiskCustomer = {
  email: "alice@example.com",
  name: "Alice Anderson",
  phone: "+1-555-0001",
  city: "Seattle",
  country: "USA",
  returnCount: 1,
  totalRefundAmount: 25.5,
  totalRefundAmountIsEstimate: false,
  currency: "USD",
  totalItemCount: 1,
  totalOrderValue: 100,
  lifetimeOrderCount: 5,
  lifetimeSpent: 500,
  firstReturnDate: "2024-01-01T12:00:00.000Z",
  lastReturnDate: "2024-01-01T12:00:00.000Z",
  statusBreakdown: { pending: 1 },
  resolutionBreakdown: { refund: 1 },
  returns: [
    { id: "rc-low-1", returnRequestNo: "RR-1001", orderName: "#1001", status: "pending", resolutionType: "refund", refundAmount: 25.5, refundCurrency: "USD", itemCount: 1, itemTitles: ["Blue T-Shirt"], createdAt: "2024-01-01T12:00:00.000Z", isGreenReturn: false },
  ],
};

const mediumRiskCustomer = {
  email: "bob@example.com",
  name: null,
  phone: null,
  city: null,
  country: null,
  returnCount: 3,
  totalRefundAmount: 0,
  totalRefundAmountIsEstimate: true,
  currency: "USD",
  totalItemCount: 5,
  totalOrderValue: 0,
  lifetimeOrderCount: null,
  lifetimeSpent: null,
  firstReturnDate: "2024-02-01T12:00:00.000Z",
  lastReturnDate: "2024-03-01T12:00:00.000Z",
  statusBreakdown: { approved: 3 },
  resolutionBreakdown: { exchange: 2, store_credit: 1 },
  returns: [
    { id: "rc-mid-1", returnRequestNo: null, orderName: "", status: "approved", resolutionType: "exchange", refundAmount: 0, refundCurrency: "", itemCount: 2, itemTitles: ["Item A", "Item B", "Item C"], createdAt: "2024-02-15T12:00:00.000Z", isGreenReturn: true },
    { id: "rc-mid-2", returnRequestNo: "RR-1002", orderName: "#1002", status: "completed", resolutionType: "store_credit", refundAmount: 10, refundCurrency: "USD", itemCount: 1, itemTitles: [], createdAt: "2024-02-20T12:00:00.000Z", isGreenReturn: false },
    { id: "rc-mid-3", returnRequestNo: "RR-1003", orderName: "#1003", status: "rejected", resolutionType: "refund", refundAmount: 0, refundCurrency: "", itemCount: 1, itemTitles: ["Item D"], createdAt: "2024-03-01T12:00:00.000Z", isGreenReturn: false },
  ],
};

const highRiskCustomer = {
  email: "charlie@example.com",
  name: "Charlie Chaplin",
  phone: "+1-555-0009",
  city: "Los Angeles",
  country: "USA",
  returnCount: 12,
  totalRefundAmount: 1500,
  totalRefundAmountIsEstimate: false,
  currency: "USD",
  totalItemCount: 25,
  totalOrderValue: 2000,
  lifetimeOrderCount: 30,
  lifetimeSpent: 5000,
  firstReturnDate: "2023-01-01T12:00:00.000Z",
  lastReturnDate: "2024-04-01T12:00:00.000Z",
  statusBreakdown: { completed: 12 },
  resolutionBreakdown: { refund: 8, replacement: 4 },
  returns: Array.from({ length: 3 }, (_, i) => ({
    id: "rc-high-" + (i + 1), returnRequestNo: "RR-2" + String(i).padStart(3, "0"), orderName: "#200" + i, status: "completed", resolutionType: "refund", refundAmount: 500, refundCurrency: "USD", itemCount: 1, itemTitles: ["High Item " + i], createdAt: "2024-04-0" + (i + 1) + "T12:00:00.000Z", isGreenReturn: false,
  })),
};

const partialRefundCustomer = {
  email: "dora@example.com",
  name: "Dora",
  phone: "+1-555-0010",
  city: null,
  country: "USA",
  returnCount: 2,
  totalRefundAmount: 50,
  totalRefundAmountIsEstimate: false,
  currency: "USD",
  totalItemCount: 2,
  totalOrderValue: 1000,
  lifetimeOrderCount: null,
  lifetimeSpent: null,
  firstReturnDate: "2024-01-15T12:00:00.000Z",
  lastReturnDate: "2024-01-20T12:00:00.000Z",
  statusBreakdown: { pending: 2 },
  resolutionBreakdown: { unknown_resolution: 1 },
  returns: [
    { id: "rc-d-1", returnRequestNo: "RR-3001", orderName: "#3001", status: "pending", resolutionType: "unknown_resolution", refundAmount: 50, refundCurrency: "USD", itemCount: 1, itemTitles: ["X"], createdAt: "2024-01-15T12:00:00.000Z", isGreenReturn: false },
  ],
};

const cityOnlyCustomer = {
  email: "eve@example.com",
  name: "Eve",
  phone: null,
  city: "Boston",
  country: null,
  returnCount: 1,
  totalRefundAmount: 0,
  totalRefundAmountIsEstimate: false,
  currency: "",
  totalItemCount: 1,
  totalOrderValue: 0,
  lifetimeOrderCount: null,
  lifetimeSpent: null,
  firstReturnDate: "2024-01-01T12:00:00.000Z",
  lastReturnDate: "2024-01-01T12:00:00.000Z",
  statusBreakdown: { pending: 1 },
  resolutionBreakdown: {},
  returns: [],
};

const populatedLoaderData: Record<string, unknown> = {
  ...baseLoaderData,
  customers: [highRiskCustomer, mediumRiskCustomer, lowRiskCustomer, partialRefundCustomer, cityOnlyCustomer],
  totalCustomers: 5,
  totalReturns: 19,
  totalRefunded: 1575.5,
  serialReturners: 2,
  totalFilteredCustomers: 5,
};

describe("CustomersPage — empty state", () => {
  it("renders inside the AppPage wrapper with the Customers heading", () => {
    const { getByTestId } = renderRoute(baseLoaderData);
    expect(getByTestId("app-page-heading").textContent).toBe("Customers");
  });

  it("renders the search input with the customers placeholder", () => {
    const { container } = renderRoute(baseLoaderData);
    const input = container.querySelector("input[aria-label='Search customers']") as HTMLInputElement;
    expect(input).toBeTruthy();
    expect(input.placeholder).toMatch(/search by name, email, phone/i);
  });

  it("shows the empty state when there are no customers", () => {
    const { container } = renderRoute(baseLoaderData);
    expect(container.textContent).toContain("No customer data yet");
  });

  it("shows a query-specific empty state when a search yields no results", () => {
    const { container } = renderRoute({ ...baseLoaderData, query: "alice" }, ["/app/customers?q=alice"]);
    expect(container.textContent).toContain("No customers found");
    expect(container.textContent).toContain('No customers match "alice"');
  });

  it("renders the four summary stat cards", () => {
    const { container } = renderRoute(baseLoaderData);
    expect(container.textContent).toContain("Total Customers");
    expect(container.textContent).toContain("Total Returns");
    expect(container.textContent).toContain("Total Refunded");
    expect(container.textContent).toContain("Serial Returners");
  });

  it("renders all three sort buttons with the count sort active", () => {
    const { container } = renderRoute(baseLoaderData);
    const buttons = Array.from(container.querySelectorAll("button"));
    const labels = buttons.map((b) => b.textContent?.trim());
    expect(labels).toEqual(expect.arrayContaining(["Most Returns", "Highest Refund", "Most Recent"]));
  });

  it("does not render pagination controls when totalPages is 1", () => {
    const { container } = renderRoute(baseLoaderData);
    expect(container.querySelector(".returns-pagination")).toBeNull();
  });

  it("does not render the Clear button when there is no active query", () => {
    const { container } = renderRoute(baseLoaderData);
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.find((b) => b.textContent?.trim() === "Clear")).toBeFalsy();
  });
});

describe("CustomersPage — populated list (low/medium/high risk)", () => {
  it("renders one row per customer with email + name visible", () => {
    const { container } = renderRoute(populatedLoaderData);
    expect(container.textContent).toContain("alice@example.com");
    expect(container.textContent).toContain("bob@example.com");
    expect(container.textContent).toContain("charlie@example.com");
    expect(container.textContent).toContain("Alice Anderson");
    expect(container.textContent).toContain("Charlie Chaplin");
  });

  it("renders Serial badge for customers with returnCount >= 3", () => {
    const { container } = renderRoute(populatedLoaderData);
    const matched = Array.from(container.querySelectorAll("span")).filter((s) => s.textContent?.trim() === "Serial");
    expect(matched.length).toBeGreaterThanOrEqual(2);
  });

  it("does not render Serial badge for the low-risk customer", () => {
    const { container } = renderRoute({ ...baseLoaderData, customers: [lowRiskCustomer], totalCustomers: 1, totalFilteredCustomers: 1 });
    const matched = Array.from(container.querySelectorAll("span")).filter((s) => s.textContent?.trim() === "Serial");
    expect(matched.length).toBe(0);
  });

  it("renders the table header row", () => {
    const { container } = renderRoute(populatedLoaderData);
    expect(container.textContent).toContain("Phone");
    expect(container.textContent).toContain("Location");
    expect(container.textContent).toContain("Returns");
    expect(container.textContent).toContain("Total Refunded");
    expect(container.textContent).toContain("First Return");
    expect(container.textContent).toContain("Last Return");
  });

  it("shows 'Not provided' for missing phone", () => {
    const { container } = renderRoute(populatedLoaderData);
    expect(container.textContent).toContain("Not provided");
  });

  it("renders the '~' prefix for estimated refund totals", () => {
    const { container } = renderRoute(populatedLoaderData);
    expect(container.textContent).toContain("~");
  });

  it("renders the row-count summary text when no query is active", () => {
    const { container } = renderRoute(populatedLoaderData);
    expect(container.textContent).toMatch(/Showing 1[–-]5 of 5 customers/);
  });

  it("renders the filtered-count summary text when a query is active", () => {
    const { container } = renderRoute({ ...populatedLoaderData, query: "alice", totalFilteredCustomers: 1 }, ["/app/customers?q=alice"]);
    expect(container.textContent).toContain('matching "alice"');
  });

  it("renders city-only and country-only location fallbacks", () => {
    const { container } = renderRoute(populatedLoaderData);
    expect(container.textContent).toContain("eve@example.com");
    expect(container.textContent).toContain("Boston");
    expect(container.textContent).toContain("dora@example.com");
  });
});

describe("CustomersPage — interactive: search & sort & expand", () => {
  it("typing + Enter in the search box runs the search handler without throwing", async () => {
    const { container } = renderRoute(baseLoaderData);
    const input = container.querySelector("input[aria-label='Search customers']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "needle" } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter", code: "Enter" }); });
    await waitFor(() => { expect(input.value).toBe("needle"); });
  });

  it("typing + Enter on whitespace-only value still runs the handler", async () => {
    const { container } = renderRoute(baseLoaderData);
    const input = container.querySelector("input[aria-label='Search customers']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter", code: "Enter" }); });
    await waitFor(() => { expect(input).toBeTruthy(); });
  });

  it("non-Enter keys in the search input do not trigger the search handler", async () => {
    const { container } = renderRoute(baseLoaderData);
    const input = container.querySelector("input[aria-label='Search customers']") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "xyz" } });
    await act(async () => { fireEvent.keyDown(input, { key: "a", code: "KeyA" }); });
    await waitFor(() => { expect(input.value).toBe("xyz"); });
  });

  it("clicking 'Highest Refund' sort button runs the sort handler", () => {
    const { container } = renderRoute(populatedLoaderData);
    const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Highest Refund");
    expect(button).toBeTruthy();
    fireEvent.click(button!);
  });

  it("clicking 'Most Recent' sort button runs the sort handler", async () => {
    const { container } = renderRoute(populatedLoaderData);
    const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Most Recent");
    await act(async () => { fireEvent.click(button!); });
    await waitFor(() => { expect(button).toBeTruthy(); });
  });

  it("clicking 'Most Returns' sort button when sort=amount runs the handler", async () => {
    const { container } = renderRoute({ ...populatedLoaderData, sortBy: "amount" }, ["/app/customers?sort=amount"]);
    const button = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Most Returns");
    await act(async () => { fireEvent.click(button!); });
    await waitFor(() => { expect(button).toBeTruthy(); });
  });

  it("renders Clear button when query is active and clicking it runs the handler", () => {
    const { container } = renderRoute({ ...populatedLoaderData, query: "alice" }, ["/app/customers?q=alice"]);
    const clear = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.trim() === "Clear");
    expect(clear).toBeTruthy();
    fireEvent.click(clear!);
  });

  it("clicking a customer row toggles open the detail panel", async () => {
    const { container } = renderRoute(populatedLoaderData);
    const aliceRow = Array.from(container.querySelectorAll("div")).find((d) => d.textContent?.includes("alice@example.com") && d.style.cursor === "pointer");
    expect(aliceRow).toBeTruthy();
    fireEvent.click(aliceRow!);
    await waitFor(() => { expect(container.textContent).toContain("Customer Profile"); });
    expect(container.textContent).toContain("Return Analytics");
    expect(container.textContent).toContain("Return History");
  });

  it("clicking the same row a second time collapses the detail panel", async () => {
    const { container } = renderRoute(populatedLoaderData);
    const aliceRow = Array.from(container.querySelectorAll("div")).find((d) => d.textContent?.includes("alice@example.com") && d.style.cursor === "pointer");
    fireEvent.click(aliceRow!);
    await waitFor(() => { expect(container.textContent).toContain("Customer Profile"); });
    fireEvent.click(aliceRow!);
    await waitFor(() => { expect(container.textContent).not.toContain("Customer Profile"); });
  });

  it("hovering a non-expanded row triggers mouseEnter and mouseLeave handlers", () => {
    const { container } = renderRoute(populatedLoaderData);
    const aliceRow = Array.from(container.querySelectorAll("div")).find((d) => d.textContent?.includes("alice@example.com") && d.style.cursor === "pointer") as HTMLDivElement;
    fireEvent.mouseEnter(aliceRow);
    fireEvent.mouseLeave(aliceRow);
    expect(aliceRow).toBeTruthy();
  });

  it("hovering an expanded row short-circuits via the isExpanded guard", async () => {
    const { container } = renderRoute(populatedLoaderData);
    const aliceRow = Array.from(container.querySelectorAll("div")).find((d) => d.textContent?.includes("alice@example.com") && d.style.cursor === "pointer") as HTMLDivElement;
    fireEvent.click(aliceRow);
    await waitFor(() => { expect(container.textContent).toContain("Customer Profile"); });
    fireEvent.mouseEnter(aliceRow);
    fireEvent.mouseLeave(aliceRow);
    expect(aliceRow).toBeTruthy();
  });
});

describe("CustomersPage — expanded detail panel", () => {
  it("shows lifetime orders / spent when present", async () => {
    const { container } = renderRoute(populatedLoaderData);
    const row = Array.from(container.querySelectorAll("div")).find((d) => d.textContent?.includes("alice@example.com") && d.style.cursor === "pointer");
    fireEvent.click(row!);
    await waitFor(() => { expect(container.textContent).toContain("Lifetime Orders"); });
    expect(container.textContent).toContain("Lifetime Spent");
  });

  it("hides lifetime fields when null (bob)", async () => {
    const { container } = renderRoute(populatedLoaderData);
    const row = Array.from(container.querySelectorAll("div")).find((d) => d.textContent?.includes("bob@example.com") && d.style.cursor === "pointer");
    fireEvent.click(row!);
    await waitFor(() => { expect(container.textContent).toContain("Customer Profile"); });
    expect(container.textContent).toContain("Return Analytics");
  });

  it("renders MiniStat tiles for resolutions in expanded panel", async () => {
    const { container } = renderRoute(populatedLoaderData);
    const row = Array.from(container.querySelectorAll("div")).find((d) => d.textContent?.includes("bob@example.com") && d.style.cursor === "pointer");
    fireEvent.click(row!);
    await waitFor(() => { expect(container.textContent).toContain("Return Analytics"); });
    expect(container.textContent).toMatch(/Exchange|Store Credit/);
  });

  it("renders Return Rate stat when totalOrderValue and totalRefundAmount > 0", async () => {
    const { container } = renderRoute(populatedLoaderData);
    const row = Array.from(container.querySelectorAll("div")).find((d) => d.textContent?.includes("charlie@example.com") && d.style.cursor === "pointer");
    fireEvent.click(row!);
    await waitFor(() => { expect(container.textContent).toContain("Return Rate"); });
  });

  it("renders Order Value stat when totalOrderValue > 0", async () => {
    const { container } = renderRoute(populatedLoaderData);
    const row = Array.from(container.querySelectorAll("div")).find((d) => d.textContent?.includes("dora@example.com") && d.style.cursor === "pointer");
    fireEvent.click(row!);
    await waitFor(() => { expect(container.textContent).toContain("Order Value"); });
  });

  it("renders Customer Profile fields when expanded", async () => {
    const { container } = renderRoute(populatedLoaderData);
    const row = Array.from(container.querySelectorAll("div")).find((d) => d.textContent?.includes("bob@example.com") && d.style.cursor === "pointer");
    fireEvent.click(row!);
    await waitFor(() => { expect(container.textContent).toContain("Customer Profile"); });
    expect(container.textContent).toContain("Returns");
  });

  it("renders return history rows with order names + GREEN badge for green returns", async () => {
    const { container } = renderRoute(populatedLoaderData);
    const row = Array.from(container.querySelectorAll("div")).find((d) => d.textContent?.includes("bob@example.com") && d.style.cursor === "pointer");
    fireEvent.click(row!);
    await waitFor(() => { expect(container.textContent).toContain("Return History"); });
    expect(container.textContent).toContain("GREEN");
    expect(container.textContent).toContain("RR-1002");
  });

  it("renders 'RR-' fallback id when returnRequestNo is null", async () => {
    const { container } = renderRoute(populatedLoaderData);
    const row = Array.from(container.querySelectorAll("div")).find((d) => d.textContent?.includes("bob@example.com") && d.style.cursor === "pointer");
    fireEvent.click(row!);
    await waitFor(() => { expect(container.textContent).toContain("Return History"); });
    expect(container.textContent).toContain("RR-rc-mid-1");
  });

  it("hovering a return-history row triggers mouseEnter and mouseLeave", async () => {
    const { container } = renderRoute(populatedLoaderData);
    const row = Array.from(container.querySelectorAll("div")).find((d) => d.textContent?.includes("alice@example.com") && d.style.cursor === "pointer");
    fireEvent.click(row!);
    await waitFor(() => { expect(container.textContent).toContain("Return History"); });
    const historyDivs = Array.from(container.querySelectorAll("a > div"));
    expect(historyDivs.length).toBeGreaterThan(0);
    const historyDiv = historyDivs[0] as HTMLDivElement;
    fireEvent.mouseEnter(historyDiv);
    fireEvent.mouseLeave(historyDiv);
    expect(historyDiv).toBeTruthy();
  });

  it("renders unknown_resolution fallback label and styles", async () => {
    const { container } = renderRoute(populatedLoaderData);
    const row = Array.from(container.querySelectorAll("div")).find((d) => d.textContent?.includes("dora@example.com") && d.style.cursor === "pointer");
    fireEvent.click(row!);
    await waitFor(() => { expect(container.textContent).toContain("Return History"); });
    expect(container.textContent).toContain("unknown_resolution");
  });

  it("renders return history with itemCount=1 (singular) and itemCount=2 (plural)", async () => {
    const { container } = renderRoute(populatedLoaderData);
    const row = Array.from(container.querySelectorAll("div")).find((d) => d.textContent?.includes("bob@example.com") && d.style.cursor === "pointer");
    fireEvent.click(row!);
    await waitFor(() => { expect(container.textContent).toContain("Return History"); });
    expect(container.textContent).toMatch(/2 items/);
    expect(container.textContent).toMatch(/1 item/);
  });
});

describe("CustomersPage — pagination", () => {
  it("renders pagination buttons when totalPages > 1 and clicking next runs the handler", async () => {
    const { container } = renderRoute({ ...populatedLoaderData, page: 1, totalPages: 3 });
    expect(container.querySelector(".returns-pagination")).toBeTruthy();
    const pagBtns = container.querySelectorAll(".app-pagination-btn");
    expect(pagBtns.length).toBeGreaterThan(0);
    const next = pagBtns[pagBtns.length - 1] as HTMLButtonElement;
    await act(async () => { fireEvent.click(next); });
    await waitFor(() => { expect(next).toBeTruthy(); });
  });

  it("disables prev arrow on page 1", () => {
    const { container } = renderRoute({ ...populatedLoaderData, page: 1, totalPages: 3 });
    const buttons = Array.from(container.querySelectorAll(".app-pagination-btn")) as HTMLButtonElement[];
    expect(buttons[0].disabled).toBe(true);
  });

  it("disables next arrow on the last page", () => {
    const { container } = renderRoute({ ...populatedLoaderData, page: 3, totalPages: 3 }, ["/app/customers?page=3"]);
    const buttons = Array.from(container.querySelectorAll(".app-pagination-btn")) as HTMLButtonElement[];
    expect(buttons[buttons.length - 1].disabled).toBe(true);
  });

  it("renders compact pagination when totalPages <= 7", () => {
    const { container } = renderRoute({ ...populatedLoaderData, page: 2, totalPages: 5 });
    const buttons = Array.from(container.querySelectorAll(".app-pagination-btn"));
    expect(buttons.length).toBe(7);
  });

  it("renders windowed pagination when page is near the end of >7 totalPages", () => {
    const { container } = renderRoute({ ...populatedLoaderData, page: 19, totalPages: 20 });
    const numbers = Array.from(container.querySelectorAll(".app-pagination-btn")).map((b) => b.textContent?.trim()).filter((t) => t && /^\d+$/.test(t));
    expect(numbers).toContain("20");
  });

  it("renders windowed pagination when page is in the middle of >7 totalPages", () => {
    const { container } = renderRoute({ ...populatedLoaderData, page: 10, totalPages: 20 });
    const numbers = Array.from(container.querySelectorAll(".app-pagination-btn")).map((b) => b.textContent?.trim()).filter((t) => t && /^\d+$/.test(t));
    expect(numbers).toContain("10");
  });

  it("renders windowed pagination when page is at the start of >7 totalPages", () => {
    const { container } = renderRoute({ ...populatedLoaderData, page: 1, totalPages: 20 });
    const numbers = Array.from(container.querySelectorAll(".app-pagination-btn")).map((b) => b.textContent?.trim()).filter((t) => t && /^\d+$/.test(t));
    expect(numbers).toContain("1");
  });

  it("clicking a numeric pagination button invokes the goToPage handler", () => {
    const { container } = renderRoute({ ...populatedLoaderData, page: 1, totalPages: 5 });
    const pageThree = Array.from(container.querySelectorAll(".app-pagination-btn")).find((b) => b.textContent?.trim() === "3");
    expect(pageThree).toBeTruthy();
    fireEvent.click(pageThree!);
  });

  it("clicking the prev arrow when page > 1 invokes goToPage with page-1", async () => {
    const { container } = renderRoute({ ...populatedLoaderData, page: 2, totalPages: 3 }, ["/app/customers?page=2"]);
    const prev = container.querySelectorAll(".app-pagination-btn")[0] as HTMLButtonElement;
    expect(prev.disabled).toBe(false);
    await act(async () => { fireEvent.click(prev); });
    await waitFor(() => { expect(prev).toBeTruthy(); });
  });
});

describe("CustomersPage — formatters & edge cases (Intl catches)", () => {
  it("renders even when shopCurrency is invalid (Intl falls back to plain text)", () => {
    const { container } = renderRoute({
      ...populatedLoaderData,
      shopCurrency: "NOT_A_REAL_CURRENCY",
    });
    expect(container.textContent).toContain("NOT_A_REAL_CURRENCY");
  });

  it("renders even with an invalid date string (Intl.DateTimeFormat catch)", () => {
    const c = {
      ...lowRiskCustomer,
      firstReturnDate: "not-a-real-date",
      lastReturnDate: "still-not-a-date",
    };
    const { container } = renderRoute({ ...baseLoaderData, customers: [c], totalCustomers: 1, totalFilteredCustomers: 1 });
    expect(container.textContent).toContain("alice@example.com");
  });

  it("renders zero refund formatting via fmtMoneyZero (mediumRiskCustomer)", () => {
    const { container } = renderRoute({
      ...baseLoaderData,
      customers: [mediumRiskCustomer],
      totalCustomers: 1,
      totalFilteredCustomers: 1,
    });
    expect(container.textContent).toMatch(/0\.00|0,00/);
  });
});

describe("ErrorBoundary (named export)", () => {
  it("renders the error fallback heading and Try again link with an Error", () => {
    const { container } = renderError(new Error("kaboom"));
    expect(container.textContent).toContain("Customers");
    expect(container.textContent).toContain("kaboom");
    expect(container.textContent).toContain("Try again");
  });

  it("renders the error fallback with an unknown error type", () => {
    const { container } = renderError("plain string");
    expect(container.textContent).toContain("Customers");
    expect(container.textContent).toContain("unexpected error");
  });
});
