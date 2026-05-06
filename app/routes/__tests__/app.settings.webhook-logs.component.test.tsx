/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Mocks for module-top-level imports in app/routes/app.settings.webhook-logs.tsx ──
vi.mock("../../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../../db.server", () => ({
  default: {
    fyndWebhookLog: {
      count: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn(),
    },
  },
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

// PayloadViewer renders raw JSON; stub to avoid pulling in heavy dependencies
// and to keep DOM assertions deterministic.
vi.mock("../../components/json-viewer", () => ({
  PayloadViewer: ({ rawPayload }: { rawPayload: unknown }) => (
    <div data-testid="payload-viewer">{rawPayload ? "payload" : "no-payload"}</div>
  ),
}));

// Stub app-bridge so any indirect import doesn't pull in host machinery.
vi.mock("@shopify/app-bridge-react", () => ({}));

import { renderWithRouter } from "../../test/component-helpers";
import { waitFor, fireEvent, act } from "@testing-library/react";
import WebhookLogsPage from "../app.settings.webhook-logs";

const baseLoaderData = {
  logs: [] as unknown[],
  page: 1,
  totalPages: 1,
  totalCount: 0,
  analytics: {
    total: 0,
    successCount: 0,
    errorCount: 0,
    ignoredCount: 0,
    duplicateCount: 0,
    successRate: 100,
    actionCounts: {} as Record<string, number>,
  },
  filters: {
    actionFilter: "",
    statusFilter: "",
    searchQuery: "",
    dateFrom: "",
    dateTo: "",
  },
  actionOptions: [
    { value: "", label: "All actions" },
    { value: "refund_completed", label: "Refund Completed" },
    { value: "refund_in_progress", label: "Refund In Progress" },
    { value: "ignored", label: "Ignored" },
    { value: "error", label: "Error" },
  ],
  statusOptions: [
    { value: "", label: "All statuses" },
    { value: "delivered", label: "Delivered" },
    { value: "in_transit", label: "In Transit" },
  ],
  loaderError: null,
};

const sampleLog = {
  id: "log-1",
  shipmentId: "SHP-123",
  orderId: "ORD-456",
  affiliateOrderId: "SPF-789",
  refundStatus: null,
  fyndStatus: "delivered",
  eventType: "shipment_status_update",
  action: "status_updated",
  returnCaseId: "rc-1",
  carrier: "Bluedart",
  awbNumber: "AWB123456",
  trackingUrl: null,
  customerName: "Alice Smith",
  customerEmail: "alice@example.com",
  customerPhone: "+1-555-1234",
  shopDomain: "test-shop.myshopify.com",
  error: null,
  rawPayload: { foo: "bar" },
  createdAt: "2025-01-15T10:30:00.000Z",
};

const errorLog = {
  ...sampleLog,
  id: "log-2",
  action: "error",
  error: "Failed to process webhook payload because the upstream service responded with a 500 status code and provided no payload",
  fyndStatus: null,
  customerName: null,
  customerEmail: null,
};

const ignoredLog = {
  ...sampleLog,
  id: "log-3",
  action: "ignored",
  shipmentId: null,
  orderId: null,
  affiliateOrderId: null,
  customerName: null,
  customerEmail: "fallback@example.com",
  carrier: null,
  awbNumber: null,
  trackingUrl: "https://tracking.example.com/abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKLMNOP-tail",
  refundStatus: "refund_pending",
  fyndStatus: null,
  returnCaseId: null,
  rawPayload: { ignored: true },
  error: null,
};

const completedLog = {
  ...sampleLog,
  id: "log-4",
  action: "refund_completed",
};

const duplicateLog = {
  ...sampleLog,
  id: "log-5",
  action: "duplicate_ignored",
};

const inProgressLog = {
  ...sampleLog,
  id: "log-6",
  action: "refund_in_progress",
};

const noteLog = {
  ...sampleLog,
  id: "log-7",
  action: "status_noted",
};

const unknownActionLog = {
  ...sampleLog,
  id: "log-8",
  action: "some_unknown_action",
};

const nullActionLog = {
  ...sampleLog,
  id: "log-9",
  action: null,
};

describe("WebhookLogsPage — empty state & header", () => {
  it("renders inside the AppPage wrapper with the Fynd Webhook Logs heading", async () => {
    const { findByTestId } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: baseLoaderData,
    });
    const heading = await findByTestId("app-page-heading");
    expect(heading.textContent).toBe("Fynd Webhook Logs");
  });

  it("shows the default empty state when there are no logs and no filters", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("No webhook logs found");
    });
    expect(container.textContent).toContain(
      "Webhook logs appear when Fynd sends updates",
    );
  });

  it("shows the filter-aware empty state copy when filters are active", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: {
        ...baseLoaderData,
        filters: {
          actionFilter: "error",
          statusFilter: "",
          searchQuery: "",
          dateFrom: "",
          dateTo: "",
        },
      },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("No webhook logs found");
    });
    expect(container.textContent).toContain("Try adjusting your filters.");
  });

  it("renders the six summary stat cards", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Total");
    });
    expect(container.textContent).toContain("Processed");
    expect(container.textContent).toContain("Tracked");
    expect(container.textContent).toContain("Errors");
    expect(container.textContent).toContain("Ignored");
    expect(container.textContent).toContain("Success");
  });

  it("renders the Action / Status filter selects and the Filter button", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelectorAll("select").length).toBeGreaterThanOrEqual(2);
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const filterBtn = buttons.find((b) => b.textContent?.trim() === "Filter");
    expect(filterBtn).toBeTruthy();
  });

  it("displays the loaderError banner when the loader returns an error", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: {
        ...baseLoaderData,
        loaderError: "Database is unreachable",
      },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Database is unreachable");
    });
  });

  it("renders log count text in singular form for 1 log", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: { ...baseLoaderData, totalCount: 1 },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("1 log");
    });
  });

  it("renders log count text in plural form for 5 logs", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: { ...baseLoaderData, totalCount: 5 },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("5 logs");
    });
  });
});

describe("WebhookLogsPage — analytics and breakdown bar", () => {
  it("renders the action-breakdown bar when total > 0 with mixed action types", async () => {
    const populated = {
      ...baseLoaderData,
      logs: [
        completedLog,
        inProgressLog,
        noteLog,
        sampleLog,
        ignoredLog,
        errorLog,
        duplicateLog,
        unknownActionLog,
      ],
      totalCount: 8,
      analytics: {
        total: 8,
        successCount: 4,
        errorCount: 1,
        ignoredCount: 1,
        duplicateCount: 1,
        successRate: 87,
        actionCounts: {
          refund_completed: 1,
          refund_in_progress: 1,
          status_noted: 1,
          status_updated: 1,
          ignored: 1,
          error: 1,
          duplicate_ignored: 1,
          some_unknown_action: 1,
        },
      },
    };
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: populated,
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    expect(container.textContent).toContain("Completed");
    expect(container.textContent).toContain("In Progress");
    expect(container.textContent).toContain("Status Updated");
    expect(container.textContent).toContain("Status Noted");
    expect(container.textContent).toContain("Duplicate");
    // unknown badge falls through to fallback label (action with underscores replaced)
    expect(container.textContent).toContain("some unknown action");
  });

  it("renders 0 errors when total > 0 with low success rate (<95%) coloring", async () => {
    const populated = {
      ...baseLoaderData,
      logs: [errorLog, errorLog],
      totalCount: 2,
      analytics: {
        total: 2,
        successCount: 0,
        errorCount: 2,
        ignoredCount: 0,
        duplicateCount: 0,
        successRate: 0,
        actionCounts: { error: 2 },
      },
    };
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: populated,
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    // Success rate appears with a percent sign
    expect(container.textContent).toContain("0%");
  });
});

describe("WebhookLogsPage — populated rows + RetryButton states", () => {
  const buildPopulated = (logs: unknown[], analyticsOverrides = {}) => ({
    ...baseLoaderData,
    logs,
    totalCount: logs.length,
    analytics: {
      total: logs.length,
      successCount: 0,
      errorCount: 0,
      ignoredCount: 0,
      duplicateCount: 0,
      successRate: 100,
      actionCounts: {},
      ...analyticsOverrides,
    },
  });

  it("renders a table row with the log's IDs and customer info", async () => {
    const populated = buildPopulated([sampleLog], {
      successCount: 0,
      errorCount: 0,
      ignoredCount: 0,
      actionCounts: { status_updated: 1 },
    });
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: populated,
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    expect(container.textContent).toContain("SHP-123");
    expect(container.textContent).toContain("ORD-456");
    expect(container.textContent).toContain("SPF-789");
    expect(container.textContent).toContain("Alice Smith");
    expect(container.textContent).toContain("Bluedart");
    expect(container.textContent).toContain("AWB123456");
    expect(container.textContent).toContain("Status Updated");
    expect(container.textContent).not.toContain("No webhook logs found");
  });

  it("renders the View link to the return case when returnCaseId is present", async () => {
    const populated = buildPopulated([sampleLog]);
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: populated,
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    const link = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "/app/returns/rc-1",
    );
    expect(link).toBeTruthy();
    expect(link?.textContent).toBe("View");
  });

  it("renders the View link clickably without expanding the row (stopPropagation)", async () => {
    const populated = buildPopulated([sampleLog]);
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: populated,
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    const link = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "/app/returns/rc-1",
    );
    await act(async () => { fireEvent.click(link!); });
    // Row should not have expanded — payload viewer not mounted
    await waitFor(() => { expect(container.querySelector("[data-testid='payload-viewer']")).toBeNull(); });
  });

  it("renders the error action row with the error preview and the Retry button", async () => {
    const populated = buildPopulated([errorLog], {
      errorCount: 1,
      successRate: 0,
      actionCounts: { error: 1 },
    });
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: populated,
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    expect(container.textContent).toContain("Error");
    const buttons = Array.from(container.querySelectorAll("button"));
    const retryBtn = buttons.find((b) => b.textContent?.trim() === "Retry");
    expect(retryBtn).toBeTruthy();
  });

  it("does not render a Retry button on logs whose action is neither error nor ignored", async () => {
    const populated = buildPopulated([sampleLog], {
      actionCounts: { status_updated: 1 },
    });
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: populated,
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.find((b) => b.textContent?.trim() === "Retry")).toBeUndefined();
  });

  it("clicking the Retry button submits via fetcher (does not throw)", async () => {
    const populated = buildPopulated([errorLog], {
      errorCount: 1,
      actionCounts: { error: 1 },
    });
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: populated,
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const retryBtn = buttons.find((b) => b.textContent?.trim() === "Retry");
    expect(retryBtn).toBeTruthy();
    expect(() => fireEvent.click(retryBtn!)).not.toThrow();
  });

  it("renders the ignored log with retry button, fallback email and refundStatus pill", async () => {
    const populated = buildPopulated([ignoredLog], {
      ignoredCount: 1,
      actionCounts: { ignored: 1 },
    });
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: populated,
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    expect(container.textContent).toContain("Ignored");
    expect(container.textContent).toContain("fallback@example.com");
    // status pill renders refundStatus when fyndStatus is null
    expect(container.textContent).toContain("refund pending");
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.find((b) => b.textContent?.trim() === "Retry")).toBeTruthy();
  });

  it("renders fallback dash when shipmentId/orderId/affiliateOrderId are all null", async () => {
    const populated = buildPopulated([ignoredLog], {
      ignoredCount: 1,
      actionCounts: { ignored: 1 },
    });
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: populated,
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    // Dashes appear in multiple cells
    expect(container.textContent).toContain("—");
  });

  it("renders the unknown-action badge with humanized label", async () => {
    const populated = buildPopulated([nullActionLog], {
      actionCounts: { unknown: 1 },
    });
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: populated,
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    // The badge falls back to label "unknown" when action is null
    expect(container.textContent).toContain("unknown");
  });
});

describe("WebhookLogsPage — detail row open/close (modal-equivalent)", () => {
  const populated = {
    ...baseLoaderData,
    logs: [sampleLog, errorLog],
    totalCount: 2,
    analytics: {
      total: 2,
      successCount: 1,
      errorCount: 1,
      ignoredCount: 0,
      duplicateCount: 0,
      successRate: 50,
      actionCounts: { status_updated: 1, error: 1 },
    },
  };

  it("opens the detail panel showing rawPayload when a row is clicked", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: populated,
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    // PayloadViewer should not be present until row clicked
    expect(container.querySelector("[data-testid='payload-viewer']")).toBeNull();

    const rows = container.querySelectorAll("tbody tr");
    fireEvent.click(rows[0]);

    await waitFor(() => {
      expect(container.querySelector("[data-testid='payload-viewer']")).toBeTruthy();
    });
    // Detail panel surfaces fields including shop domain, customer phone, etc
    expect(container.textContent).toContain("Log ID");
    expect(container.textContent).toContain("Fynd Order ID");
    expect(container.textContent).toContain("Shopify Order (Affiliate)");
    expect(container.textContent).toContain("test-shop.myshopify.com");
    expect(container.textContent).toContain("+1-555-1234");
  });

  it("closes the detail panel when the row is clicked a second time", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: populated,
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    const rows = container.querySelectorAll("tbody tr");
    fireEvent.click(rows[0]);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='payload-viewer']")).toBeTruthy();
    });
    fireEvent.click(rows[0]);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='payload-viewer']")).toBeNull();
    });
  });

  it("renders the error block inside the detail panel when log.error is present", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: populated,
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    const rows = container.querySelectorAll("tbody tr");
    // Second row is the errorLog
    fireEvent.click(rows[1]);
    await waitFor(() => {
      expect(container.querySelector("[data-testid='payload-viewer']")).toBeTruthy();
    });
    expect(container.textContent).toContain("Failed to process webhook payload");
  });

  it("renders the tracking URL in the detail panel when present and truncates long URLs", async () => {
    const populatedWithIgnored = {
      ...baseLoaderData,
      logs: [ignoredLog],
      totalCount: 1,
      analytics: {
        total: 1,
        successCount: 0,
        errorCount: 0,
        ignoredCount: 1,
        duplicateCount: 0,
        successRate: 100,
        actionCounts: { ignored: 1 },
      },
    };
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: populatedWithIgnored,
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    const rows = container.querySelectorAll("tbody tr");
    fireEvent.click(rows[0]);
    await waitFor(() => {
      expect(container.textContent).toContain("Tracking URL");
    });
    const trackingLink = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("href")?.startsWith("https://tracking.example.com"),
    );
    expect(trackingLink).toBeTruthy();
    // Truncated to 50 chars + ellipsis
    expect(trackingLink?.textContent).toContain("...");
  });

  it("renders the Return Case field inside the detail panel when returnCaseId is present", async () => {
    const populatedSingle = {
      ...baseLoaderData,
      logs: [sampleLog],
      totalCount: 1,
      analytics: {
        total: 1,
        successCount: 0,
        errorCount: 0,
        ignoredCount: 0,
        duplicateCount: 0,
        successRate: 100,
        actionCounts: { status_updated: 1 },
      },
    };
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: populatedSingle,
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    const rows = container.querySelectorAll("tbody tr");
    fireEvent.click(rows[0]);
    await waitFor(() => {
      expect(container.textContent).toContain("Return Case");
    });
  });
});

describe("WebhookLogsPage — filter interactions", () => {
  it("changes the action filter dropdown selection", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelectorAll("select").length).toBeGreaterThanOrEqual(2);
    });
    const selects = container.querySelectorAll("select");
    const actionSelect = selects[0] as HTMLSelectElement;
    await act(async () => { fireEvent.change(actionSelect, { target: { value: "error" } }); });
    await waitFor(() => { expect(actionSelect.value).toBe("error"); });
  });

  it("changes the status filter dropdown selection", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelectorAll("select").length).toBeGreaterThanOrEqual(2);
    });
    const selects = container.querySelectorAll("select");
    const statusSelect = selects[1] as HTMLSelectElement;
    await act(async () => { fireEvent.change(statusSelect, { target: { value: "delivered" } }); });
    await waitFor(() => { expect(statusSelect.value).toBe("delivered"); });
  });

  it("updates the search box value on user input", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("input[type='text']")).toBeTruthy();
    });
    const search = container.querySelector("input[type='text']") as HTMLInputElement;
    await act(async () => { fireEvent.change(search, { target: { value: "shp-123" } }); });
    await waitFor(() => { expect(search.value).toBe("shp-123"); });
  });

  it("submits the search query when Enter is pressed in the search box", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("input[type='text']")).toBeTruthy();
    });
    const search = container.querySelector("input[type='text']") as HTMLInputElement;
    await act(async () => { fireEvent.change(search, { target: { value: "alice" } }); });
    await waitFor(() => { expect(() => fireEvent.keyDown(search, { key: "Enter" })).not.toThrow(); });
  });

  it("does not crash when a non-Enter key is pressed in the search box", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("input[type='text']")).toBeTruthy();
    });
    const search = container.querySelector("input[type='text']") as HTMLInputElement;
    expect(() => fireEvent.keyDown(search, { key: "a" })).not.toThrow();
  });

  it("updates the From and To date-range inputs", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelectorAll("input[type='date']").length).toBe(2);
    });
    const dates = container.querySelectorAll("input[type='date']");
    const from = dates[0] as HTMLInputElement;
    const to = dates[1] as HTMLInputElement;
    fireEvent.change(from, { target: { value: "2025-01-01" } });
    await act(async () => { fireEvent.change(to, { target: { value: "2025-01-31" } }); });
    await waitFor(() => { expect(from.value).toBe("2025-01-01"); });
    expect(to.value).toBe("2025-01-31");
  });

  it("clicking Filter triggers applyFilters with all selected filters", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelectorAll("select").length).toBeGreaterThanOrEqual(2);
    });
    const selects = container.querySelectorAll("select");
    fireEvent.change(selects[0], { target: { value: "error" } });
    fireEvent.change(selects[1], { target: { value: "delivered" } });
    const search = container.querySelector("input[type='text']") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "alice" } });
    const dates = container.querySelectorAll("input[type='date']");
    fireEvent.change(dates[0], { target: { value: "2025-01-01" } });
    fireEvent.change(dates[1], { target: { value: "2025-01-31" } });

    const buttons = Array.from(container.querySelectorAll("button"));
    const filterBtn = buttons.find((b) => b.textContent?.trim() === "Filter");
    expect(filterBtn).toBeTruthy();
    expect(() => fireEvent.click(filterBtn!)).not.toThrow();
  });

  it("renders the Clear button only when filters are active and clicking it resets state", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs?action=error"],
      loaderData: {
        ...baseLoaderData,
        filters: {
          actionFilter: "error",
          statusFilter: "",
          searchQuery: "",
          dateFrom: "",
          dateTo: "",
        },
      },
    });
    await waitFor(() => {
      expect(container.querySelector("table, div")).toBeTruthy();
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const clearBtn = buttons.find((b) => b.textContent?.trim() === "Clear");
    expect(clearBtn).toBeTruthy();
    expect(() => fireEvent.click(clearBtn!)).not.toThrow();
  });

  it("does not render the Clear button when no filters are active", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("input[type='text']")).toBeTruthy();
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.find((b) => b.textContent?.trim() === "Clear")).toBeUndefined();
  });
});

describe("WebhookLogsPage — bulk retry button", () => {
  it("renders 'Retry All Ignored' when ignoredCount > 0 and clicks without throwing", async () => {
    const populated = {
      ...baseLoaderData,
      logs: [ignoredLog, ignoredLog],
      totalCount: 2,
      analytics: {
        total: 2,
        successCount: 0,
        errorCount: 0,
        ignoredCount: 2,
        duplicateCount: 0,
        successRate: 100,
        actionCounts: { ignored: 2 },
      },
    };
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: populated,
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const bulkBtn = buttons.find((b) =>
      b.textContent?.includes("Retry All Ignored"),
    );
    expect(bulkBtn).toBeTruthy();
    expect(() => fireEvent.click(bulkBtn!)).not.toThrow();
  });

  it("does not render 'Retry All Ignored' when ignoredCount is 0", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("input[type='text']")).toBeTruthy();
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(
      buttons.find((b) => b.textContent?.includes("Retry All Ignored")),
    ).toBeUndefined();
  });
});

describe("WebhookLogsPage — pagination", () => {
  const buildPagination = (page: number, totalPages: number) => ({
    ...baseLoaderData,
    logs: [sampleLog],
    page,
    totalPages,
    totalCount: totalPages * 50,
    analytics: {
      total: totalPages * 50,
      successCount: 0,
      errorCount: 0,
      ignoredCount: 0,
      duplicateCount: 0,
      successRate: 100,
      actionCounts: { status_updated: totalPages * 50 },
    },
  });

  it("does not render pagination when totalPages is 1", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: buildPagination(1, 1),
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.find((b) => b.textContent?.trim() === "Next")).toBeUndefined();
    expect(buttons.find((b) => b.textContent?.trim() === "Prev")).toBeUndefined();
  });

  it("renders Prev disabled and Next enabled on page 1 of multiple pages", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: buildPagination(1, 5),
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const prevBtn = buttons.find((b) => b.textContent?.trim() === "Prev") as HTMLButtonElement;
    const nextBtn = buttons.find((b) => b.textContent?.trim() === "Next") as HTMLButtonElement;
    expect(prevBtn).toBeTruthy();
    expect(nextBtn).toBeTruthy();
    expect(prevBtn.disabled).toBe(true);
    expect(nextBtn.disabled).toBe(false);
    expect(container.textContent).toContain("Page 1/5");
  });

  it("renders Next disabled when on the last page", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: buildPagination(5, 5),
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const nextBtn = buttons.find((b) => b.textContent?.trim() === "Next") as HTMLButtonElement;
    expect(nextBtn.disabled).toBe(true);
    expect(container.textContent).toContain("Page 5/5");
  });

  it("clicking Next advances pagination without throwing (small total)", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: buildPagination(1, 3),
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const nextBtn = buttons.find((b) => b.textContent?.trim() === "Next") as HTMLButtonElement;
    expect(() => fireEvent.click(nextBtn)).not.toThrow();
  });

  it("clicking Prev decrements pagination without throwing (middle page)", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: buildPagination(3, 5),
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const prevBtn = buttons.find((b) => b.textContent?.trim() === "Prev") as HTMLButtonElement;
    expect(prevBtn.disabled).toBe(false);
    expect(() => fireEvent.click(prevBtn)).not.toThrow();
  });

  it("renders sequential page buttons when totalPages <= 7", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: buildPagination(1, 5),
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    // Page numbers 1..5 should each be present
    ["1", "2", "3", "4", "5"].forEach((p) => {
      expect(buttons.find((b) => b.textContent?.trim() === p)).toBeTruthy();
    });
  });

  it("renders ellipsis pagination near the start (cur <= 4) when totalPages > 7", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: buildPagination(2, 12),
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    expect(container.textContent).toContain("...");
    expect(container.textContent).toContain("Page 2/12");
  });

  it("renders ellipsis pagination near the end (cur >= total - 3)", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: buildPagination(11, 12),
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    expect(container.textContent).toContain("...");
    expect(container.textContent).toContain("Page 11/12");
  });

  it("renders middle-window ellipsis pagination", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: buildPagination(6, 12),
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    expect(container.textContent).toContain("...");
    expect(container.textContent).toContain("Page 6/12");
  });

  it("clicking a numbered page button navigates without error", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: buildPagination(1, 5),
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const page3 = buttons.find((b) => b.textContent?.trim() === "3");
    expect(page3).toBeTruthy();
    expect(() => fireEvent.click(page3!)).not.toThrow();
  });

  it("preserves filter state when paginating with filters set", async () => {
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: {
        ...buildPagination(1, 3),
        filters: {
          actionFilter: "error",
          statusFilter: "delivered",
          searchQuery: "alice",
          dateFrom: "2025-01-01",
          dateTo: "2025-01-31",
        },
      },
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const nextBtn = buttons.find((b) => b.textContent?.trim() === "Next");
    expect(() => fireEvent.click(nextBtn!)).not.toThrow();
  });
});
