import { describe, it, expect, vi, beforeEach } from "vitest";

const { boundaryHeadersMock, boundaryErrorMock } = vi.hoisted(() => ({
  boundaryHeadersMock: vi.fn(() => new Headers({ "x-test-boundary": "1" })),
  boundaryErrorMock: vi.fn(),
}));

// Mock Shopify server boundary helpers — `headers` delegates to boundary.headers.
vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { headers: boundaryHeadersMock, error: boundaryErrorMock },
}));

// Mock the React provider import — app.tsx imports it at module-eval time.
vi.mock("@shopify/shopify-app-react-router/react", () => ({
  AppProvider: () => null,
}));

// Stub out the rest of app.tsx's module-load dependencies so we can import it
// in a node test environment without booting Shopify auth, prisma, etc.
vi.mock("../../shopify.server", () => ({
  authenticate: { admin: vi.fn() },
}));
vi.mock("../../db.server", () => ({ default: {} }));
vi.mock("../../lib/fynd-config.server", () => ({ getAppMode: vi.fn(() => "prod") }));
vi.mock("../../lib/shop.server", () => ({ syncShopLocaleAndCurrency: vi.fn() }));
vi.mock("../../lib/billing.server", () => ({ getBillingStatus: vi.fn() }));

import { headers } from "../app";

beforeEach(() => {
  boundaryHeadersMock.mockClear();
});

describe("app layout headers", () => {
  it("delegates to Shopify boundary.headers", () => {
    const args = {
      parentHeaders: new Headers(),
      loaderHeaders: new Headers(),
      actionHeaders: new Headers(),
      errorHeaders: undefined,
    };
    const out = headers(args as never);
    expect(boundaryHeadersMock).toHaveBeenCalledTimes(1);
    expect(boundaryHeadersMock).toHaveBeenCalledWith(args);
    expect((out as Headers).get("x-test-boundary")).toBe("1");
  });

  it("forwards the exact same args object reference (no mutation)", () => {
    const args = {
      parentHeaders: new Headers({ "x-parent": "p" }),
      loaderHeaders: new Headers({ "x-loader": "l" }),
      actionHeaders: new Headers(),
      errorHeaders: undefined,
    };
    headers(args as never);
    const received = (
      boundaryHeadersMock.mock.calls as unknown as unknown[][]
    )[0][0] as unknown as typeof args;
    expect(received).toBe(args);
    expect(received.parentHeaders.get("x-parent")).toBe("p");
    expect(received.loaderHeaders.get("x-loader")).toBe("l");
  });

  it("returns whatever boundary.headers returns", () => {
    const custom = new Headers({
      "content-security-policy": "frame-ancestors https://*.myshopify.com",
    });
    boundaryHeadersMock.mockReturnValueOnce(custom);
    const out = headers({
      parentHeaders: new Headers(),
      loaderHeaders: new Headers(),
      actionHeaders: new Headers(),
      errorHeaders: undefined,
    } as never);
    expect(out).toBe(custom);
  });

  it("propagates errors thrown by boundary.headers", () => {
    boundaryHeadersMock.mockImplementationOnce(() => {
      throw new Error("boundary failure");
    });
    expect(() =>
      headers({
        parentHeaders: new Headers(),
        loaderHeaders: new Headers(),
        actionHeaders: new Headers(),
        errorHeaders: undefined,
      } as never),
    ).toThrow("boundary failure");
  });

  it("invokes boundary.headers once per call (not memoized)", () => {
    const args = {
      parentHeaders: new Headers(),
      loaderHeaders: new Headers(),
      actionHeaders: new Headers(),
      errorHeaders: undefined,
    };
    headers(args as never);
    headers(args as never);
    headers(args as never);
    expect(boundaryHeadersMock).toHaveBeenCalledTimes(3);
  });
});
