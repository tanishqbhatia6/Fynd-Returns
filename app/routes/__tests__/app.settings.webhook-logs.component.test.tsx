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

import { renderWithRouter } from "../../test/component-helpers";
import { waitFor } from "@testing-library/react";
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
  actionOptions: [{ value: "", label: "All actions" }],
  statusOptions: [{ value: "", label: "All statuses" }],
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
  error: "Failed to process webhook payload",
  fyndStatus: null,
  customerName: null,
  customerEmail: null,
};

describe("WebhookLogsPage (default export) — empty state", () => {
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
    const selects = container.querySelectorAll("select");
    expect(selects.length).toBe(2);
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
});

describe("WebhookLogsPage (default export) — populated logs", () => {
  it("renders a table row with the log's IDs and customer info", async () => {
    const populated = {
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
    // Action label rendered via the badge map
    expect(container.textContent).toContain("Status Updated");
    // Empty-state copy should NOT be present when logs exist
    expect(container.textContent).not.toContain("No webhook logs found");
  });

  it("renders the View link to the return case when returnCaseId is present", async () => {
    const populated = {
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

  it("renders the error action row with truncated error text and the Retry button", async () => {
    const populated = {
      ...baseLoaderData,
      logs: [errorLog],
      totalCount: 1,
      analytics: {
        total: 1,
        successCount: 0,
        errorCount: 1,
        ignoredCount: 0,
        duplicateCount: 0,
        successRate: 0,
        actionCounts: { error: 1 },
      },
    };
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: populated,
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    expect(container.textContent).toContain("Error");
    // Error preview text rendered (truncated copy is fine — substring match)
    expect(container.textContent).toContain("Failed to process webhook payload");
    const buttons = Array.from(container.querySelectorAll("button"));
    const retryBtn = buttons.find((b) => b.textContent?.trim() === "Retry");
    expect(retryBtn).toBeTruthy();
  });
});
