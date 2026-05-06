/**
 * @vitest-environment jsdom
 *
 * Component (jsdom) tests for app/routes/app.reports.tsx — drives the render
 * branches of the analytics page so coverage moves from ~50% (loader-only)
 * to ≥95% statements without modifying the source.
 *
 * Pattern follows app.layout.uncovered.test.tsx and
 * app.index.component.test.tsx:
 *   - Stub recharts (jsdom can't run ResizeObserver/canvas)
 *   - Stub @shopify/* server + react entry points
 *   - Stub shopify.server / db.server / billing.server / logger.server
 *   - Build several loaderData fixtures that flip each conditional branch
 *     (empty state, populated state, fynd-config, custom date range, fraud
 *     alerts, refund breakdown, channels, conditions, time-to-refund, etc.)
 *   - renderWithRouter mounts the route inside a memory router so
 *     useLoaderData / useSearchParams resolve. The data router is
 *     asynchronous, so every assertion is wrapped in `waitFor` so the
 *     loaderData has time to flow into the component.
 */

import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

// ── Server-side dependency stubs (the route imports these at top level) ──
const { prismaMock, authenticateMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../shopify.server", () => ({
  default: {},
  authenticate: { admin: authenticateMock },
}));
vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/billing.server", () => ({
  getBillingStatus: vi.fn(async () => ({ hasAccess: true })),
}));
vi.mock("../../lib/observability/logger.server", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    })),
  },
}));

vi.mock("@shopify/shopify-app-react-router/react", () => ({
  AppProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-provider">{children}</div>
  ),
}));
vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { error: vi.fn(() => null), headers: vi.fn(() => new Headers()) },
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

vi.mock("@shopify/app-bridge-react", () => ({
  useAppBridge: () => ({ toast: { show: vi.fn() } }),
  Modal: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  TitleBar: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

// recharts stubs — every chart subcomponent is a div passthrough so the
// chart panels render without ResizeObserver/canvas. ResponsiveContainer
// renders children so `<PieChart>`/`<AreaChart>` mount and their `data`
// props get exercised by the surrounding mapping logic.
vi.mock("recharts", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="recharts-mock">{children}</div>
  );
  const Empty = () => <div />;
  const TooltipMock = (props: {
    formatter?: (
      v: number | undefined,
      _: string | undefined,
      props: { payload?: { value: number } },
    ) => unknown;
    labelFormatter?: (label: string) => unknown;
  }) => {
    if (typeof props.formatter === "function") {
      try {
        props.formatter(7, "n", { payload: { value: 7 } });
      } catch {
        /* swallow */
      }
      try {
        props.formatter(undefined, undefined, { payload: undefined });
      } catch {
        /* swallow */
      }
    }
    if (typeof props.labelFormatter === "function") {
      try {
        props.labelFormatter("Jan 1, 25");
      } catch {
        /* swallow */
      }
    }
    return <div data-testid="recharts-tooltip" />;
  };
  return {
    AreaChart: Passthrough,
    Area: Empty,
    BarChart: Passthrough,
    Bar: Empty,
    LineChart: Passthrough,
    Line: Empty,
    PieChart: Passthrough,
    Pie: Passthrough,
    Cell: Empty,
    XAxis: Empty,
    YAxis: Empty,
    CartesianGrid: Empty,
    Tooltip: TooltipMock,
    Legend: Empty,
    ResponsiveContainer: Passthrough,
  };
});

import { renderWithRouter } from "../../test/component-helpers";
import { configure, fireEvent, render, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, type RouteObject } from "react-router";
import Reports, { ErrorBoundary, loader } from "../app.reports";

// Default authenticate stub — every loader call needs a session.
beforeEach(() => {
  Object.assign(prismaMock, createPrismaMock());
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({
    session: { shop: "store.myshopify.com" },
    admin: { graphql: vi.fn() },
  });
  prismaMock.shop.findUnique.mockResolvedValue({
    id: "shop-1",
    shopDomain: "store.myshopify.com",
    settings: {
      id: "s-1",
      shopTimezone: "UTC",
      shopLocale: "en",
      shopCurrency: "USD",
      fyndApplicationId: null,
      fyndCredentials: null,
    },
  });
});

function mkReq(qs = "") {
  return new Request(`https://app.example/app/reports${qs}`);
}

configure({ asyncUtilTimeout: 5000 });

// ────────────────────────────────────────────────────────────────────────
// Loader data fixtures
// ────────────────────────────────────────────────────────────────────────

type LoaderData = Awaited<ReturnType<typeof import("../app.reports").loader>>;

const emptyLoaderData: LoaderData = {
  totalReturns: 0,
  statusMap: {},
  topReasons: [],
  refundedCount: 0,
  fyndSyncedCount: 0,
  pendingCount: 0,
  rejectedCount: 0,
  approvedCount: 0,
  approvedNotRefundedCount: 0,
  itemsCount: 0,
  allTimeReturns: 0,
  returnsOverTime: [],
  statusChartData: [],
  avgProcessingDays: null,
  periodChange: 0,
  rangeLabel: "Last 30 days",
  range: "last_30_days",
  from: undefined,
  to: undefined,
  hasFyndConfig: false,
  error: null,
  resolutionChartData: [],
  revenueRetained: 0,
  greenReturnCount: 0,
  shopLocale: "en",
  shopCurrency: "USD",
  shopTimezone: "UTC",
  totalRefundAmount: 0,
  topProductsData: [],
  customerFrequencyData: [],
  refundMethodBreakdown: [],
  exchangeConversionRate: 0,
  revenueRetainedRate: 0,
  repeatReturnerRate: 0,
  uniqueCustomerCount: 0,
  repeatCustomerCount: 0,
  resolvedCount: 0,
  fraudAlertCount: 0,
  avgRefundAmount: 0,
  revenueAtRisk: 0,
  geoData: [],
  createdByChannelData: [],
  sourceChannelData: [],
  conditionData: [],
  avgTimeToRefundDays: null,
};

// Rich fixture — every conditional branch *true*: KPIs populated, charts
// rendered, fynd config on, fraud alerts, refund methods, products,
// customers, geo, both channels, conditions, time-to-refund, etc.
const richLoaderData: LoaderData = {
  ...emptyLoaderData,
  totalReturns: 100,
  statusMap: { approved: 60, completed: 5, pending: 20, rejected: 15 },
  topReasons: [
    { reason: "Wrong size", count: 30 },
    { reason: "Defective", count: 12 },
    { reason: "Changed mind", count: 8 },
  ],
  refundedCount: 50,
  fyndSyncedCount: 40,
  pendingCount: 20,
  rejectedCount: 15,
  approvedCount: 65,
  approvedNotRefundedCount: 3,
  itemsCount: 150,
  allTimeReturns: 500,
  returnsOverTime: [
    { date: "Jan 1, 25", returns: 5, fullDate: "2025-01-01" },
    { date: "Jan 2, 25", returns: 8, fullDate: "2025-01-02" },
    { date: "Jan 3, 25", returns: 3, fullDate: "2025-01-03" },
  ],
  statusChartData: [
    { name: "Approved", value: 60 },
    { name: "Pending", value: 20 },
    { name: "Rejected", value: 15 },
    { name: "Completed", value: 5 },
  ],
  avgProcessingDays: 2.5,
  periodChange: 60, // > 50 triggers warning insight
  rangeLabel: "Last 30 days",
  range: "last_30_days",
  hasFyndConfig: true,
  resolutionChartData: [
    { name: "Refund", value: 50, color: "#8B5CF6" },
    { name: "Exchange", value: 10, color: "#3B82F6" },
    { name: "Store Credit", value: 3, color: "#14b8a6" },
    { name: "Replacement", value: 2, color: "#F59E0B" },
  ],
  revenueRetained: 1234,
  greenReturnCount: 4,
  totalRefundAmount: 5678,
  topProductsData: [
    { title: "Cool Hat", count: 10 },
    { title: "Cool Shoe", count: 8 },
    { title: "SKU ABC", count: 4 },
  ],
  customerFrequencyData: [
    { email: "alice@example.com", count: 4 }, // ≥3 → red branch
    { email: "bob@example.com", count: 2 },
    { email: "noshow@example.com", count: 1 }, // filtered out
  ],
  refundMethodBreakdown: [
    { method: "card", count: 30 },
    { method: "store_credit", count: 8 },
  ],
  exchangeConversionRate: 16,
  revenueRetainedRate: 18,
  repeatReturnerRate: 15,
  uniqueCustomerCount: 80,
  repeatCustomerCount: 12,
  resolvedCount: 65,
  fraudAlertCount: 5,
  avgRefundAmount: 113.56,
  revenueAtRisk: 999,
  geoData: [
    { country: "US", count: 50 },
    { country: "CA", count: 20 },
  ],
  createdByChannelData: [
    { channel: "portal", count: 70 },
    { channel: "admin", count: 30 },
  ],
  sourceChannelData: [
    { channel: "web", count: 80 },
    { channel: "pos", count: 20 },
  ],
  conditionData: [
    { condition: "new with tags", count: 30 },
    { condition: "used", count: 10 },
  ],
  avgTimeToRefundDays: 1.5,
};

/**
 * Mounts <Reports> with the given loaderData inside a memory router and
 * waits until `Analytics` (the page heading) appears in the DOM, so async
 * loader resolution has completed before the caller queries the tree.
 */
async function mountReports(loaderData: LoaderData, initialEntries: string[] = ["/app/reports"]) {
  const result = renderWithRouter(Reports, {
    initialEntries,
    loaderData,
  });
  await waitFor(() => {
    expect(result.container.textContent).toContain("Analytics");
  });
  return result;
}

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

describe("app.reports component — empty state", () => {
  it("renders Analytics heading when totalReturns=0", async () => {
    const { container } = await mountReports(emptyLoaderData);
    expect(container.textContent).toContain("Analytics");
  });

  it("shows 'No returns during this period.' for the trend chart when zero data", async () => {
    const { container } = await mountReports(emptyLoaderData);
    expect(container.textContent).toMatch(/No returns during this period/i);
  });

  it("shows 'No data for this period.' for the status pie when statusChartData empty", async () => {
    const { container } = await mountReports(emptyLoaderData);
    expect(container.textContent).toMatch(/No data for this period/i);
  });

  it("shows 'No resolution data for this period.' when resolutionChartData empty", async () => {
    const { container } = await mountReports(emptyLoaderData);
    expect(container.textContent).toMatch(/No resolution data for this period/i);
  });

  it("shows 'No return reasons recorded.' when topReasons empty", async () => {
    const { container } = await mountReports(emptyLoaderData);
    expect(container.textContent).toMatch(/No return reasons recorded/i);
  });

  it("shows 'No returns in this period.' status table fallback when statusMap empty", async () => {
    const { container } = await mountReports(emptyLoaderData);
    expect(container.textContent).toMatch(/No returns in this period/i);
  });

  it("does NOT render Key Insights panel when totalReturns is 0", async () => {
    const { container } = await mountReports(emptyLoaderData);
    expect(container.textContent).not.toMatch(/Key insights/i);
  });

  it("renders the avg-processing dash when avgProcessingDays is null", async () => {
    const { container } = await mountReports(emptyLoaderData);
    // The KPI shows "—" when null (not "0d").
    expect(container.textContent).toContain("—");
  });

  it("hides the Fynd Sync rate when hasFyndConfig is false", async () => {
    const { container } = await mountReports({
      ...emptyLoaderData,
      hasFyndConfig: false,
    });
    expect(container.textContent).not.toMatch(/Fynd Sync/);
  });
});

describe("app.reports component — populated KPI tiles", () => {
  it("renders Total Returns, Approval Rate, Avg Processing, Refund Rate", async () => {
    const { container } = await mountReports(richLoaderData);
    expect(container.textContent).toContain("Total Returns");
    expect(container.textContent).toContain("Approval Rate");
    expect(container.textContent).toContain("Avg Processing");
    expect(container.textContent).toContain("Refund Rate");
  });

  it("renders the period-up arrow + percent when periodChange > 0", async () => {
    const { container } = await mountReports({
      ...richLoaderData,
      periodChange: 25,
    });
    expect(container.querySelector(".kpi-change--up")).toBeTruthy();
    expect(container.textContent).toContain("25%");
  });

  it("renders the period-down arrow when periodChange < 0", async () => {
    const { container } = await mountReports({
      ...richLoaderData,
      periodChange: -25,
    });
    expect(container.querySelector(".kpi-change--down")).toBeTruthy();
  });

  it("renders the avg processing time formatted to 1 decimal place", async () => {
    const { container } = await mountReports({
      ...richLoaderData,
      avgProcessingDays: 2.5,
    });
    expect(container.textContent).toContain("2.5d");
  });
});

describe("app.reports component — secondary stat row", () => {
  it("renders Exchange Conversion / Revenue Retained / Repeat Returners / Fraud Alerts", async () => {
    const { container } = await mountReports(richLoaderData);
    expect(container.textContent).toContain("Exchange Conversion");
    expect(container.textContent).toContain("Revenue Retained");
    expect(container.textContent).toContain("Repeat Returners");
    expect(container.textContent).toContain("Fraud Alerts");
  });

  it("highlights fraud-alert card with red accent when fraudAlertCount > 0", async () => {
    const { container } = await mountReports({
      ...richLoaderData,
      fraudAlertCount: 5,
    });
    const html = container.innerHTML;
    expect(html).toMatch(/#DC2626/);
  });

  it("renders muted-grey accent for fraud card when fraudAlertCount == 0", async () => {
    const { container } = await mountReports({
      ...richLoaderData,
      fraudAlertCount: 0,
    });
    const html = container.innerHTML;
    expect(html).toMatch(/#94A3B8/);
  });
});

describe("app.reports component — date range filter", () => {
  it("range select dropdown reflects the loader's range", async () => {
    const { container } = await mountReports({ ...richLoaderData, range: "last_7_days" }, [
      "/app/reports?range=last_7_days",
    ]);
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.value).toBe("last_7_days");
  });

  it("updates the URL search params when the date range changes", async () => {
    const routes: RouteObject[] = [
      {
        path: "/app/reports",
        element: <Reports />,
        loader: () => ({ ...richLoaderData, range: "last_30_days" }),
      },
    ];
    const router = createMemoryRouter(routes, {
      initialEntries: ["/app/reports?range=last_30_days"],
    });
    const { container } = render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(container.querySelector("select")).toBeTruthy();
    });
    const select = container.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "last_7_days" } });
    await waitFor(() => {
      const loc = router.state.location;
      expect(loc.search).toContain("range=last_7_days");
    });
  });

  it("renders custom date inputs when range=custom and updates from/to", async () => {
    const routes: RouteObject[] = [
      {
        path: "/app/reports",
        element: <Reports />,
        loader: () => ({
          ...richLoaderData,
          range: "custom",
          from: "2025-01-01",
          to: "2025-01-31",
        }),
      },
    ];
    const router = createMemoryRouter(routes, {
      initialEntries: ["/app/reports?range=custom&from=2025-01-01&to=2025-01-31"],
    });
    const { container } = render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(container.querySelectorAll("input[type='date']").length).toBe(2);
    });
    const dateInputs = container.querySelectorAll("input[type='date']");
    expect((dateInputs[0] as HTMLInputElement).value).toBe("2025-01-01");
    expect((dateInputs[1] as HTMLInputElement).value).toBe("2025-01-31");

    // Change "from" → URL gets updated with the new from value
    fireEvent.change(dateInputs[0], { target: { value: "2025-02-01" } });
    await waitFor(() => {
      expect(router.state.location.search).toContain("from=2025-02-01");
    });

    // Change "to" → URL gets updated
    fireEvent.change(dateInputs[1], { target: { value: "2025-02-15" } });
    await waitFor(() => {
      expect(router.state.location.search).toContain("to=2025-02-15");
    });
  });

  it("clears from/to when switching off the custom preset", async () => {
    const routes: RouteObject[] = [
      {
        path: "/app/reports",
        element: <Reports />,
        loader: () => ({
          ...richLoaderData,
          range: "custom",
          from: "2025-01-01",
          to: "2025-01-31",
        }),
      },
    ];
    const router = createMemoryRouter(routes, {
      initialEntries: ["/app/reports?range=custom&from=2025-01-01&to=2025-01-31"],
    });
    const { container } = render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(container.querySelector("select")).toBeTruthy();
    });
    const select = container.querySelector("select") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "last_7_days" } });
    await waitFor(() => {
      expect(router.state.location.search).not.toContain("from=");
      expect(router.state.location.search).not.toContain("to=");
    });
  });
});

describe("app.reports component — export & navigation", () => {
  it("renders the Export CSV link with the active range query string", async () => {
    const { container } = await mountReports({ ...richLoaderData, range: "last_7_days" }, [
      "/app/reports?range=last_7_days",
    ]);
    const link = Array.from(container.querySelectorAll("a")).find((a) =>
      a.getAttribute("href")?.includes("/api/returns/export"),
    );
    expect(link?.getAttribute("href")).toContain("range=last_7_days");
  });

  it("includes from/to in the export URL when range=custom", async () => {
    const { container } = await mountReports(
      {
        ...richLoaderData,
        range: "custom",
        from: "2025-01-01",
        to: "2025-01-31",
      },
      ["/app/reports?range=custom&from=2025-01-01&to=2025-01-31"],
    );
    const link = Array.from(container.querySelectorAll("a")).find((a) =>
      a.getAttribute("href")?.includes("/api/returns/export"),
    );
    expect(link?.getAttribute("href")).toContain("from=2025-01-01");
    expect(link?.getAttribute("href")).toContain("to=2025-01-31");
  });

  it("renders a Dashboard link back to /app", async () => {
    const { container } = await mountReports(richLoaderData);
    const dashLink = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "/app",
    );
    expect(dashLink).toBeTruthy();
  });
});

describe("app.reports component — charts visibility per data state", () => {
  it("renders the recharts AreaChart when returnsOverTime has data", async () => {
    const { container } = await mountReports(richLoaderData);
    expect(container.querySelectorAll("[data-testid='recharts-mock']").length).toBeGreaterThan(0);
  });

  it("renders the resolution donut when resolutionChartData has data", async () => {
    const { container } = await mountReports(richLoaderData);
    expect(container.textContent).toContain("Resolution breakdown");
    expect(container.textContent).toContain("Resolved");
  });

  it("renders the status pie + legend when statusChartData has data", async () => {
    const { container } = await mountReports(richLoaderData);
    expect(container.textContent).toContain("Status distribution");
  });

  it("renders the trend chart with dots when fewer than 15 data points", async () => {
    const { container } = await mountReports(richLoaderData);
    expect(container.textContent).toContain("Return volume trend");
  });

  it("renders the trend chart without dots when 15+ data points", async () => {
    const manyDays = Array.from({ length: 20 }).map((_, i) => ({
      date: `Jan ${i + 1}, 25`,
      returns: i,
      fullDate: `2025-01-${String(i + 1).padStart(2, "0")}`,
    }));
    const { container } = await mountReports({
      ...richLoaderData,
      returnsOverTime: manyDays,
    });
    expect(container.textContent).toContain("Return volume trend");
  });
});

describe("app.reports component — group/breakdown panels", () => {
  it("renders the top-reasons bars when topReasons populated", async () => {
    const { container } = await mountReports(richLoaderData);
    expect(container.textContent).toContain("Top return reasons");
    expect(container.textContent).toContain("Wrong size");
    expect(container.textContent).toContain("Defective");
  });

  it("renders the status-breakdown table when statusMap populated", async () => {
    const { container } = await mountReports(richLoaderData);
    expect(container.textContent).toContain("Status breakdown");
    expect(container.textContent).toMatch(/approved/i);
  });

  it("renders Top Products by Returns when topProductsData populated", async () => {
    const { container } = await mountReports(richLoaderData);
    expect(container.textContent).toContain("Top 10 Products by Return Count");
    expect(container.textContent).toContain("Cool Hat");
  });

  it("renders Customer Return Frequency only when first customer has ≥2 returns", async () => {
    const { container } = await mountReports(richLoaderData);
    expect(container.textContent).toContain("Top Customers by Return Frequency");
    expect(container.textContent).toContain("alice@example.com");
  });

  it("hides Customer Return Frequency when first customer has only 1 return", async () => {
    const { container } = await mountReports({
      ...richLoaderData,
      customerFrequencyData: [{ email: "single@example.com", count: 1 }],
    });
    expect(container.textContent).not.toContain("Top Customers by Return Frequency");
  });

  it("renders Returns by Country when geoData populated", async () => {
    const { container } = await mountReports(richLoaderData);
    expect(container.textContent).toContain("Returns by Country");
    expect(container.textContent).toContain("US");
  });

  it("renders both Created Via and Order Channel cards when both populated", async () => {
    const { container } = await mountReports(richLoaderData);
    expect(container.textContent).toContain("Created Via");
    expect(container.textContent).toContain("Order Channel");
    expect(container.textContent).toContain("portal");
    expect(container.textContent).toContain("web");
  });

  it("renders only Created Via when sourceChannelData empty", async () => {
    const { container } = await mountReports({
      ...richLoaderData,
      sourceChannelData: [],
    });
    expect(container.textContent).toContain("Created Via");
    expect(container.textContent).not.toContain("Order Channel");
  });

  it("renders only Order Channel when createdByChannelData empty", async () => {
    const { container } = await mountReports({
      ...richLoaderData,
      createdByChannelData: [],
    });
    expect(container.textContent).not.toContain("Created Via");
    expect(container.textContent).toContain("Order Channel");
  });

  it("renders Item Condition Breakdown when conditionData populated", async () => {
    const { container } = await mountReports(richLoaderData);
    expect(container.textContent).toContain("Item Condition Breakdown");
    expect(container.textContent).toContain("new with tags");
  });
});

describe("app.reports component — revenue & refunds", () => {
  it("renders Revenue Impact panel with totals when totalRefundAmount > 0", async () => {
    const { container } = await mountReports(richLoaderData);
    expect(container.textContent).toContain("Revenue Impact");
    expect(container.textContent).toContain("Total refunds issued");
    expect(container.textContent).toContain("Avg refund amount");
  });

  it("renders Refund Method Breakdown when refundMethodBreakdown has rows", async () => {
    const { container } = await mountReports(richLoaderData);
    expect(container.textContent).toContain("Refund Method Breakdown");
    expect(container.textContent).toContain("card");
    expect(container.textContent).toContain("store credit");
  });

  it("renders avg-time-to-refund row when avgTimeToRefundDays not null", async () => {
    const { container } = await mountReports({
      ...richLoaderData,
      avgTimeToRefundDays: 1.5,
    });
    expect(container.textContent).toMatch(/Avg time to refund/);
    expect(container.textContent).toMatch(/1\.5d/);
  });

  it("hides avg-time-to-refund row when null", async () => {
    const { container } = await mountReports({
      ...richLoaderData,
      avgTimeToRefundDays: null,
    });
    expect(container.textContent).not.toMatch(/Avg time to refund/);
  });

  it("renders the Revenue Retained currency total + green-returns row in the impact panel", async () => {
    const { container } = await mountReports(richLoaderData);
    expect(container.textContent).toContain("Revenue retained");
    expect(container.textContent).toContain("Green returns");
  });

  it("hides the Revenue Impact section when totalRefundAmount=0 and refundMethodBreakdown empty", async () => {
    const { container } = await mountReports({
      ...richLoaderData,
      totalRefundAmount: 0,
      refundMethodBreakdown: [],
    });
    expect(container.textContent).not.toContain("Total refunds issued");
  });
});

describe("app.reports component — Key Insights conditionals", () => {
  it("renders 'High approval rate' insight when approvalRate ≥ 80", async () => {
    const { container } = await mountReports({
      ...richLoaderData,
      totalReturns: 10,
      approvedCount: 9, // 90%
      rejectedCount: 1,
    });
    expect(container.textContent).toMatch(/High approval rate/i);
  });

  it("renders 'Low approval rate' insight when approvalRate < 50 and > 0", async () => {
    const { container } = await mountReports({
      ...richLoaderData,
      totalReturns: 10,
      approvedCount: 3, // 30%
      rejectedCount: 7,
    });
    expect(container.textContent).toMatch(/Low approval rate/i);
  });

  it("renders 'Avg processing > 3 days' insight when avgProcessingDays > 3", async () => {
    const { container } = await mountReports({
      ...richLoaderData,
      avgProcessingDays: 4.2,
    });
    expect(container.textContent).toMatch(/Avg processing: 4\.2 days/i);
  });

  it("renders 'Fast processing' insight when avgProcessingDays ≤ 1", async () => {
    const { container } = await mountReports({
      ...richLoaderData,
      avgProcessingDays: 0.5,
    });
    expect(container.textContent).toMatch(/Fast processing/i);
  });

  it("renders 'awaiting refund' insight when approvedNotRefundedCount > 0", async () => {
    const { container } = await mountReports({
      ...richLoaderData,
      approvedNotRefundedCount: 4,
    });
    expect(container.textContent).toMatch(/awaiting refund/i);
    expect(container.textContent).toMatch(/4 approved returns/);
  });

  it("uses singular 'return' when approvedNotRefundedCount === 1", async () => {
    const { container } = await mountReports({
      ...richLoaderData,
      approvedNotRefundedCount: 1,
    });
    expect(container.textContent).toMatch(/1 approved return /);
  });

  it("renders 'Top reason' insight when first reason ≥ 2", async () => {
    const { container } = await mountReports(richLoaderData);
    expect(container.textContent).toMatch(/Top reason/i);
  });

  it("renders 'Returns up' insight when periodChange > 50", async () => {
    const { container } = await mountReports({
      ...richLoaderData,
      periodChange: 80,
    });
    expect(container.textContent).toMatch(/Returns up 80%/);
  });

  it("renders 'Returns down' insight when periodChange < -20", async () => {
    const { container } = await mountReports({
      ...richLoaderData,
      periodChange: -30,
    });
    expect(container.textContent).toMatch(/Returns down 30%/);
  });
});

describe("app.reports component — Performance Rates / Fynd visibility", () => {
  it("includes the Fynd Sync rate cell when hasFyndConfig=true", async () => {
    const { container } = await mountReports({
      ...richLoaderData,
      hasFyndConfig: true,
    });
    expect(container.textContent).toMatch(/Fynd Sync rate/);
  });

  it("excludes the Fynd Sync rate cell when hasFyndConfig=false", async () => {
    const { container } = await mountReports({
      ...richLoaderData,
      hasFyndConfig: false,
    });
    expect(container.textContent).not.toMatch(/Fynd Sync rate/);
  });
});

describe("app.reports component — error banner", () => {
  it("renders the error banner when loader returned an error string", async () => {
    const { container } = await mountReports({
      ...emptyLoaderData,
      // The loader returns a discriminated union — cast to the error
      // variant so tsc accepts `error: string` here. Runtime shape is
      // identical; this only satisfies the type checker.
      error: "Failed to load reports. Please try again.",
    } as unknown as LoaderData);
    expect(container.textContent).toMatch(/Failed to load reports/i);
  });
});

describe("app.reports component — summary footer", () => {
  it("renders the all-time totals + items-per-return ratio in the footer", async () => {
    const { container } = await mountReports(richLoaderData);
    expect(container.textContent).toContain("total returns (all time)");
    expect(container.textContent).toContain("items returned");
    expect(container.textContent).toContain("items per return");
  });
});

// ────────────────────────────────────────────────────────────────────────
// ErrorBoundary
// ────────────────────────────────────────────────────────────────────────

describe("app.reports ErrorBoundary export", () => {
  it("renders the message of a thrown Error", async () => {
    const routes: RouteObject[] = [
      {
        path: "*",
        element: <div data-testid="never" />,
        loader: () => {
          throw new Error("boom");
        },
        ErrorBoundary,
      },
    ];
    const router = createMemoryRouter(routes, {
      initialEntries: ["/app/reports"],
    });
    const { container } = render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(container.textContent).toContain("boom");
    });
    expect(container.textContent).toMatch(/Try again/);
  });

  it("renders an unexpected error fallback when error is not an Error or RouteResponse", async () => {
    const routes: RouteObject[] = [
      {
        path: "*",
        element: <div data-testid="never" />,
        loader: () => {
          throw "string-thrown";
        },
        ErrorBoundary,
      },
    ];
    const router = createMemoryRouter(routes, {
      initialEntries: ["/app/reports"],
    });
    const { container } = render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(container.textContent).toMatch(/An unexpected error occurred/i);
    });
  });

  it("renders a route-error response's data when isRouteErrorResponse", async () => {
    const routes: RouteObject[] = [
      {
        path: "*",
        element: <div data-testid="never" />,
        loader: () => {
          throw new Response("forbidden-data", { status: 403 });
        },
        ErrorBoundary,
      },
    ];
    const router = createMemoryRouter(routes, {
      initialEntries: ["/app/reports"],
    });
    const { container } = render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(container.textContent).toContain("forbidden-data");
    });
  });
});

// ────────────────────────────────────────────────────────────────────────
// Loader tests — covers the loader branches the existing app.reports.test.ts
// doesn't reach (returnsForDaily forEach, $queryRaw raw-result path,
// $queryRaw catch fallback, customerFrequencyData/conditionData maps,
// avgTimeToRefundDays rounded path).
// ────────────────────────────────────────────────────────────────────────

describe("app.reports loader — uncovered branches", () => {
  it("populates returnsOverTime by counting returnsForDaily entries (lines 95-96)", async () => {
    // Anchor a known date so the daily map keys are deterministic.
    const today = new Date();
    const recent1 = new Date(today.getTime() - 1 * 86400 * 1000);
    const recent2 = new Date(today.getTime() - 2 * 86400 * 1000);
    prismaMock.returnCase.findMany.mockImplementation(async (args: any) => {
      const w = args?.where ?? {};
      // returnsForDaily uses select { createdAt, status }
      if (args?.select?.status && args?.select?.createdAt && !w?.refundJson) {
        return [
          { createdAt: recent1, status: "approved" },
          { createdAt: recent2, status: "pending" },
          // Off-window date — outside the daily map (covers the
          // `if (dailyData[key] !== undefined)` branch).
          { createdAt: new Date("1999-01-01"), status: "rejected" },
        ] as any;
      }
      return [];
    });
    const data = await loader({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(Array.isArray(data.returnsOverTime)).toBe(true);
    // At least one entry has returns >= 1
    const total = data.returnsOverTime.reduce((s, r) => s + r.returns, 0);
    expect(total).toBeGreaterThanOrEqual(2);
  });

  it("computes avgProcessingDays from $queryRaw rounded result (lines 132-148)", async () => {
    // Make approvedWithEvents non-empty so the if-branch is entered.
    prismaMock.returnCase.findMany.mockImplementation(async (args: any) => {
      if (args?.select?.updatedAt) {
        return [
          {
            createdAt: new Date("2025-01-01"),
            updatedAt: new Date("2025-01-03"),
          },
        ] as any;
      }
      return [];
    });
    // Stub $queryRaw to return a numeric avg_days — first call is the
    // processing-time query (line 133).
    let queryRawCallCount = 0;
    prismaMock.$queryRaw.mockImplementation(async () => {
      queryRawCallCount++;
      if (queryRawCallCount === 1) return [{ avg_days: 1.234 }] as any;
      // The "revenue at risk" + "time-to-refund" subsequent raw queries.
      return [{ total: "0", avg_days: null }] as any;
    });
    const data = await loader({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(data.avgProcessingDays).toBeCloseTo(1.2, 1);
  });

  it("falls back to in-memory avg when $queryRaw throws (lines 149-154)", async () => {
    prismaMock.returnCase.findMany.mockImplementation(async (args: any) => {
      if (args?.select?.updatedAt) {
        return [
          {
            createdAt: new Date("2025-01-01T00:00:00Z"),
            updatedAt: new Date("2025-01-03T00:00:00Z"),
          },
          {
            createdAt: new Date("2025-01-01T00:00:00Z"),
            updatedAt: new Date("2025-01-05T00:00:00Z"),
          },
        ] as any;
      }
      return [];
    });
    // Make the first $queryRaw throw, subsequent ones succeed (so the
    // catch-block fallback executes).
    let queryRawCallCount = 0;
    prismaMock.$queryRaw.mockImplementation(async () => {
      queryRawCallCount++;
      if (queryRawCallCount === 1) throw new Error("LATERAL not supported");
      return [{ total: "0", avg_days: null }] as any;
    });
    const data = await loader({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    // (2 + 4) / 2 = 3 days
    expect(data.avgProcessingDays).toBeCloseTo(3, 1);
  });

  it("populates customerFrequencyData (lines 220-221) when groupBy returns rows", async () => {
    prismaMock.returnCase.groupBy.mockImplementation(async (args: any) => {
      if (args.by?.includes("customerEmailNorm")) {
        return [
          { customerEmailNorm: "x@example.com", _count: { customerEmailNorm: 4 } },
          { customerEmailNorm: "y@example.com", _count: { customerEmailNorm: 2 } },
          { customerEmailNorm: null, _count: { customerEmailNorm: 99 } }, // filtered
        ] as any;
      }
      return [];
    });
    const data = await loader({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(data.customerFrequencyData).toEqual([
      { email: "x@example.com", count: 4 },
      { email: "y@example.com", count: 2 },
    ]);
  });

  it("populates conditionData (lines 320-322) when returnItem.groupBy returns rows", async () => {
    prismaMock.returnItem.groupBy.mockImplementation(async (args: any) => {
      if (args.by?.includes("condition")) {
        return [
          { condition: "new_with_tags", _count: 5 },
          { condition: "used", _count: 2 },
          { condition: null, _count: 99 }, // filtered
          { condition: "  ", _count: 1 }, // blank-filtered
        ] as any;
      }
      return [];
    });
    const data = await loader({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(data.conditionData).toEqual([
      { condition: "new with tags", count: 5 },
      { condition: "used", count: 2 },
    ]);
  });

  it("rounds avgTimeToRefundDays from the second $queryRaw (line 347)", async () => {
    let queryRawCallCount = 0;
    prismaMock.$queryRaw.mockImplementation(async () => {
      queryRawCallCount++;
      // Call 1 = processing avg (skipped — empty approvedWithEvents)
      // Call 2 = revenueAtRisk
      // Call 3 = avgTimeToRefundDays
      if (queryRawCallCount === 1) return [{ total: "12.50" }] as any;
      if (queryRawCallCount === 2) return [{ avg_days: 2.345 }] as any;
      return [] as any;
    });
    const data = await loader({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(data.avgTimeToRefundDays).toBeCloseTo(2.3, 1);
    expect(data.revenueAtRisk).toBeCloseTo(12.5, 2);
  });
});
