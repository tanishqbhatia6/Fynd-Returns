/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Mocks for module-top-level imports in app/routes/app.portal.tsx ──
vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));

vi.mock("../db.server", () => ({
  default: {
    shop: { findUnique: vi.fn() },
    returnCase: { count: vi.fn() },
  },
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

import { renderWithRouter } from "../../test/component-helpers";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import {
  createMemoryRouter,
  RouterProvider,
  type RouteObject,
} from "react-router";
import PortalInfo, { ErrorBoundary } from "../app.portal";
import { DEFAULT_PORTAL_THEME } from "../../lib/portal-theme.server";

const defaultTheme = { ...DEFAULT_PORTAL_THEME };
const defaultConfig = {
  showOrderTracking: true,
  showReturnTracking: true,
  showCreateReturnTab: true,
  defaultTab: "return" as const,
  allowMediaUploads: true,
  allowReturnCancellation: true,
};

const baseLoaderData = {
  portalUrl: "https://test-shop.myshopify.com/apps/returns",
  storeName: "test-shop",
  hasTheme: true,
  theme: defaultTheme,
  config: defaultConfig,
  totalReturns: 12,
  activeReturns: 3,
};

// Wider waitFor budget — jsdom + React Router cold-boot is slow on coverage
// runs and the default 1000ms occasionally times out before the route's
// pre-resolved loader data has flushed into the tree.
const WAIT = { timeout: 8000 };

describe("App portal (default export)", () => {
  it("renders the page heading 'Customer Portal'", async () => {
    const { container } = renderWithRouter(PortalInfo, {
      initialEntries: ["/app/portal"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector(".app-page-title")?.textContent).toBe(
        "Customer Portal",
      );
    }, WAIT);
  });

  it("renders the portal URL from loader data", async () => {
    const { container } = renderWithRouter(PortalInfo, {
      initialEntries: ["/app/portal"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain(
        "https://test-shop.myshopify.com/apps/returns",
      );
    }, WAIT);
  });

  it("renders an 'Open portal' anchor pointing to the portal URL", async () => {
    const { container } = renderWithRouter(PortalInfo, {
      initialEntries: ["/app/portal"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      const anchors = Array.from(container.querySelectorAll("a"));
      const openLink = anchors.find(
        (a) => a.getAttribute("href") === baseLoaderData.portalUrl,
      );
      expect(openLink).toBeTruthy();
      expect(openLink?.getAttribute("target")).toBe("_blank");
    }, WAIT);
  });

  it("renders the active and total returns counts", async () => {
    const { container } = renderWithRouter(PortalInfo, {
      initialEntries: ["/app/portal"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Active returns");
      expect(container.textContent).toContain("Total returns");
      // active count
      expect(container.textContent).toMatch(/3/);
      // total count
      expect(container.textContent).toMatch(/12/);
    }, WAIT);
  });

  it("renders the portal preview block with the heading 'Returns & Exchanges'", async () => {
    const { container } = renderWithRouter(PortalInfo, {
      initialEntries: ["/app/portal"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Portal preview");
      expect(container.textContent).toContain("Returns & Exchanges");
    }, WAIT);
  });

  it("lists the enabled sections from config (Order tracking / Return tracking / Create return)", async () => {
    const { container } = renderWithRouter(PortalInfo, {
      initialEntries: ["/app/portal"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Order tracking");
      expect(container.textContent).toContain("Return tracking");
      expect(container.textContent).toContain("Create return");
    }, WAIT);
  });

  it("shows 'No sections enabled' when config disables every tab", async () => {
    const { container } = renderWithRouter(PortalInfo, {
      initialEntries: ["/app/portal"],
      loaderData: {
        ...baseLoaderData,
        config: {
          ...defaultConfig,
          showOrderTracking: false,
          showReturnTracking: false,
          showCreateReturnTab: false,
        },
      },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("No sections enabled");
    }, WAIT);
  });

  it("renders the Setup checklist with the right completion ratio when hasTheme is false", async () => {
    const { container } = renderWithRouter(PortalInfo, {
      initialEntries: ["/app/portal"],
      loaderData: { ...baseLoaderData, hasTheme: false },
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Setup checklist");
      // hasTheme=false → 2 of 3 done (return reasons + sections enabled).
      expect(container.textContent).toContain("2/3");
    }, WAIT);
  });

  // ── Copy URL button → clipboard.writeText (covers handleCopy lines 64-66) ──
  it("calls navigator.clipboard.writeText with portalUrl when Copy URL is clicked", async () => {
    const writeTextMock = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: writeTextMock },
    });

    const { container } = renderWithRouter(PortalInfo, {
      initialEntries: ["/app/portal"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Copy URL");
    }, WAIT);

    const copyBtn = Array.from(container.querySelectorAll("s-button")).find(
      (b) => (b.textContent ?? "").includes("Copy URL"),
    );
    expect(copyBtn).toBeTruthy();

    act(() => {
      fireEvent.click(copyBtn!);
    });

    expect(writeTextMock).toHaveBeenCalledTimes(1);
    expect(writeTextMock).toHaveBeenCalledWith(baseLoaderData.portalUrl);
    // setCopied(true) flips the visible label immediately.
    expect(container.textContent).toContain("Copied");
  });

  it("flips 'Copied' back to 'Copy URL' after the 2.5s setTimeout fires", async () => {
    vi.useFakeTimers();
    try {
      const writeTextMock = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(globalThis.navigator, "clipboard", {
        configurable: true,
        value: { writeText: writeTextMock },
      });

      const { container } = renderWithRouter(PortalInfo, {
        initialEntries: ["/app/portal"],
        loaderData: baseLoaderData,
      });
      // Drain initial micro/macro tasks so the route resolves under fake timers.
      await act(async () => {
        await vi.runAllTimersAsync();
      });
      expect(container.textContent).toContain("Copy URL");

      const copyBtn = Array.from(container.querySelectorAll("s-button")).find(
        (b) => (b.textContent ?? "").includes("Copy URL"),
      );

      act(() => {
        fireEvent.click(copyBtn!);
      });
      expect(container.textContent).toContain("Copied");

      // Advance the 2.5s timer scheduled by handleCopy.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2600);
      });
      expect(container.textContent).toContain("Copy URL");
    } finally {
      vi.useRealTimers();
    }
  });

  it("swallows clipboard.writeText rejections via the .catch handler", async () => {
    const rejectingWrite = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(globalThis.navigator, "clipboard", {
      configurable: true,
      value: { writeText: rejectingWrite },
    });

    const { container } = renderWithRouter(PortalInfo, {
      initialEntries: ["/app/portal"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Copy URL");
    }, WAIT);

    const copyBtn = Array.from(container.querySelectorAll("s-button")).find(
      (b) => (b.textContent ?? "").includes("Copy URL"),
    );

    expect(() => {
      act(() => {
        fireEvent.click(copyBtn!);
      });
    }).not.toThrow();

    expect(rejectingWrite).toHaveBeenCalledWith(baseLoaderData.portalUrl);
    // Optimistic flip still happens regardless of the rejection.
    expect(container.textContent).toContain("Copied");
  });
});

// ── ErrorBoundary tests (cover lines 510-514 of source) ──
function renderErrorBoundaryWithError(error: unknown) {
  const routes: RouteObject[] = [
    {
      path: "*",
      element: <div>portal-page</div>,
      loader: () => {
        throw error;
      },
      ErrorBoundary,
    },
  ];
  const router = createMemoryRouter(routes, { initialEntries: ["/"] });
  return render(<RouterProvider router={router} />);
}

describe("App portal ErrorBoundary", () => {
  it("renders the data string when error is a route error response with data", async () => {
    const response = new Response("custom-error-data", { status: 418 });
    const { container } = renderErrorBoundaryWithError(response);
    await waitFor(() => {
      expect(container.textContent).toContain("custom-error-data");
      expect(container.textContent).toContain("Try again");
    }, WAIT);
  });

  it("falls back to 'Error <status>' when route error response data is empty", async () => {
    const response = new Response("", { status: 503 });
    const { container } = renderErrorBoundaryWithError(response);
    await waitFor(() => {
      expect(container.textContent).toContain("Error 503");
    }, WAIT);
  });

  it("renders the message from a thrown Error instance", async () => {
    const { container } = renderErrorBoundaryWithError(
      new Error("kaboom-from-loader"),
    );
    await waitFor(() => {
      expect(container.textContent).toContain("kaboom-from-loader");
    }, WAIT);
  });

  it("renders the generic fallback for non-Error / non-Response throws", async () => {
    const { container } = renderErrorBoundaryWithError("plain-string-error");
    await waitFor(() => {
      expect(container.textContent).toContain(
        "An unexpected error occurred.",
      );
    }, WAIT);
  });

  it("renders the 'Customer Portal' heading inside the ErrorBoundary frame", async () => {
    const { container } = renderErrorBoundaryWithError(new Error("x"));
    await waitFor(() => {
      expect(container.querySelector(".app-page-title")?.textContent).toBe(
        "Customer Portal",
      );
    }, WAIT);
  });

  it("renders a 'Try again' link pointing back at /app/portal", async () => {
    const { container } = renderErrorBoundaryWithError(new Error("x"));
    await waitFor(() => {
      const link = Array.from(container.querySelectorAll("a")).find(
        (a) => (a.textContent ?? "").includes("Try again"),
      );
      expect(link).toBeTruthy();
      expect(link?.getAttribute("href")).toBe("/app/portal");
    }, WAIT);
  });
});
