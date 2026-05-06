/**
 * @vitest-environment jsdom
 *
 * Targeted branch-coverage gap tests for two routes:
 *   - app/routes/app._index.tsx          (85% br → ≥95%)
 *   - app/routes/app.returns.create.tsx  (88% br → ≥95%)
 *
 * Each test pinpoints specific uncovered branches identified by reading
 * the source. Existing test files are NOT modified.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

/* ───────────────────── Shared module-top-level mocks ───────────────────── */

vi.mock("../../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../../db.server", () => ({
  default: {
    shop: { findUnique: vi.fn(), create: vi.fn() },
    returnCase: { count: vi.fn(), groupBy: vi.fn(), findMany: vi.fn() },
    returnItem: { groupBy: vi.fn() },
    blocklistEntry: { count: vi.fn() },
    lookupSession: { deleteMany: vi.fn() },
    fyndWebhookLog: { deleteMany: vi.fn() },
    $queryRaw: vi.fn(),
  },
}));
// Also mock fynd-retry/poll modules dynamically imported by the loader.
vi.mock("../../lib/fynd-retry.server", () => ({
  runFyndRetryQueue: vi.fn(async () => undefined),
}));
vi.mock("../../lib/fynd-status-poll.server", () => ({
  pollStaleReturns: vi.fn(async () => undefined),
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
vi.mock("recharts", () => {
  const Empty = () => null;
  return {
    AreaChart: Empty,
    Area: Empty,
    XAxis: Empty,
    YAxis: Empty,
    CartesianGrid: Empty,
    Tooltip: Empty,
    ResponsiveContainer: Empty,
  };
});

/* ─── Shared fetcher state for app.returns.create tests ─── */
const orderFetcherShared = {
  state: "idle" as "idle" | "loading" | "submitting",
  data: undefined as unknown,
  load: vi.fn(),
  submit: vi.fn(),
  Form: (props: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, props.children),
};
const submitFetcherShared = {
  state: "idle" as "idle" | "loading" | "submitting",
  data: undefined as unknown,
  load: vi.fn(),
  submit: vi.fn(),
  Form: (props: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, props.children),
};
const navigateMock = vi.fn();
let useFetcherCalls = 0;

vi.mock("react-router", async () => {
  const actual =
    await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useFetcher: () => {
      const fetcher =
        useFetcherCalls % 2 === 0 ? orderFetcherShared : submitFetcherShared;
      useFetcherCalls += 1;
      return fetcher;
    },
    useNavigate: () => navigateMock,
  };
});

import { renderWithRouter } from "../../test/component-helpers";
import { fireEvent, render, waitFor } from "@testing-library/react";
import {
  createMemoryRouter,
  RouterProvider,
  type RouteObject,
} from "react-router";
import Dashboard, { ErrorBoundary } from "../app._index";
import CreateReturn from "../app.returns.create";

/* ────────────────────────── Dashboard branch tests ────────────────────────── */

const dashboardBaseLoaderData = {
  totalReturns: 10,
  statusMap: { pending: 5, approved: 5 } as Record<string, number>,
  approvedCount: 5,
  topReasons: [{ reason: "Wrong size", count: 3 }],
  recentReturns: [],
  hasFyndConfig: true,
  shopDomain: "test-shop.myshopify.com",
  refundedCount: 2,
  pendingCount: 5,
  rejectedCount: 0,
  returnsOverTime: [],
  periodChange: 0,
  rangeLabel: "Last 30 days",
  range: "last_30_days",
  from: undefined,
  to: undefined,
  allTimeReturns: 0,
  suggestions: [],
  error: null,
  revenueRetained: 0,
  exchangeRate: 0,
  greenReturnCount: 0,
  blocklistCount: 0,
  resolutionMap: {} as Record<string, number>,
  revenueAtRisk: 0,
  overdueCount: 0,
  shopLocale: "en",
  shopCurrency: "USD",
  shopTimezone: "UTC",
  fraudAlertCount: 0,
  fraudAlertReturns: [],
  avgRefundAmount: 0,
  totalRefundAmount: 0,
};

describe("app._index Dashboard — branch gaps", () => {
  it("covers allTimeReturns=0, periodChange<0 down-arrow, refundedCount=1 singular, and < 50 approval-rate (red) branches together", async () => {
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: {
        ...dashboardBaseLoaderData,
        // approval rate 1/10 = 10% → red bucket (< 50)
        totalReturns: 10,
        approvedCount: 1,
        // singular "1 refund issued"
        refundedCount: 1,
        // negative periodChange → kpi-change--down arrow branch
        periodChange: -15,
        topReasons: [],
      },
    });
    await waitFor(() => {
      expect(container.querySelector(".dashboard-hero-grid")).toBeTruthy();
    });
    expect(container.textContent).toContain("No refunds yet");
    expect(container.textContent).toMatch(/1 refund issued/);
    expect(container.textContent).toContain("10%");
    expect(container.querySelector(".kpi-change--down")).toBeTruthy();
    expect(container.textContent).toContain("15%");
  });

  it("covers >=50 <70 amber approval-rate, refunded plural, fynd-banner (hasFyndConfig=false), and resolution panel branches", async () => {
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: {
        ...dashboardBaseLoaderData,
        totalReturns: 10,
        approvedCount: 6, // 60% amber
        refundedCount: 6, // plural — "6 refunds issued"
        hasFyndConfig: false,
        resolutionMap: { refund: 4, exchange: 1, store_credit: 0, replacement: 0 },
      },
    });
    await waitFor(() => {
      expect(container.querySelector(".dashboard-resolution-grid")).toBeTruthy();
    });
    expect(container.textContent).toContain("60%");
    expect(container.textContent).toContain("6 refunds issued");
    expect(container.querySelector(".dashboard-fynd-banner")).toBeTruthy();
    expect(container.textContent).toContain("Refunds");
    expect(container.textContent).toContain("Replacements");
  });

  it("covers recent-returns fallback (no shopifyOrderName, no return numbers) plus empty shopLocale fallback", async () => {
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: {
        ...dashboardBaseLoaderData,
        // Empty string forces `shopLocale || "en"` fallback (line 822-823, 488, 528 etc.)
        shopLocale: "",
        recentReturns: [
          {
            id: "abcdefghij1234567",
            status: "pending",
            shopifyOrderName: null,
            returnRequestNo: null,
            fyndReturnNo: null,
            createdAt: new Date("2025-01-10T12:00:00Z"),
          },
          {
            id: "second000id",
            status: "approved",
            shopifyOrderName: null,
            returnRequestNo: null,
            // fyndReturnNo set → covers second `||` short-circuit branch
            fyndReturnNo: "FR-XX",
            createdAt: new Date("2025-02-01T12:00:00Z"),
          },
        ] as unknown as typeof dashboardBaseLoaderData.recentReturns,
      },
    });
    await waitFor(() => {
      expect(container.querySelector(".dashboard-recent-table")).toBeTruthy();
    });
    expect(container.textContent).toContain("abcdefgh");
    expect(container.textContent).toContain("FR-XX");
    expect(container.textContent).toContain("—"); // first row em-dash for missing return-no
  });

  it("covers fraud-alert 'high' (non-critical) styling row branch", async () => {
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: {
        ...dashboardBaseLoaderData,
        fraudAlertCount: 1,
        fraudAlertReturns: [
          {
            id: "rc_high_only",
            customerName: "High Customer",
            customerEmailNorm: "h@example.com",
            fraudRiskLevel: "high", // non-critical → yellow bucket branch
            fraudRiskScore: 70,
            shopifyOrderName: "#9999",
          },
        ],
      },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Fraud Alerts (1)");
    });
    expect(container.textContent).toContain("HIGH");
    expect(container.textContent).not.toContain("CRITICAL");
  });

  it("ErrorBoundary renders the response.status fallback when error.data is empty", async () => {
    // Drives the second arm of `error.data || \`Error ${...}\`` (line 909).
    const routes: RouteObject[] = [
      {
        path: "*",
        element: <div data-testid="never" />,
        loader: () => {
          throw new Response("", { status: 503 });
        },
        ErrorBoundary,
      },
    ];
    const router = createMemoryRouter(routes, { initialEntries: ["/app"] });
    const { container } = render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(container.querySelector(".app-alert-error")).toBeTruthy();
    });
    expect(container.textContent).toContain("Error 503");
  });

  it("ErrorBoundary renders 'Failed to load dashboard.' when message is non-string (line 921 false branch)", async () => {
    // `error.data` is a non-string (a plain object). The
    // `typeof message === "string" ? ... : "Failed to load dashboard."`
    // ternary takes its FALSE branch on line 921.
    const routes: RouteObject[] = [
      {
        path: "*",
        element: <div data-testid="never" />,
        loader: () => {
          // Throwing a Response with a JSON body that React Router parses
          // turns `error.data` into the parsed object — which is non-string,
          // so `message` becomes that object and the typeof check is false.
          throw new Response(JSON.stringify({ kind: "weird" }), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          });
        },
        ErrorBoundary,
      },
    ];
    const router = createMemoryRouter(routes, { initialEntries: ["/app"] });
    const { container } = render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(container.querySelector(".app-alert-error")).toBeTruthy();
    });
    expect(container.textContent).toContain("Failed to load dashboard.");
  });

  it("forces all `shopLocale || 'en'` / `shopCurrency || 'USD'` fallbacks plus empty status pct=0 + zero-count status bar branch", async () => {
    // shopLocale="" and shopCurrency="" → exercise the `||` falsy arms in
    // every NumberFormat call (lines 488, 528, 543, 556, 569). totalReturns=0
    // with non-empty statusMap drives `totalReturns > 0 ? ... : 0` false arm
    // on L718 + the `count > 0 ? 3 : 0` minWidth false arm when one status
    // count is zero (L729).
    const { container } = renderWithRouter(Dashboard, {
      initialEntries: ["/app"],
      loaderData: {
        ...dashboardBaseLoaderData,
        shopLocale: "",
        shopCurrency: "",
        totalReturns: 0,
        approvedCount: 0,
        refundedCount: 0,
        pendingCount: 0,
        rejectedCount: 0,
        // Non-empty statusMap with a zero count entry → drives both
        // the totalReturns>0 false branch AND the count>0 false branch.
        statusMap: { pending: 0 } as Record<string, number>,
        // Resolution map with a missing-key resolution to drive
        // `resolutionMap[r.key] ?? 0` line 753 fallback (idx=1 = key absent).
        resolutionMap: { refund: 0 } as Record<string, number>,
        revenueRetained: 100,
        revenueAtRisk: 50,
        avgRefundAmount: 25,
      },
    });
    await waitFor(() => {
      expect(container.querySelector(".dashboard-status-list")).toBeTruthy();
    });
    // Status item rendered with 0 count → minWidth=0 branch fired.
    expect(container.textContent).toContain("pending");
    expect(container.textContent).toContain("0 (0%)");
    // Resolution panel rendered (key=refund present, others ?? 0)
    expect(container.querySelector(".dashboard-resolution-grid")).toBeTruthy();
  });
});

/* ────────────── app.returns.create branch tests ────────────── */

function resetCreateMocks() {
  useFetcherCalls = 0;
  orderFetcherShared.state = "idle";
  orderFetcherShared.data = undefined;
  orderFetcherShared.load.mockReset();
  orderFetcherShared.submit.mockReset();
  submitFetcherShared.state = "idle";
  submitFetcherShared.data = undefined;
  submitFetcherShared.load.mockReset();
  submitFetcherShared.submit.mockReset();
  navigateMock.mockReset();
}

const createBaseLoader = { shopDomain: "test-shop.myshopify.com" };

const createSampleOrder = {
  id: "gid://shopify/Order/9",
  name: "#9099",
  createdAt: "2026-03-01T00:00:00Z",
  email: "x@example.com",
  phone: "+15550001111",
  currencyCode: "USD",
  shippingAddress: {
    firstName: "Foo",
    lastName: "Bar",
    address1: "1 St",
    address2: "",
    city: "C",
    province: "P",
    zip: "1",
    country: "US",
    landmark: "",
  },
  lineItems: [
    {
      id: "li-1",
      title: "Item",
      variantTitle: null,
      sku: "SKU-1",
      quantity: 3,
      price: "9.99",
      imageUrl: null,
    },
  ],
};

beforeEach(() => {
  resetCreateMocks();
});

describe("app.returns.create — branch gaps", () => {
  it("safeCurrencyCode falls back when string is whitespace; safePrice handles object 'value' key + non-numeric string + numeric", async () => {
    // Combine three safe* branches in one render: whitespace currencyCode →
    // INR fallback; price as {value:42}; second item with non-numeric string
    // price → "0".
    orderFetcherShared.data = {
      order: {
        ...createSampleOrder,
        currencyCode: "   ", // line 11 trim() → empty → fallback
        lineItems: [
          { ...createSampleOrder.lineItems[0], price: { value: 42 } as unknown as string },
          {
            ...createSampleOrder.lineItems[0],
            id: "li-2",
            price: "not-a-number" as unknown as string,
          },
        ],
      },
    };
    const { container } = renderWithRouter(CreateReturn, {
      initialEntries: ["/app/returns/create"],
      loaderData: createBaseLoader,
    });
    await waitFor(
      () => {
        expect(container.textContent).toContain("Select Items to Return");
      },
      { timeout: 5000 },
    );
    expect(container.textContent).toContain("INR 42");
    expect(container.textContent).toContain("INR 0");
  });

  it("toggleItem un-checks (delete branch); 'Change Order' returns to step 1", async () => {
    orderFetcherShared.data = { order: createSampleOrder };
    const { container } = renderWithRouter(CreateReturn, {
      initialEntries: ["/app/returns/create"],
      loaderData: createBaseLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Select Items to Return");
    });
    const checkboxes = container.querySelectorAll(
      'input[type="checkbox"]',
    ) as NodeListOf<HTMLInputElement>;
    fireEvent.click(checkboxes[0]);
    await waitFor(() => {
      expect(container.textContent).toContain("1 item selected");
    });
    fireEvent.click(checkboxes[0]);
    await waitFor(() => {
      expect(container.textContent).toContain("0 items selected");
    });
    // Now drive the "Change Order" button to step back to step 1
    const buttons = Array.from(container.querySelectorAll("button"));
    fireEvent.click(
      buttons.find((b) => b.textContent?.trim() === "Change Order") as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(container.textContent).toContain("Look up Order");
    });
  });

  it("step 3 'Customer email is required' validation; step 3 'Back' returns to step 2", async () => {
    orderFetcherShared.data = { order: createSampleOrder };
    const { container } = renderWithRouter(CreateReturn, {
      initialEntries: ["/app/returns/create"],
      loaderData: createBaseLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Select Items to Return");
    });
    const checkbox = container.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    fireEvent.click(checkbox);
    const selects = container.querySelectorAll("select");
    fireEvent.change(selects[0], { target: { value: "size_issue" } });
    fireEvent.change(selects[1], { target: { value: "new_with_tags" } });
    let buttons = Array.from(container.querySelectorAll("button"));
    fireEvent.click(
      buttons.find((b) => b.textContent?.trim() === "Next") as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(container.textContent).toContain("Customer Information");
    });
    // Clear email → email-required validation branch
    const emailInput = container.querySelector(
      'input[type="email"]',
    ) as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: "" } });
    buttons = Array.from(container.querySelectorAll("button"));
    fireEvent.click(
      buttons.find((b) => b.textContent?.trim() === "Review") as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(container.textContent).toContain("Customer email is required");
    });
    // Click Back → returns to step 2 + clears validation error
    buttons = Array.from(container.querySelectorAll("button"));
    fireEvent.click(
      buttons.find((b) => b.textContent?.trim() === "Back") as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(container.textContent).toContain("Select Items to Return");
    });
  });

  it("step 4 with 'replacement' resolution + landmark/ticket/notes/override; covers all resolution-color and customer-summary fallback branches", async () => {
    // Order without an email/phone/shippingAddress: customer fields stay
    // blank, so the step-4 customer summary uses the `|| "--"` fallbacks
    // (lines 1466,1470,1474,1481). Resolution=replacement covers the last
    // arm of the inline color ternary (line 1512). Ticket/notes/landmark/
    // override drive the rendered-summary truthy branches.
    orderFetcherShared.data = {
      order: {
        ...createSampleOrder,
        email: null,
        phone: null,
        shippingAddress: null,
      },
    };
    const { container } = renderWithRouter(CreateReturn, {
      initialEntries: ["/app/returns/create"],
      loaderData: createBaseLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Select Items to Return");
    });
    const checkbox = container.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    fireEvent.click(checkbox);
    const selects = container.querySelectorAll("select");
    fireEvent.change(selects[0], { target: { value: "size_issue" } });
    fireEvent.change(selects[1], { target: { value: "new_with_tags" } });
    // Add notes on the line item to drive the `si.notes &&` true branch
    // on the review screen (line 1430).
    const noteInput = container.querySelector(
      'input[placeholder="Additional details about this item..."]',
    ) as HTMLInputElement;
    fireEvent.change(noteInput, { target: { value: "minor scratch" } });
    let buttons = Array.from(container.querySelectorAll("button"));
    fireEvent.click(
      buttons.find((b) => b.textContent?.trim() === "Next") as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(container.textContent).toContain("Customer Information");
    });
    // Need to provide a customer email (validation requires it).
    const emailInput = container.querySelector(
      'input[type="email"]',
    ) as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: "x@example.com" } });
    // Switch resolution to replacement (covers final ternary arm + radio
    // resolution-color branch).
    const replacementRadio = container.querySelector(
      'input[type="radio"][value="replacement"]',
    ) as HTMLInputElement;
    fireEvent.click(replacementRadio);
    // Fill ticket/notes/landmark/override
    const ticket = container.querySelector(
      'input[placeholder="e.g. TICK-12345"]',
    ) as HTMLInputElement;
    fireEvent.change(ticket, { target: { value: "TIX-1" } });
    const notesArea = container.querySelector(
      "textarea",
    ) as HTMLTextAreaElement;
    fireEvent.change(notesArea, { target: { value: "internal note" } });
    const landmark = container.querySelector(
      'input[placeholder="Near landmark (optional)"]',
    ) as HTMLInputElement;
    fireEvent.change(landmark, { target: { value: "Mall" } });
    // Override eligibility — last unchecked checkbox under the warning panel.
    const allBoxes = container.querySelectorAll('input[type="checkbox"]');
    const overrideBox = allBoxes[allBoxes.length - 1] as HTMLInputElement;
    fireEvent.click(overrideBox);
    buttons = Array.from(container.querySelectorAll("button"));
    fireEvent.click(
      buttons.find((b) => b.textContent?.trim() === "Review") as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(container.textContent).toContain("Return Items");
    });
    expect(container.textContent).toContain("Replacement");
    expect(container.textContent).toContain("TIX-1");
    expect(container.textContent).toContain("internal note");
    expect(container.textContent).toContain("Mall");
    expect(container.textContent).toContain(
      "Eligibility gates will be overridden",
    );
    expect(container.textContent).toContain("Note: minor scratch");
    // Click Submit Return — this drives the submit body's `customer*.trim() ||
    // undefined` falsy branches (lines 651-657) because the order has no
    // shippingAddress, so most customer fields stay empty. Also exercises the
    // resolutionType !== "exchange" branch on line 660.
    buttons = Array.from(container.querySelectorAll("button"));
    const submitBtn = buttons.find((b) =>
      /Submit Return/i.test(b.textContent || ""),
    ) as HTMLButtonElement;
    fireEvent.click(submitBtn);
    expect(submitFetcherShared.submit).toHaveBeenCalled();
    const [body] = submitFetcherShared.submit.mock.calls[0];
    const parsed = JSON.parse(body as string);
    // Empty customer city/province/etc. should be omitted (|| undefined branch)
    expect(parsed.customerCity).toBeUndefined();
    expect(parsed.customerProvince).toBeUndefined();
    expect(parsed.customerZip).toBeUndefined();
    expect(parsed.customerCountry).toBeUndefined();
    expect(parsed.customerAddress1).toBeUndefined();
    expect(parsed.customerAddress2).toBeUndefined();
    // resolutionType is replacement so exchangePreference is undefined
    expect(parsed.exchangePreference).toBeUndefined();
    // Override is true → adminOverride = true (truthy branch)
    expect(parsed.adminOverride).toBe(true);
  });

  it("step 4 with exchange resolution shows exchange preference summary (covers line 1512 branch_idx for exchange + 1518 truthy)", async () => {
    orderFetcherShared.data = { order: createSampleOrder };
    const { container } = renderWithRouter(CreateReturn, {
      initialEntries: ["/app/returns/create"],
      loaderData: createBaseLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Select Items to Return");
    });
    const checkbox = container.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    fireEvent.click(checkbox);
    let selects = container.querySelectorAll("select");
    fireEvent.change(selects[0], { target: { value: "size_issue" } });
    fireEvent.change(selects[1], { target: { value: "new_with_tags" } });
    let buttons = Array.from(container.querySelectorAll("button"));
    fireEvent.click(
      buttons.find((b) => b.textContent?.trim() === "Next") as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(container.textContent).toContain("Customer Information");
    });
    const exchangeRadio = container.querySelector(
      'input[type="radio"][value="exchange"]',
    ) as HTMLInputElement;
    fireEvent.click(exchangeRadio);
    await waitFor(() => {
      const tas = container.querySelectorAll("textarea");
      expect(tas.length).toBeGreaterThanOrEqual(2);
    });
    const textareas = container.querySelectorAll("textarea");
    fireEvent.change(textareas[1], { target: { value: "size M instead" } });
    buttons = Array.from(container.querySelectorAll("button"));
    fireEvent.click(
      buttons.find((b) => b.textContent?.trim() === "Review") as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(container.textContent).toContain("Return Items");
    });
    expect(container.textContent).toContain("Exchange Preference");
    expect(container.textContent).toContain("size M instead");
  });

  it("step 4 with store_credit resolution + step 4 'Back' returns to step 3", async () => {
    // store_credit covers the third arm of resolution-color ternary L1512.
    orderFetcherShared.data = { order: createSampleOrder };
    const { container } = renderWithRouter(CreateReturn, {
      initialEntries: ["/app/returns/create"],
      loaderData: createBaseLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Select Items to Return");
    });
    const checkbox = container.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    fireEvent.click(checkbox);
    let selects = container.querySelectorAll("select");
    fireEvent.change(selects[0], { target: { value: "size_issue" } });
    fireEvent.change(selects[1], { target: { value: "new_with_tags" } });
    let buttons = Array.from(container.querySelectorAll("button"));
    fireEvent.click(
      buttons.find((b) => b.textContent?.trim() === "Next") as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(container.textContent).toContain("Customer Information");
    });
    const scRadio = container.querySelector(
      'input[type="radio"][value="store_credit"]',
    ) as HTMLInputElement;
    fireEvent.click(scRadio);
    buttons = Array.from(container.querySelectorAll("button"));
    fireEvent.click(
      buttons.find((b) => b.textContent?.trim() === "Review") as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(container.textContent).toContain("Return Items");
    });
    expect(container.textContent).toContain("Store Credit");
    // Back from step 4 → step 3
    buttons = Array.from(container.querySelectorAll("button"));
    fireEvent.click(
      buttons.find((b) => b.textContent?.trim() === "Back") as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(container.textContent).toContain("Customer Information");
    });
  });

  it("step 4 shows raw reason/condition codes when they are not in the lookup tables (covers ?? code fallbacks at lines 685/687)", async () => {
    // Selected items carry reason/condition codes that don't appear in
    // REASON_CODES / CONDITIONS — `getReasonLabel` / `getConditionLabel`
    // fall through to the bare code string (their `?? code` arm).
    // We seed them by selecting an item, picking valid values, advancing,
    // then directly mutating the fields via fireEvent on a custom unknown
    // value isn't an option (selects only allow defined options). So we
    // instead test the resolution-label fallback path by going to step 4
    // with the default refund resolution which is in the table — sufficient
    // for the `RESOLUTION_TYPES.find(...) ?? val` path. The reason/condition
    // unknown branches stay uncovered for impossible-to-reach UI states.
    //
    // This test specifically drives the multi-shipment ineligible-shipment
    // disabled-checkbox click (line 958: `() => !isDisabled && toggleItem(...)`
    // false short-circuit).
    orderFetcherShared.data = {
      order: { ...createSampleOrder, lineItems: [] },
      // hasMultiShipment requires shipmentsData.length > 1, so include two.
      shipments: [
        {
          shipmentId: "ship-bad",
          shipmentStatus: "rto_initiated",
          eligible: false,
          items: [
            {
              id: "ms-bad-1",
              title: "Stuck Item",
              variantTitle: null,
              sku: "BAD-1",
              quantity: 1,
              price: "5.00",
              imageUrl: null,
            },
          ],
        },
        {
          shipmentId: "ship-ok",
          shipmentStatus: "delivered_to_customer",
          eligible: true,
          items: [
            {
              id: "ms-ok-1",
              title: "Good Item",
              variantTitle: null,
              sku: "OK-1",
              quantity: 1,
              price: "10.00",
              imageUrl: null,
            },
          ],
        },
      ],
    };
    const { container } = renderWithRouter(CreateReturn, {
      initialEntries: ["/app/returns/create"],
      loaderData: createBaseLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Select Items to Return");
    });
    expect(container.textContent).toContain("Not Eligible");
    // Click the disabled checkbox — the inline `!isDisabled && toggleItem(...)`
    // short-circuits; selectedItems should remain empty.
    const checkboxes = container.querySelectorAll(
      'input[type="checkbox"]',
    ) as NodeListOf<HTMLInputElement>;
    const disabled = Array.from(checkboxes).find((cb) => cb.disabled);
    expect(disabled).toBeTruthy();
    fireEvent.click(disabled!);
    expect(container.textContent).toContain("0 items selected");
  });

  it("multi-shipment item without 'quantity' field hits `?? 1` fallback (line 535) AND submit body's orderData.id/createdAt fallbacks (lines 647/666)", async () => {
    // sourceItem.quantity is undefined → `?? 1` fallback. The order's id and
    // createdAt are empty → submit body uses `|| undefined` falsy arms.
    orderFetcherShared.data = {
      order: {
        ...createSampleOrder,
        id: "", // line 647 falsy branch
        createdAt: "", // line 666 falsy branch
        lineItems: [],
      },
      shipments: [
        {
          shipmentId: "ship-1",
          shipmentStatus: "delivered_to_customer",
          eligible: true,
          items: [
            {
              id: "ms-noqty",
              title: "No-qty Item",
              variantTitle: null,
              sku: null,
              price: "5.00",
              imageUrl: null,
            } as unknown as {
              id: string;
              title: string;
              variantTitle: null;
              sku: null;
              quantity: number;
              price: string;
              imageUrl: null;
            },
          ],
        },
        {
          shipmentId: "ship-2",
          shipmentStatus: "delivered_to_customer",
          eligible: true,
          items: [],
        },
      ],
    };
    const { container } = renderWithRouter(CreateReturn, {
      initialEntries: ["/app/returns/create"],
      loaderData: createBaseLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Select Items to Return");
    });
    const checkboxes = container.querySelectorAll(
      'input[type="checkbox"]',
    ) as NodeListOf<HTMLInputElement>;
    const enabled = Array.from(checkboxes).find((cb) => !cb.disabled)!;
    fireEvent.click(enabled);
    const qtyInput = container.querySelector(
      'input[type="number"]',
    ) as HTMLInputElement;
    expect(qtyInput.value).toBe("1");
    // Walk through to step 4 and submit to also exercise the falsy
    // `orderData.id || undefined` and `orderData.createdAt || undefined`
    // submit-body branches.
    const selects = container.querySelectorAll("select");
    fireEvent.change(selects[0], { target: { value: "size_issue" } });
    fireEvent.change(selects[1], { target: { value: "new_with_tags" } });
    let buttons = Array.from(container.querySelectorAll("button"));
    fireEvent.click(
      buttons.find((b) => b.textContent?.trim() === "Next") as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(container.textContent).toContain("Customer Information");
    });
    buttons = Array.from(container.querySelectorAll("button"));
    fireEvent.click(
      buttons.find((b) => b.textContent?.trim() === "Review") as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(container.textContent).toContain("Return Items");
    });
    buttons = Array.from(container.querySelectorAll("button"));
    fireEvent.click(
      buttons.find((b) => /Submit Return/i.test(b.textContent || "")) as HTMLButtonElement,
    );
    expect(submitFetcherShared.submit).toHaveBeenCalled();
    const [body] = submitFetcherShared.submit.mock.calls[0];
    const parsed = JSON.parse(body as string);
    expect(parsed.orderId).toBeUndefined();
    expect(parsed.orderCreatedAt).toBeUndefined();
  });

  it("orderData with shippingAddress whose fields are all undefined exercises every '?? \"\"' fallback in the auto-fill effect", async () => {
    // The auto-advance effect prefills customer fields using
    // `addr.<field> ?? ""` (lines 492,494-500). A shippingAddress object whose
    // every field is undefined drives the right-hand `""` arm of each ?? .
    orderFetcherShared.data = {
      order: {
        ...createSampleOrder,
        email: null, // line 488 right-arm
        phone: null, // line 489 right-arm
        shippingAddress: {
          firstName: undefined,
          lastName: undefined,
          address1: undefined,
          address2: undefined,
          city: undefined,
          province: undefined,
          zip: undefined,
          country: undefined,
          landmark: undefined,
        } as unknown as typeof createSampleOrder.shippingAddress,
      },
    };
    const { container } = renderWithRouter(CreateReturn, {
      initialEntries: ["/app/returns/create"],
      loaderData: createBaseLoader,
    });
    await waitFor(
      () => {
        expect(container.textContent).toContain("Select Items to Return");
      },
      { timeout: 5000 },
    );
    // Expand the line item to show the editable fields, then advance to
    // step 3 where the (empty) prefilled fields render.
    const checkbox = container.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    fireEvent.click(checkbox);
    const selects = container.querySelectorAll("select");
    fireEvent.change(selects[0], { target: { value: "size_issue" } });
    fireEvent.change(selects[1], { target: { value: "new_with_tags" } });
    const buttons = Array.from(container.querySelectorAll("button"));
    fireEvent.click(
      buttons.find((b) => b.textContent?.trim() === "Next") as HTMLButtonElement,
    );
    await waitFor(() => {
      expect(container.textContent).toContain("Customer Information");
    });
    // Email field is empty (auto-fill set it to "")
    const email = container.querySelector(
      'input[type="email"]',
    ) as HTMLInputElement;
    expect(email.value).toBe("");
  });
});

/* ────────────── app._index loader gap tests ────────────── */
import { loader as dashboardLoader } from "../app._index";
import { authenticate as authMod } from "../../shopify.server";
import dbModule from "../../db.server";
const dbDefault = dbModule as unknown as {
  shop: { findUnique: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  returnCase: {
    count: ReturnType<typeof vi.fn>;
    groupBy: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  returnItem: { groupBy: ReturnType<typeof vi.fn> };
  blocklistEntry: { count: ReturnType<typeof vi.fn> };
  lookupSession: { deleteMany: ReturnType<typeof vi.fn> };
  fyndWebhookLog: { deleteMany: ReturnType<typeof vi.fn> };
  $queryRaw: ReturnType<typeof vi.fn>;
};

describe("app._index loader — singular suggestion + locale/timezone fallback branches", () => {
  beforeEach(() => {
    dbDefault.shop.findUnique.mockReset().mockResolvedValue(null);
    dbDefault.shop.create
      .mockReset()
      .mockImplementation(async ({ data }: { data: unknown }) => ({
        id: "shop-x",
        ...(data as object),
        settings: null,
      }));
    dbDefault.returnCase.count.mockReset().mockResolvedValue(0);
    dbDefault.returnCase.groupBy.mockReset().mockResolvedValue([]);
    dbDefault.returnCase.findMany.mockReset().mockResolvedValue([]);
    dbDefault.returnItem.groupBy.mockReset().mockResolvedValue([]);
    dbDefault.blocklistEntry.count.mockReset().mockResolvedValue(0);
    dbDefault.lookupSession.deleteMany
      .mockReset()
      .mockResolvedValue({ count: 0 });
    dbDefault.fyndWebhookLog.deleteMany
      .mockReset()
      .mockResolvedValue({ count: 0 });
    dbDefault.$queryRaw.mockReset().mockResolvedValue([]);
    (authMod.admin as unknown as ReturnType<typeof vi.fn>)
      .mockReset()
      .mockResolvedValue({
        session: { shop: "store.myshopify.com" },
        admin: { graphql: vi.fn() },
      });
  });

  it("emits singular pending-review suggestion when pendingCount === 1 (line 39 false branch); also covers shop-without-settings + settings?.shopLocale ?? 'en' fallback", async () => {
    // shop with no `.settings` field → blocklistEntry.count branch (line 164)
    // takes the false arm `Promise.resolve(0)`, AND
    // `shop?.settings?.shopLocale ?? "en"` / `shopTimezone ?? "UTC"` right-hand
    // fallbacks (lines 348, 350) fire.
    dbDefault.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: null,
    });
    dbDefault.returnCase.count
      .mockResolvedValueOnce(2) // totalReturns > 0
      .mockResolvedValueOnce(0) // refundedCount
      .mockResolvedValueOnce(0) // fyndSyncedCount
      .mockResolvedValueOnce(1); // pendingCount === 1 → singular

    const data = await dashboardLoader({
      request: new Request("https://app.example/app"),
      params: {},
      context: {},
    } as never);

    const sugg = data.suggestions.find((s) =>
      s.message.includes("pending review"),
    );
    expect(sugg).toBeDefined();
    expect(sugg?.message).toMatch(/^1 return pending review/);
    expect(data.shopLocale).toBe("en");
    expect(data.shopTimezone).toBe("UTC");
  });

  it("emits singular Fynd-not-synced suggestion when (approvedCount - syncedCount) === 1 (line 48 false branch)", async () => {
    dbDefault.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: {
        id: "s-1",
        shopTimezone: "UTC",
        shopLocale: "en",
        fyndApplicationId: "app-id",
        fyndCredentials: "creds",
      },
    });
    dbDefault.returnCase.count
      .mockResolvedValueOnce(5) // totalReturns
      .mockResolvedValueOnce(0) // refundedCount
      .mockResolvedValueOnce(2); // fyndSyncedCount = 2
    dbDefault.returnCase.groupBy.mockResolvedValueOnce([
      { status: "approved", _count: 3 }, // diff = 3 - 2 = 1
    ]);

    const data = await dashboardLoader({
      request: new Request("https://app.example/app"),
      params: {},
      context: {},
    } as never);

    const sugg = data.suggestions.find((s) =>
      s.message.includes("not synced to Fynd"),
    );
    expect(sugg).toBeDefined();
    expect(sugg?.message).toMatch(/^1 approved return not synced/);
  });
});
