/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Mocks for module-top-level imports in app/routes/app._index.tsx ──
// The route imports server-only modules (shopify.server, db.server) for the
// loader and a couple of lib helpers. Stub them so importing the component
// in jsdom doesn't crash on Node-only deps.
vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../db.server", () => ({
  default: {
    shop: { findUnique: vi.fn(), create: vi.fn() },
    returnCase: {
      count: vi.fn(),
      groupBy: vi.fn(),
      findMany: vi.fn(),
    },
    returnItem: { groupBy: vi.fn() },
    blocklistEntry: { count: vi.fn() },
    lookupSession: { deleteMany: vi.fn() },
    fyndWebhookLog: { deleteMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));

// shopify-app-react-router server entry is pulled in transitively. Stub the
// boundary helpers so the import never blows up under jsdom.
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

// recharts pulls in ResizeObserver / canvas APIs that don't exist in jsdom
// and emits noisy warnings. Replace every component with a div passthrough so
// the dashboard's chart panel renders cleanly.
vi.mock("recharts", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="recharts-mock">{children}</div>
  );
  const Empty = () => <div />;
  return {
    AreaChart: Passthrough,
    Area: Empty,
    XAxis: Empty,
    YAxis: Empty,
    CartesianGrid: Empty,
    Tooltip: Empty,
    ResponsiveContainer: Passthrough,
  };
});

import { renderWithRouter } from "../../test/component-helpers";
import { waitFor } from "@testing-library/react";
import Dashboard from "../app._index";

const baseLoaderData = {
  totalReturns: 42,
  statusMap: { pending: 5, approved: 30, rejected: 7 } as Record<string, number>,
  approvedCount: 30,
  topReasons: [
    { reason: "Wrong size", count: 18 },
    { reason: "Defective", count: 9 },
  ],
  recentReturns: [
    {
      id: "rc_recent_1",
      status: "approved",
      shopifyOrderName: "#1001",
      returnRequestNo: "RR-001",
      fyndReturnNo: null,
      createdAt: new Date("2025-01-10T12:00:00Z"),
    },
    {
      id: "rc_recent_2",
      status: "pending",
      shopifyOrderName: "#1002",
      returnRequestNo: null,
      fyndReturnNo: "FR-002",
      createdAt: new Date("2025-01-11T12:00:00Z"),
    },
  ] as unknown as Awaited<
    ReturnType<typeof import("../../db.server").default.returnCase.findMany>
  >,
  hasFyndConfig: true,
  shopDomain: "test-shop.myshopify.com",
  refundedCount: 12,
  pendingCount: 5,
  rejectedCount: 7,
  returnsOverTime: [
    { date: "Jan 1, 25", returns: 3, fullDate: "2025-01-01" },
    { date: "Jan 2, 25", returns: 5, fullDate: "2025-01-02" },
  ],
  periodChange: 12,
  rangeLabel: "Last 30 days",
  range: "last_30_days",
  from: undefined,
  to: undefined,
  allTimeReturns: 200,
  suggestions: [
    {
      type: "warning" as const,
      message: "5 returns pending review.",
      action: "Review now",
      actionUrl: "/app/returns?status=pending",
    },
  ],
  error: null,
  revenueRetained: 1500,
  exchangeRate: 25,
  greenReturnCount: 4,
  blocklistCount: 2,
  resolutionMap: { refund: 10, exchange: 5, store_credit: 3, replacement: 2 } as Record<
    string,
    number
  >,
  revenueAtRisk: 800,
  overdueCount: 2,
  shopLocale: "en",
  shopCurrency: "USD",
  shopTimezone: "UTC",
  fraudAlertCount: 1,
  fraudAlertReturns: [
    {
      id: "rc_fraud_1",
      customerName: "Sketchy Sam",
      customerEmailNorm: "sam@example.com",
      fraudRiskLevel: "critical",
      fraudRiskScore: 92,
      shopifyOrderName: "#9001",
    },
  ],
  avgRefundAmount: 75,
  totalRefundAmount: 900,
};

describe("Dashboard route (app._index)", () => {
  it("renders the page heading", async () => {
    const { findByText } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: baseLoaderData,
    });
    expect(await findByText("Dashboard")).toBeTruthy();
  });

  it("renders the four hero KPI cards with their values", async () => {
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector(".dashboard-hero-grid")).toBeTruthy();
    });
    const heroCards = container.querySelectorAll(".dashboard-kpi-card");
    expect(heroCards.length).toBe(4);

    const labels = Array.from(container.querySelectorAll(".kpi-label")).map(
      (el) => el.textContent?.trim(),
    );
    expect(labels).toEqual(
      expect.arrayContaining(["Total returns", "Needs review", "Approved", "Refunded"]),
    );

    const values = Array.from(
      container.querySelectorAll(".dashboard-hero-grid .kpi-value"),
    ).map((el) => el.textContent?.trim());
    expect(values).toEqual(expect.arrayContaining(["42", "5", "30", "12"]));
  });

  it("renders the secondary stat grid with revenue, exchange rate, and overdue cards", async () => {
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector(".dashboard-stat-grid")).toBeTruthy();
    });
    const statCards = container.querySelectorAll(".dashboard-stat-card");
    expect(statCards.length).toBeGreaterThanOrEqual(8);

    const labels = Array.from(
      container.querySelectorAll(".dashboard-stat-grid .kpi-label"),
    ).map((el) => el.textContent?.trim());
    expect(labels).toEqual(
      expect.arrayContaining([
        "Revenue retained",
        "Revenue at risk",
        "Avg refund",
        "Refund rate",
        "Exchange rate",
        "Green returns",
        "Blocked attempts",
        "Overdue returns",
      ]),
    );

    expect(container.textContent).toContain("25%"); // exchange rate
  });

  it("renders the highlight strip with the top return reason", async () => {
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector(".dashboard-highlight-strip")).toBeTruthy();
    });
    expect(container.textContent).toContain("Top return reason");
    expect(container.textContent).toContain("Wrong size");
    expect(container.textContent).toContain("Second most common");
    expect(container.textContent).toContain("Defective");
  });

  it("mounts the recharts area chart inside the trend panel", async () => {
    const { container, findAllByTestId } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector(".dashboard-chart-row")).toBeTruthy();
    });
    const charts = await findAllByTestId("recharts-mock");
    // ResponsiveContainer + AreaChart are both passthroughs.
    expect(charts.length).toBeGreaterThanOrEqual(1);
  });

  it("renders the status breakdown using statusMap entries", async () => {
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector(".dashboard-status-list")).toBeTruthy();
    });
    const statusItems = container.querySelectorAll(".dashboard-status-item");
    expect(statusItems.length).toBe(3);
    const text = container.textContent ?? "";
    expect(text).toContain("pending");
    expect(text).toContain("approved");
    expect(text).toContain("rejected");
  });

  it("renders recent returns rows with order names", async () => {
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector(".dashboard-recent-table")).toBeTruthy();
    });
    const rows = container.querySelectorAll(".dashboard-recent-table tbody tr");
    expect(rows.length).toBe(2);
    expect(container.textContent).toContain("#1001");
    expect(container.textContent).toContain("#1002");
  });

  it("renders the suggestions banner and fraud alerts widget when applicable", async () => {
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector(".dashboard-suggestions")).toBeTruthy();
    });
    expect(container.textContent).toContain("5 returns pending review.");
    expect(container.textContent).toContain("Fraud Alerts (1)");
    expect(container.textContent).toContain("Sketchy Sam");
    // Fynd banner should NOT render because hasFyndConfig is true
    expect(container.querySelector(".dashboard-fynd-banner")).toBeFalsy();
  });

  it("renders an error banner when the loader returns an error string", async () => {
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: {
        ...baseLoaderData,
        error: "Failed to load dashboard data. Please refresh or try again later.",
      },
    });
    await waitFor(() => {
      expect(container.querySelector(".app-alert-error")).toBeTruthy();
    });
    expect(container.textContent).toContain(
      "Failed to load dashboard data. Please refresh or try again later.",
    );
  });
});
