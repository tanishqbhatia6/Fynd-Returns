/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Mocks for module-top-level imports in app/routes/app.reports.tsx ──
// The route's loader pulls in shopify.server / db.server purely for server-side
// data fetching; stub them so importing the component in jsdom doesn't crash
// on Node-only deps.
vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../db.server", () => ({
  default: {
    shop: { findUnique: vi.fn(), create: vi.fn() },
    returnCase: { count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
    returnItem: { count: vi.fn(), groupBy: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

// boundary helpers from the server entry — stub for safety against
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

// Recharts is a heavy SVG library that does not render cleanly under jsdom
// (no layout, no measured dimensions for ResponsiveContainer). Replace with
// passthrough stubs so chart sections render as benign <div>s and the rest
// of the page can be asserted against. We only stub the symbols actually
// imported by the route.
vi.mock("recharts", () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="recharts-stub">{children}</div>
  );
  const Leaf = () => <div data-testid="recharts-leaf" />;
  return {
    AreaChart: Pass,
    Area: Leaf,
    XAxis: Leaf,
    YAxis: Leaf,
    CartesianGrid: Leaf,
    Tooltip: Leaf,
    ResponsiveContainer: Pass,
    PieChart: Pass,
    Pie: Pass,
    Cell: Leaf,
  };
});

import { renderWithRouter } from "../../test/component-helpers";
import { waitFor } from "@testing-library/react";
import Reports from "../app.reports";

// Empty-state shape — every numeric metric is 0 / every list is empty, the
// "no data" branches of the component should render. Mirrors the catch-block
// fallback in the loader.
const emptyLoaderData = {
  totalReturns: 0,
  statusMap: {} as Record<string, number>,
  topReasons: [] as { reason: string; count: number }[],
  refundedCount: 0,
  fyndSyncedCount: 0,
  pendingCount: 0,
  rejectedCount: 0,
  approvedCount: 0,
  approvedNotRefundedCount: 0,
  itemsCount: 0,
  allTimeReturns: 0,
  returnsOverTime: [] as { date: string; returns: number; fullDate: string }[],
  statusChartData: [] as { name: string; value: number }[],
  avgProcessingDays: null as number | null,
  periodChange: 0,
  rangeLabel: "Last 30 days",
  range: "last_30_days",
  from: undefined,
  to: undefined,
  hasFyndConfig: false,
  error: null as string | null,
  resolutionChartData: [] as { name: string; value: number; color: string }[],
  revenueRetained: 0,
  greenReturnCount: 0,
  shopLocale: "en",
  shopCurrency: "USD",
  shopTimezone: "UTC",
  totalRefundAmount: 0,
  topProductsData: [] as { title: string; count: number }[],
  customerFrequencyData: [] as { email: string; count: number }[],
  refundMethodBreakdown: [] as { method: string; count: number }[],
  exchangeConversionRate: 0,
  revenueRetainedRate: 0,
  repeatReturnerRate: 0,
  uniqueCustomerCount: 0,
  repeatCustomerCount: 0,
  resolvedCount: 0,
  fraudAlertCount: 0,
  avgRefundAmount: 0,
  revenueAtRisk: 0,
  geoData: [] as { country: string; count: number }[],
  createdByChannelData: [] as { channel: string; count: number }[],
  sourceChannelData: [] as { channel: string; count: number }[],
  conditionData: [] as { condition: string; count: number }[],
  avgTimeToRefundDays: null as number | null,
};

describe("Reports route (default export)", () => {
  it("renders the Analytics page heading", async () => {
    const { findByText } = renderWithRouter(Reports, {
      initialEntries: ["/app/reports"],
      loaderData: emptyLoaderData,
    });
    expect(await findByText("Analytics")).toBeTruthy();
  });

  it("renders the date range bar with Export CSV and Dashboard actions", async () => {
    const { container, findByText } = renderWithRouter(Reports, {
      initialEntries: ["/app/reports"],
      loaderData: emptyLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector(".dashboard-date-bar")).toBeTruthy();
    });
    expect(await findByText("Export CSV")).toBeTruthy();
    expect(await findByText("Dashboard")).toBeTruthy();
    // Date range select uses the loader's `range` field as its value.
    const select = container.querySelector("select");
    expect(select).toBeTruthy();
    expect(select?.value).toBe("last_30_days");
  });

  it("renders the four hero KPI cards with placeholder values for empty state", async () => {
    const { container, findByText } = renderWithRouter(Reports, {
      initialEntries: ["/app/reports"],
      loaderData: emptyLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector(".dashboard-hero-grid")).toBeTruthy();
    });
    // KPI labels.
    expect(await findByText("Total Returns")).toBeTruthy();
    expect(await findByText("Approval Rate")).toBeTruthy();
    expect(await findByText("Avg Processing")).toBeTruthy();
    expect(await findByText("Refund Rate")).toBeTruthy();
    // avgProcessingDays is null → "—" placeholder.
    expect(container.textContent).toContain("—");
  });

  it("renders the secondary stat row with retention and risk KPIs", async () => {
    const { findByText } = renderWithRouter(Reports, {
      initialEntries: ["/app/reports"],
      loaderData: emptyLoaderData,
    });
    expect(await findByText("Exchange Conversion")).toBeTruthy();
    expect(await findByText("Revenue Retained")).toBeTruthy();
    expect(await findByText("Repeat Returners")).toBeTruthy();
    expect(await findByText("Fraud Alerts")).toBeTruthy();
  });

  it("renders the chart panel section headings", async () => {
    const { findByText } = renderWithRouter(Reports, {
      initialEntries: ["/app/reports"],
      loaderData: emptyLoaderData,
    });
    expect(await findByText("Return volume trend")).toBeTruthy();
    expect(await findByText("Status distribution")).toBeTruthy();
    expect(await findByText("Performance rates")).toBeTruthy();
    expect(await findByText("Resolution breakdown")).toBeTruthy();
  });

  it("renders empty-state messages when chart data is empty", async () => {
    const { container } = renderWithRouter(Reports, {
      initialEntries: ["/app/reports"],
      loaderData: emptyLoaderData,
    });
    await waitFor(() => {
      const empties = container.querySelectorAll(".chart-empty");
      // At least the trend chart and status distribution show empty state.
      expect(empties.length).toBeGreaterThanOrEqual(2);
    });
    expect(container.textContent).toContain("No returns during this period.");
  });

  it("hides the Fynd Sync rate cell when hasFyndConfig is false", async () => {
    const { container } = renderWithRouter(Reports, {
      initialEntries: ["/app/reports"],
      loaderData: emptyLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector(".reports-rates-grid")).toBeTruthy();
    });
    expect(container.textContent).not.toMatch(/Fynd Sync rate/i);
    // Default rate cells (Approval, Rejection, Refund) should still render.
    const grid = container.querySelector(".reports-rates-grid");
    const cells = grid?.querySelectorAll(".reports-rate-cell") ?? [];
    expect(cells.length).toBe(3);
  });

  it("renders the error banner when the loader returned an error", async () => {
    const { container, findByText } = renderWithRouter(Reports, {
      initialEntries: ["/app/reports"],
      loaderData: {
        ...emptyLoaderData,
        error: "Failed to load reports. Please try again.",
      },
    });
    expect(
      await findByText("Failed to load reports. Please try again."),
    ).toBeTruthy();
    expect(container.querySelector(".app-alert-error")).toBeTruthy();
  });
});
