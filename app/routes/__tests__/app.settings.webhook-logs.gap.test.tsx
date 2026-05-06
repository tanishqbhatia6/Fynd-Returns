/**
 * @vitest-environment jsdom
 *
 * Gap-coverage tests for app/routes/app.settings.webhook-logs.tsx — exercises
 * the RetryButton fetcher branches (lines 222, 226-232) and the bulk-retry
 * Refresh button onClick (line 506) by stubbing react-router's useFetcher and
 * useRevalidator hooks per scenario.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module-top-level mocks (must come before route import) ──
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
vi.mock("../../components/AppPage", () => ({
  AppPage: ({ heading, children }: { heading: string; children: React.ReactNode }) => (
    <div data-testid="app-page">
      <h1 data-testid="app-page-heading">{heading}</h1>
      {children}
    </div>
  ),
}));
vi.mock("../../components/json-viewer", () => ({
  PayloadViewer: ({ rawPayload }: { rawPayload: unknown }) => (
    <div data-testid="payload-viewer">{rawPayload ? "payload" : "no-payload"}</div>
  ),
}));
vi.mock("@shopify/app-bridge-react", () => ({}));

// ── Controllable fetcher / revalidator stubs ──
type FetcherState = {
  state: "idle" | "submitting" | "loading";
  data: unknown;
  submit: ReturnType<typeof vi.fn>;
};

const retryFetcher: FetcherState = {
  state: "idle",
  data: undefined,
  submit: vi.fn(),
};
const bulkFetcher: FetcherState = {
  state: "idle",
  data: undefined,
  submit: vi.fn(),
};
const revalidate = vi.fn();

let fetcherCallCount = 0;

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useFetcher: () => {
      // First useFetcher call inside WebhookLogsPage's render is for RetryButton
      // per row. The bulk fetcher in the page body is created via a SEPARATE
      // useFetcher call. The component calls the bulk one first (top of
      // WebhookLogsPage), then RetryButton calls the retry one.
      // We return the bulk fetcher on the first call and the retry fetcher
      // afterwards. This matches React's render order: parent useFetcher
      // executes before child component mounts.
      fetcherCallCount += 1;
      return fetcherCallCount === 1 ? bulkFetcher : retryFetcher;
    },
    useRevalidator: () => ({ revalidate, state: "idle" }),
  };
});

import { renderWithRouter } from "../../test/component-helpers";
import { waitFor, fireEvent, act } from "@testing-library/react";
import WebhookLogsPage, { loader } from "../app.settings.webhook-logs";
import prismaMod from "../../db.server";

 
const prisma: any = prismaMod;

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
    { value: "error", label: "Error" },
    { value: "ignored", label: "Ignored" },
  ],
  statusOptions: [
    { value: "", label: "All statuses" },
  ],
  loaderError: null,
};

const errorLog = {
  id: "log-err-1",
  shipmentId: "SHP-1",
  orderId: "ORD-1",
  affiliateOrderId: null,
  refundStatus: null,
  fyndStatus: null,
  eventType: null,
  action: "error",
  returnCaseId: null,
  carrier: null,
  awbNumber: null,
  trackingUrl: null,
  customerName: null,
  customerEmail: null,
  customerPhone: null,
  shopDomain: null,
  error: "boom",
  rawPayload: { x: 1 },
  createdAt: "2025-01-15T10:30:00.000Z",
};

const ignoredLog = {
  ...errorLog,
  id: "log-ign-1",
  action: "ignored",
  error: null,
};

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

beforeEach(() => {
  fetcherCallCount = 0;
  retryFetcher.state = "idle";
  retryFetcher.data = undefined;
  retryFetcher.submit = vi.fn();
  bulkFetcher.state = "idle";
  bulkFetcher.data = undefined;
  bulkFetcher.submit = vi.fn();
  revalidate.mockReset();
  // Reset prisma mocks between tests so loader tests don't bleed state.
  prisma.fyndWebhookLog.count.mockReset?.();
  prisma.fyndWebhookLog.findMany.mockReset?.();
  prisma.fyndWebhookLog.groupBy.mockReset?.();
  prisma.fyndWebhookLog.count.mockResolvedValue(0);
  prisma.fyndWebhookLog.findMany.mockResolvedValue([]);
  prisma.fyndWebhookLog.groupBy.mockResolvedValue([]);
});

describe("WebhookLogsPage gap — RetryButton fetcher branches (lines 222, 226-232)", () => {
  it("renders the '...' loading indicator when retry fetcher is submitting (line 222)", async () => {
    retryFetcher.state = "submitting";
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: buildPopulated([errorLog], {
        errorCount: 1,
        actionCounts: { error: 1 },
      }),
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    // Action cell should contain the '...' progress span and no 'Retry' button.
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.find((b) => b.textContent?.trim() === "Retry")).toBeUndefined();
    expect(container.textContent).toContain("...");
  });

  it("renders the '...' loading indicator on an ignored log when retry fetcher is loading", async () => {
    retryFetcher.state = "loading";
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: buildPopulated([ignoredLog], {
        ignoredCount: 1,
        actionCounts: { ignored: 1 },
      }),
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons.find((b) => b.textContent?.trim() === "Retry")).toBeUndefined();
    expect(container.textContent).toContain("...");
  });

  it("renders 'Matched!' when retry result is ok and action is non-ignored (lines 226-227)", async () => {
    retryFetcher.state = "idle";
    retryFetcher.data = { ok: true, action: "refund_completed" };
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: buildPopulated([errorLog], {
        errorCount: 1,
        actionCounts: { error: 1 },
      }),
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    expect(container.textContent).toContain("Matched!");
  });

  it("renders 'Still ignored' when retry result is ok and action remains 'ignored' (lines 229-230)", async () => {
    retryFetcher.state = "idle";
    retryFetcher.data = { ok: true, action: "ignored" };
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: buildPopulated([ignoredLog], {
        ignoredCount: 1,
        actionCounts: { ignored: 1 },
      }),
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    expect(container.textContent).toContain("Still ignored");
  });

  it("renders 'Failed' span (with title) when retry result is not ok (lines 232-235)", async () => {
    retryFetcher.state = "idle";
    retryFetcher.data = { ok: false, error: "Upstream 500" };
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: buildPopulated([errorLog], {
        errorCount: 1,
        actionCounts: { error: 1 },
      }),
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    expect(container.textContent).toContain("Failed");
    const failed = Array.from(container.querySelectorAll("span")).find(
      (s) => s.getAttribute("title") === "Upstream 500",
    );
    expect(failed).toBeTruthy();
  });

  it("renders 'Failed' fallback title when retry result has no error message", async () => {
    retryFetcher.state = "idle";
    retryFetcher.data = { ok: false };
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: buildPopulated([errorLog], {
        errorCount: 1,
        actionCounts: { error: 1 },
      }),
    });
    await waitFor(() => {
      expect(container.querySelector("table")).toBeTruthy();
    });
    const failed = Array.from(container.querySelectorAll("span")).find(
      (s) => s.getAttribute("title") === "Failed",
    );
    expect(failed).toBeTruthy();
  });
});

describe("WebhookLogsPage gap — bulk retry Refresh onClick (line 506)", () => {
  it("clicking Refresh after a successful bulk retry triggers revalidator.revalidate", async () => {
    bulkFetcher.state = "idle";
    bulkFetcher.data = { ok: true, total: 5, succeeded: 3, stillIgnored: 1, failed: 1 };
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: {
        ...baseLoaderData,
        analytics: {
          total: 5,
          successCount: 3,
          errorCount: 1,
          ignoredCount: 1,
          duplicateCount: 0,
          successRate: 80,
          actionCounts: { ignored: 1, error: 1, refund_completed: 3 },
        },
        totalCount: 5,
      },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Bulk retry complete");
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const refreshBtn = buttons.find((b) => b.textContent?.trim() === "Refresh");
    expect(refreshBtn).toBeTruthy();
    await act(async () => { fireEvent.click(refreshBtn!); });
    await waitFor(() => { expect(revalidate).toHaveBeenCalledTimes(1); });
  });

  it("renders the 'still ignored' yellow background variant when no successes and Refresh fires revalidate", async () => {
    bulkFetcher.state = "idle";
    bulkFetcher.data = { ok: true, total: 2, succeeded: 0, stillIgnored: 2, failed: 0 };
    const { container } = renderWithRouter(WebhookLogsPage, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: {
        ...baseLoaderData,
        analytics: {
          total: 2,
          successCount: 0,
          errorCount: 0,
          ignoredCount: 2,
          duplicateCount: 0,
          successRate: 100,
          actionCounts: { ignored: 2 },
        },
        totalCount: 2,
      },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Bulk retry complete");
    });
    expect(container.textContent).toContain("0 matched");
    expect(container.textContent).toContain("2 still ignored");
    const buttons = Array.from(container.querySelectorAll("button"));
    const refreshBtn = buttons.find((b) => b.textContent?.trim() === "Refresh");
    await act(async () => { fireEvent.click(refreshBtn!); });
    await waitFor(() => { expect(revalidate).toHaveBeenCalledTimes(1); });
  });
});

describe("loader gap — log mapping (line 106) + statusOptions (line 133) + catch path (lines 137-138)", () => {
  it("maps logs into the response payload (covers the inner map callback at line 106)", async () => {
    prisma.fyndWebhookLog.count.mockResolvedValueOnce(1);
    prisma.fyndWebhookLog.findMany
      // first findMany — page rows
      .mockResolvedValueOnce([
        {
          id: "log-1",
          shipmentId: "SHP-1",
          orderId: "ORD-1",
          affiliateOrderId: "AFF-1",
          refundStatus: null,
          fyndStatus: "delivered",
          eventType: "shipment_status_update",
          action: "status_updated",
          returnCaseId: "rc-1",
          carrier: "Bluedart",
          awbNumber: "AWB1",
          trackingUrl: null,
          customerName: "Alice",
          customerEmail: "a@x.com",
          customerPhone: "+1",
          shopDomain: "shop.myshopify.com",
          error: null,
          rawPayload: { x: 1 },
          createdAt: new Date("2025-01-15T10:30:00.000Z"),
        },
      ])
      // second findMany — distinctStatuses
      .mockResolvedValueOnce([{ fyndStatus: "delivered" }, { fyndStatus: null }]);
    prisma.fyndWebhookLog.groupBy.mockResolvedValueOnce([
      { action: "status_updated", _count: { id: 1 } },
    ]);

    const data = await loader({
      request: new Request("https://x"),
      params: {},
      context: {},
    } as never);

    expect(data.logs).toHaveLength(1);
    expect(data.logs[0]).toEqual(
      expect.objectContaining({
        id: "log-1",
        shipmentId: "SHP-1",
        affiliateOrderId: "AFF-1",
        action: "status_updated",
        createdAt: "2025-01-15T10:30:00.000Z",
      }),
    );
    // statusOptions includes "All statuses" + "delivered" (filter strips null)
    expect(data.statusOptions.length).toBeGreaterThanOrEqual(2);
    expect(data.statusOptions.find((o: { value: string }) => o.value === "delivered")).toBeTruthy();
  });

  it("returns the loaderError fallback when prisma rejects (covers catch block lines 137-138)", async () => {
    prisma.fyndWebhookLog.count.mockRejectedValueOnce(new Error("DB exploded"));
    // The other prisma calls don't matter once one rejects (Promise.all fails fast),
    // but they must still be defined so the loader doesn't blow up before throwing.
    prisma.fyndWebhookLog.findMany.mockResolvedValue([]);
    prisma.fyndWebhookLog.groupBy.mockResolvedValue([]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const data = await loader({
      request: new Request("https://x"),
      params: {},
      context: {},
    } as never);
    errSpy.mockRestore();

    expect(data.loaderError).toBe("DB exploded");
    expect(data.logs).toEqual([]);
    expect(data.totalPages).toBe(1);
    expect(data.totalCount).toBe(0);
    expect(data.actionOptions).toEqual([{ value: "", label: "All actions" }]);
    expect(data.statusOptions).toEqual([{ value: "", label: "All statuses" }]);
  });

  it("returns generic loaderError message when thrown value isn't an Error", async () => {
    prisma.fyndWebhookLog.count.mockImplementationOnce(() => {
      throw "non-error string";
    });
    prisma.fyndWebhookLog.findMany.mockResolvedValue([]);
    prisma.fyndWebhookLog.groupBy.mockResolvedValue([]);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const data = await loader({
      request: new Request("https://x"),
      params: {},
      context: {},
    } as never);
    errSpy.mockRestore();

    expect(data.loaderError).toBe("Failed to load webhook logs");
  });
});
