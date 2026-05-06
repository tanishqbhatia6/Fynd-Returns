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
//
// The Tooltip mock invokes its `formatter` prop on render so the dashboard's
// inline `formatter={(value) => [value ?? 0, "Returns"]}` callback is
// exercised in coverage (otherwise the arrow function is never called under
// jsdom because real recharts isn't doing the rendering).
vi.mock("recharts", () => {
  const Passthrough = ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="recharts-mock">{children}</div>
  );
  const Empty = () => <div />;
  const TooltipMock = (props: { formatter?: (v: number | undefined) => unknown }) => {
    if (typeof props.formatter === "function") {
      // Call once with a numeric value, once with undefined, to cover both
      // sides of the `value ?? 0` nullish coalescing.
      try {
        props.formatter(7);
      } catch {
        /* swallow */
      }
      try {
        props.formatter(undefined);
      } catch {
        /* swallow */
      }
    }
    return <div data-testid="recharts-tooltip" />;
  };
  return {
    AreaChart: Passthrough,
    Area: Empty,
    XAxis: Empty,
    YAxis: Empty,
    CartesianGrid: Empty,
    Tooltip: TooltipMock,
    ResponsiveContainer: Passthrough,
  };
});

import { renderWithRouter } from "../../test/component-helpers";
import { configure, fireEvent, render, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, type RouteObject } from "react-router";
import Dashboard, { ErrorBoundary } from "../app._index";

// jsdom can be slow on CI/local. Bump the default async timeout so
// `waitFor`/`findBy*` calls have enough headroom for the data-router to
// resolve a sync loader and mount the dashboard tree.
configure({ asyncUtilTimeout: 5000 });

/**
 * Mount the dashboard's ErrorBoundary by setting up a memory router whose
 * loader throws — this drives `useRouteError()` to return the supplied value
 * without monkey-patching react-router internals (which breaks the data
 * router used by `renderWithRouter`).
 */
function renderErrorBoundary(error: unknown) {
  const routes: RouteObject[] = [
    {
      path: "*",
      element: <div data-testid="never" />,
      loader: () => {
        // Throwing inside the loader propagates the value to
        // `useRouteError()` in the ErrorBoundary element below.
        throw error;
      },
      ErrorBoundary,
    },
  ];
  const router = createMemoryRouter(routes, { initialEntries: ["/app"] });
  return render(<RouterProvider router={router} />);
}

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
  ] as unknown as Awaited<ReturnType<typeof import("../../db.server").default.returnCase.findMany>>,
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

    const labels = Array.from(container.querySelectorAll(".kpi-label")).map((el) =>
      el.textContent?.trim(),
    );
    expect(labels).toEqual(
      expect.arrayContaining(["Total returns", "Needs review", "Approved", "Refunded"]),
    );

    const values = Array.from(container.querySelectorAll(".dashboard-hero-grid .kpi-value")).map(
      (el) => el.textContent?.trim(),
    );
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

    const labels = Array.from(container.querySelectorAll(".dashboard-stat-grid .kpi-label")).map(
      (el) => el.textContent?.trim(),
    );
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

  it("renders the empty-state for recent returns, the Fynd setup banner, and skips the highlight strip when there's nothing to show", async () => {
    // This empty-shape data exercises three distinct render paths:
    //  - the recent-returns empty state (the "No returns yet" hero)
    //  - the dashboard-fynd-banner (only renders when hasFyndConfig=false)
    //  - the highlight strip's hidden branch (topReasons=[] && approvedCount=0)
    //  - the resolution-breakdown hidden branch (resolutionMap={})
    //  - the suggestions row hidden branch (suggestions=[])
    //  - the fraud-alerts widget hidden branch (fraudAlertCount=0)
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: {
        ...baseLoaderData,
        totalReturns: 0,
        approvedCount: 0,
        refundedCount: 0,
        pendingCount: 0,
        rejectedCount: 0,
        statusMap: {} as Record<string, number>,
        topReasons: [],
        recentReturns: [],
        returnsOverTime: [],
        suggestions: [],
        resolutionMap: {} as Record<string, number>,
        revenueRetained: 0,
        revenueAtRisk: 0,
        greenReturnCount: 0,
        blocklistCount: 0,
        overdueCount: 0,
        exchangeRate: 0,
        avgRefundAmount: 0,
        totalRefundAmount: 0,
        fraudAlertCount: 0,
        fraudAlertReturns: [],
        hasFyndConfig: false,
        periodChange: 0,
        allTimeReturns: 0,
      },
    });
    await waitFor(() => {
      expect(container.querySelector(".dashboard-empty-state")).toBeTruthy();
    });
    expect(container.querySelector(".dashboard-highlight-strip")).toBeFalsy();
    expect(container.querySelector(".dashboard-fynd-banner")).toBeTruthy();
    expect(container.textContent).toContain("Connect Fynd for reverse logistics");
    expect(container.textContent).toContain("No returns yet");
    expect(container.textContent).toContain("Share portal URL");
    expect(container.querySelector(".dashboard-resolution-grid")).toBeFalsy();
    expect(container.querySelector(".dashboard-suggestions")).toBeFalsy();
    expect(container.textContent).not.toContain("Fraud Alerts");
    expect(container.textContent).toContain("No returns in this period.");
    expect(container.textContent).toContain("No return data for this period.");
  });

  it("renders only one highlight-strip cell when there's exactly one top reason", async () => {
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: {
        ...baseLoaderData,
        topReasons: [{ reason: "Wrong size", count: 4 }],
      },
    });
    await waitFor(() => {
      expect(container.querySelector(".dashboard-highlight-strip")).toBeTruthy();
    });
    expect(container.textContent).toContain("Wrong size");
    expect(container.textContent).not.toContain("Second most common");
  });

  it("renders the highlight strip when approvedCount>0 even with no topReasons", async () => {
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: {
        ...baseLoaderData,
        topReasons: [],
        approvedCount: 4,
      },
    });
    await waitFor(() => {
      expect(container.querySelector(".dashboard-highlight-strip")).toBeTruthy();
    });
    expect(container.textContent).toContain("Approval rate");
    expect(container.textContent).not.toContain("Top return reason");
  });

  it("hides the period-change pill when periodChange === 0", async () => {
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: { ...baseLoaderData, periodChange: 0 },
    });
    await waitFor(() => {
      expect(container.querySelector(".dashboard-hero-grid")).toBeTruthy();
    });
    expect(container.querySelector(".kpi-change--up")).toBeFalsy();
    expect(container.querySelector(".kpi-change--down")).toBeFalsy();
  });

  it("renders the down-arrow period-change pill when periodChange < 0", async () => {
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: { ...baseLoaderData, periodChange: -8 },
    });
    await waitFor(() => {
      expect(container.querySelector(".kpi-change--down")).toBeTruthy();
    });
    expect(container.textContent).toContain("8%");
  });

  it("renders an info-style suggestion when the suggestion type is not warning", async () => {
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: {
        ...baseLoaderData,
        suggestions: [
          {
            type: "info" as const,
            message: "Heads up: try the new feature.",
            action: "Learn more",
            actionUrl: "/app/whats-new",
          },
          {
            type: "success" as const,
            message: "All caught up.",
          },
        ],
      },
    });
    await waitFor(() => {
      expect(container.querySelector(".dashboard-suggestions")).toBeTruthy();
    });
    expect(container.textContent).toContain("Heads up: try the new feature.");
    expect(container.textContent).toContain("All caught up.");
    expect(container.querySelector(".dashboard-suggestion--info")).toBeTruthy();
    expect(container.querySelector(".dashboard-suggestion--success")).toBeTruthy();
  });

  it("renders the custom date-range inputs when range='custom'", async () => {
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: {
        ...baseLoaderData,
        range: "custom",
        from: "2025-01-01",
        to: "2025-01-31",
      },
    });
    await waitFor(() => {
      expect(container.querySelector(".dashboard-date-bar")).toBeTruthy();
    });
    const dateInputs = container.querySelectorAll('input[type="date"]');
    expect(dateInputs.length).toBe(2);
    expect((dateInputs[0] as HTMLInputElement).value).toBe("2025-01-01");
    expect((dateInputs[1] as HTMLInputElement).value).toBe("2025-01-31");
  });

  it("invokes handleRangeChange when the date-range <select> changes", async () => {
    // Firing a change event on the toolbar's <select> exercises the
    // handleRangeChange callback (which clears `from`/`to` for non-custom
    // selections via setSearchParams).
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app?range=last_30_days"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector(".dashboard-date-bar")).toBeTruthy();
    });
    const select = container.querySelector("select") as HTMLSelectElement;
    expect(select).toBeTruthy();
    // Fire a non-custom change so the `if (newRange !== "custom")` branch runs.
    fireEvent.change(select, { target: { value: "last_7_days" } });
    // And then a custom change to cover the false branch.
    fireEvent.change(select, { target: { value: "custom" } });
  });

  it("invokes handleCustomRange when either date input changes", async () => {
    // Firing change events on the from/to date inputs covers the inline
    // arrow callbacks that build up the custom range.
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app?range=custom&from=2025-01-01&to=2025-01-31"],
      loaderData: {
        ...baseLoaderData,
        range: "custom",
        from: "2025-01-01",
        to: "2025-01-31",
      },
    });
    await waitFor(() => {
      const inputs = container.querySelectorAll('input[type="date"]');
      expect(inputs.length).toBe(2);
    });
    const [fromInput, toInput] = Array.from(
      container.querySelectorAll('input[type="date"]'),
    ) as HTMLInputElement[];
    fireEvent.change(fromInput, { target: { value: "2025-02-01" } });
    fireEvent.change(toInput, { target: { value: "2025-02-28" } });
  });

  it("falls back gracefully when the custom-range from/to are undefined and inputs change", async () => {
    // Drives the `from ?? ""` / `to ?? ""` nullish-coalescing branches in
    // both the `value` prop and the change handler.
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app?range=custom"],
      loaderData: {
        ...baseLoaderData,
        range: "custom",
        from: undefined,
        to: undefined,
      },
    });
    await waitFor(() => {
      const inputs = container.querySelectorAll('input[type="date"]');
      expect(inputs.length).toBe(2);
    });
    const [fromInput, toInput] = Array.from(
      container.querySelectorAll('input[type="date"]'),
    ) as HTMLInputElement[];
    expect(fromInput.value).toBe("");
    expect(toInput.value).toBe("");
    fireEvent.change(fromInput, { target: { value: "2025-03-01" } });
    fireEvent.change(toInput, { target: { value: "2025-03-15" } });
  });

  it("renders fraud-alert rows with both critical and high risk styling", async () => {
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: {
        ...baseLoaderData,
        fraudAlertCount: 3,
        fraudAlertReturns: [
          {
            id: "rc_critical",
            customerName: "Critical Customer",
            customerEmailNorm: "crit@example.com",
            fraudRiskLevel: "critical",
            fraudRiskScore: 95,
            shopifyOrderName: "#9100",
          },
          {
            id: "rc_high",
            customerName: null,
            customerEmailNorm: "high@example.com",
            fraudRiskLevel: "high",
            fraudRiskScore: 72,
            shopifyOrderName: "#9101",
          },
          {
            id: "rc_unknown",
            customerName: null,
            customerEmailNorm: null,
            fraudRiskLevel: null,
            fraudRiskScore: null,
            shopifyOrderName: "#9102",
          },
        ],
      },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fraud Alerts (3)");
    });
    expect(container.textContent).toContain("Critical Customer");
    expect(container.textContent).toContain("high@example.com");
    expect(container.textContent).toContain("Unknown");
    expect(container.textContent).toContain("Score: —");
    expect(container.textContent).toContain("CRITICAL");
    expect(container.textContent).toContain("HIGH");
  });
});

describe("Dashboard ErrorBoundary export", () => {
  it("is a function component", () => {
    expect(typeof ErrorBoundary).toBe("function");
  });

  it("renders an Error message when the loader throws an Error", async () => {
    const { container } = renderErrorBoundary(new Error("boom!"));
    await waitFor(() => {
      expect(container.querySelector(".app-alert-error")).toBeTruthy();
    });
    expect(container.textContent).toContain("boom!");
    expect(container.textContent).toContain("View Returns");
    expect(container.textContent).toContain("Settings");
    expect(container.textContent).toContain("Portal");
  });

  it("renders the route error response data when a Response-shaped error is thrown", async () => {
    const resp = new Response("Upstream service blew up.", { status: 500 });
    const { container } = renderErrorBoundary(resp);
    await waitFor(() => {
      expect(container.querySelector(".app-alert-error")).toBeTruthy();
    });
    expect(container.textContent).toContain("Upstream service blew up.");
  });

  it("falls back to the generic 'Error <status>' message when the response has no data body", async () => {
    const resp = new Response("", { status: 418 });
    const { container } = renderErrorBoundary(resp);
    await waitFor(() => {
      expect(container.querySelector(".app-alert-error")).toBeTruthy();
    });
    expect(container.textContent).toContain("Error 418");
  });

  it("falls back to the generic 'unexpected error' copy for non-Error, non-response thrown values", async () => {
    const { container } = renderErrorBoundary({ weird: true });
    await waitFor(() => {
      expect(container.querySelector(".app-alert-error")).toBeTruthy();
    });
    expect(container.textContent).toContain("An unexpected error occurred.");
  });
});
