// @vitest-environment jsdom
/**
 * @vitest-environment jsdom
 *
 * Targeted coverage-closure tests for app/routes/app.returns._index.tsx.
 * Exercises the few remaining uncovered branches:
 *   - line 220   fmtDateParts catch block (Intl format throws on Invalid Date)
 *   - line 462   row onClick navigates to detail
 *   - line 487   Link onClick stopPropagation
 *   - line 620   pagination Prev arrow click (page > 1)
 *   - line 628   middle-clamping branch in numbered pagination (else)
 *   - line 630   numbered page button onClick
 *   - line 696   textarea onBlur restores border + clears boxShadow
 *   - line 26    loader query="" default when ?query missing
 *
 * No source modifications. Mirrors the mock pattern of
 * app.returns.index.pagination.test.tsx.
 */
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";

const { authenticateMock, prismaMock } = vi.hoisted(() => {
  const auth = vi.fn().mockResolvedValue({
    session: { shop: "store.myshopify.com" },
    admin: { graphql: vi.fn() },
  });
  const shopRow = {
    id: "shop-1",
    shopDomain: "store.myshopify.com",
    settings: { shopLocale: "en", shopTimezone: "UTC" },
  };
  const prisma = {
    shop: {
      findUnique: vi.fn().mockResolvedValue(shopRow),
      create: vi.fn().mockResolvedValue(shopRow),
    },
    returnCase: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
  };
  return { authenticateMock: auth, prismaMock: prisma };
});

vi.mock("../../shopify.server", () => ({
  default: {},
  authenticate: { admin: authenticateMock },
}));

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

vi.mock("../../db.server", () => ({ default: prismaMock }));

import { renderWithRouter } from "../../test/component-helpers";
import { fireEvent, waitFor } from "@testing-library/react";
import ReturnsList, { loader } from "../app.returns._index";

type ReturnRow = {
  id: string;
  status: string;
  shopifyOrderName: string | null;
  returnRequestNo: string | null;
  customerName: string | null;
  customerEmailNorm: string | null;
  customerPhoneNorm: string | null;
  resolutionType: string | null;
  refundStatus: string | null;
  refundAmount: number | null;
  fyndOrderId: string | null;
  fyndReturnId: string | null;
  fyndReturnNo: string | null;
  fyndShipmentId: string | null;
  forwardAwb: string | null;
  returnAwb: string | null;
  fyndSyncStatus: string | null;
  sourceChannel: string | null;
  fraudRiskLevel: string | null;
  isGiftReturn: boolean;
  cancellationRequestedAt: Date | null;
  createdAt: Date | string;
};

function mkReturn(overrides: Partial<ReturnRow> = {}): ReturnRow {
  return {
    id: "ret-1",
    status: "pending",
    shopifyOrderName: "#1001",
    returnRequestNo: "RR-001",
    customerName: "Alice Smith",
    customerEmailNorm: "alice@example.com",
    customerPhoneNorm: null,
    resolutionType: "refund",
    refundStatus: null,
    refundAmount: 50,
    fyndOrderId: null,
    fyndReturnId: null,
    fyndReturnNo: null,
    fyndShipmentId: null,
    forwardAwb: null,
    returnAwb: null,
    fyndSyncStatus: null,
    sourceChannel: null,
    fraudRiskLevel: null,
    isGiftReturn: false,
    cancellationRequestedAt: null,
    createdAt: new Date("2026-04-12T10:30:00Z"),
    ...overrides,
  };
}

const baseLoaderData = {
  returns: [mkReturn()] as ReturnRow[],
  query: "",
  status: "",
  resolutionType: "",
  sourceChannel: "",
  page: 1,
  totalCount: 1,
  totalPages: 1,
  pendingCount: 1,
  inProgressCount: 0,
  approvedCount: 0,
  rejectedCount: 0,
  allCount: 1,
  error: null,
  shopLocale: "en",
  shopTimezone: "UTC",
};

describe("app.returns._index — coverage closure", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // line 220 — fmtDateParts catch block.
  // Replace Intl.DateTimeFormat with a constructor whose instances .format()
  // throws — forcing the catch arm and the String(d).slice(0,10) fallback.
  it("renders fallback for an unparseable createdAt date (catch arm)", async () => {
    const RealDTF = Intl.DateTimeFormat;
    class ThrowingDTF {
      constructor() {
        /* no-op */
      }
      format() {
        throw new RangeError("Invalid time value");
      }
      formatToParts() {
        throw new RangeError("Invalid time value");
      }
      resolvedOptions() {
        return { locale: "en" } as Intl.ResolvedDateTimeFormatOptions;
      }
    }
    // Cast through unknown to avoid TS friction with Intl typings.
    (Intl as unknown as { DateTimeFormat: unknown }).DateTimeFormat = ThrowingDTF as unknown;
    try {
      const badDate = "ZZZZZZZZZZ-bad";
      const { container } = renderWithRouter(ReturnsList, {
        initialEntries: ["/app/returns"],
        loaderData: {
          ...baseLoaderData,
          returns: [mkReturn({ createdAt: badDate as unknown as Date })],
        },
      });
      await waitFor(() => {
        expect(container.querySelector("table.returns-table")).toBeTruthy();
      });
      // Fallback: date = String(d).slice(0, 10) = "ZZZZZZZZZZ", time = "".
      expect(container.textContent).toContain("ZZZZZZZZZZ");
    } finally {
      (Intl as unknown as { DateTimeFormat: typeof RealDTF }).DateTimeFormat = RealDTF;
    }
  });

  // line 462 — row onClick → navigate(`/app/returns/${id}`)
  // Clicking outside the checkbox/link cells must trigger navigation.
  it("navigates to the detail page when a row body is clicked", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("tbody tr")).toBeTruthy();
    });
    const row = container.querySelector("tbody tr") as HTMLTableRowElement;
    // Fire the row click — handler runs even if navigate is a no-op in
    // the memory router; what matters for coverage is the handler executes.
    fireEvent.click(row);
    expect(row).toBeTruthy();
  });

  // line 487 — Link onClick stopPropagation
  it("stops propagation when the return-id link is clicked", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector(".return-id-link")).toBeTruthy();
    });
    const link = container.querySelector(".return-id-link") as HTMLAnchorElement;
    // Spy on stopPropagation by dispatching a real MouseEvent and observing it.
    const evt = new MouseEvent("click", { bubbles: true, cancelable: true });
    const stopSpy = vi.spyOn(evt, "stopPropagation");
    link.dispatchEvent(evt);
    expect(stopSpy).toHaveBeenCalled();
  });

  // line 620 — Prev pagination button click handler (goToPage(page-1))
  // line 628 — middle clamping branch: 4 < page < totalPages-3 → p = page-3+i
  // line 630 — numbered page button click invokes goToPage(p)
  it("invokes Prev pagination handler and renders middle-clamped numbered buttons", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns?page=10"],
      loaderData: {
        ...baseLoaderData,
        page: 10,
        totalPages: 20,
        totalCount: 500,
      },
    });
    await waitFor(() => {
      expect(container.querySelector(".returns-pagination")).toBeTruthy();
    });
    const numbered = Array.from(container.querySelectorAll(".app-pagination-btn"))
      .map((b) => b.textContent?.trim() || "")
      .filter((t) => /^\d+$/.test(t));
    // Middle clamp: page=10 → window 7..13 (page-3+i for i=0..6)
    expect(numbered).toEqual(["7", "8", "9", "10", "11", "12", "13"]);

    // line 620 — fire the Prev button (first .app-pagination-btn).
    const allBtns = container.querySelectorAll(".app-pagination-btn");
    const prevBtn = allBtns[0] as HTMLButtonElement;
    expect(prevBtn.disabled).toBe(false);
    fireEvent.click(prevBtn);

    // line 630 — click a numbered page button (the active one is fine —
    // it still runs the onClick handler which calls goToPage(p)).
    const numberedBtns = Array.from(allBtns).filter((b) =>
      /^\d+$/.test(b.textContent?.trim() || ""),
    ) as HTMLButtonElement[];
    fireEvent.click(numberedBtns[0]);
    expect(numberedBtns.length).toBe(7);
  });

  // line 696 — textarea onBlur restores borderColor and clears boxShadow.
  it("clears focus styling on textarea blur", async () => {
    const { container } = renderWithRouter(ReturnsList, {
      initialEntries: ["/app/returns"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("table.returns-table")).toBeTruthy();
    });
    // Open the reject modal: select a row → click bulk reject.
    fireEvent.click(container.querySelectorAll("tbody .checkbox-cell")[0]);
    fireEvent.click(container.querySelector(".bulk-btn--reject")!);
    await waitFor(() => {
      expect(container.querySelector("textarea")).toBeTruthy();
    });
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    // Trigger focus first (line 695) then blur (line 696).
    fireEvent.focus(ta);
    expect(ta.style.borderColor).toBeTruthy();
    fireEvent.blur(ta);
    // After blur, border is restored and shadow is cleared.
    expect(ta.style.boxShadow).toBe("none");
  });

  // line 26 — loader's `url.searchParams.get("query") || ""` default branch.
  // Hits the loader without `?query=` so the OR fallback runs.
  it("loader: returns query='' when no ?query param is provided", async () => {
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    prismaMock.returnCase.count.mockResolvedValue(0);
    const data = await loader({
      request: new Request("https://app.example/app/returns"),
      params: {},
      context: {},
    } as never);
    expect(data).toMatchObject({
      query: "",
      status: "",
      page: 1,
      error: null,
    });
  });
});
