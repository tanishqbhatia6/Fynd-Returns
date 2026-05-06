/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Mocks for module-top-level imports in app/routes/app.tsx ──
// app.tsx imports shopify.server / db.server / lib/* purely so its loader
// can run on the server. Importing the file under jsdom evaluates those
// modules, so we stub them to keep Node-only deps out of the test bundle.
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
vi.mock("../lib/fynd-config.server", () => ({
  getAppMode: vi.fn(() => "prod"),
}));
vi.mock("../lib/shop.server", () => ({
  syncShopLocaleAndCurrency: vi.fn<(...args: unknown[]) => Promise<undefined>>(
    async () => undefined,
  ),
}));
vi.mock("../lib/billing.server", () => ({
  getBillingStatus: vi.fn(async () => ({ hasAccess: true })),
}));

vi.mock("@shopify/shopify-app-react-router/react", () => ({
  AppProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-provider">{children}</div>
  ),
}));

// Override useRouteError so the ErrorBoundary export can be unit-tested
// outside a data router. Other react-router exports pass through.
const useRouteErrorMock = vi.fn(() => undefined as unknown);
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return { ...actual, useRouteError: () => useRouteErrorMock() };
});

// Stub the boundary helpers so we can assert the route exports forward
// the expected arguments without pulling in the real Shopify server impl
// (which expects a live request context).
const errorSpy = vi.fn((err: unknown) => (
  <div data-testid="boundary-error">
    boundary:{(err as { message?: string })?.message ?? "none"}
  </div>
));
const headersSpy = vi.fn((args: unknown) => {
  const h = new Headers();
  h.set("x-boundary-called", "1");
  // Surface a sentinel so we can assert headersSpy was forwarded the input.
  if (args && typeof args === "object") {
    h.set("x-boundary-keys", Object.keys(args as object).join(","));
  }
  return h;
});

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: {
    error: (err: unknown) => errorSpy(err),
    headers: (args: unknown) => headersSpy(args),
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
import { ErrorBoundary, headers } from "../app";

describe("app.tsx ErrorBoundary export", () => {
  it("exports ErrorBoundary as a function component", () => {
    expect(typeof ErrorBoundary).toBe("function");
  });

  it("renders the boundary.error result when mounted via renderWithRouter", () => {
    errorSpy.mockClear();
    const { getByTestId } = renderWithRouter(ErrorBoundary, {
      initialEntries: ["/app"],
    });
    // useRouteError() returns undefined when no error has been thrown in the
    // memory router — boundary.error still receives that value and our stub
    // renders the sentinel node.
    expect(getByTestId("boundary-error")).toBeTruthy();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("forwards the useRouteError() value into boundary.error", () => {
    // Directly verify the ErrorBoundary delegates useRouteError() into
    // boundary.error — simpler & less brittle than wiring up a memory
    // router with a throwing loader.
    errorSpy.mockClear();
    const sentinel = new Error("kaboom");
    useRouteErrorMock.mockReturnValueOnce(sentinel);
    const { render } = require("@testing-library/react");
    const { getByTestId } = render(<ErrorBoundary />);
    expect(getByTestId("boundary-error").textContent).toBe("boundary:kaboom");
    expect(errorSpy).toHaveBeenCalledWith(sentinel);
  });
});

describe("app.tsx headers export", () => {
  it("is a function", () => {
    expect(typeof headers).toBe("function");
  });

  it("delegates to boundary.headers and returns its result", () => {
    headersSpy.mockClear();
    const args = {
      loaderHeaders: new Headers({ "x-loader": "1" }),
      parentHeaders: new Headers({ "x-parent": "1" }),
      actionHeaders: new Headers(),
      errorHeaders: undefined,
    };
    const result = headers(args as never);
    expect(result).toBeInstanceOf(Headers);
    expect((result as Headers).get("x-boundary-called")).toBe("1");
    expect(headersSpy).toHaveBeenCalledTimes(1);
    expect(headersSpy).toHaveBeenCalledWith(args);
  });

  it("passes the full HeadersArgs object through unchanged", () => {
    headersSpy.mockClear();
    const args = {
      loaderHeaders: new Headers(),
      parentHeaders: new Headers(),
      actionHeaders: new Headers(),
    };
    const result = headers(args as never) as Headers;
    expect(result.get("x-boundary-keys")).toContain("loaderHeaders");
    expect(result.get("x-boundary-keys")).toContain("parentHeaders");
    expect(result.get("x-boundary-keys")).toContain("actionHeaders");
  });
});
