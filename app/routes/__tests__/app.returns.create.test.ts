/**
 * Tests for app.returns.create.tsx — manual return creation page.
 *
 * The route's loader is intentionally thin (it returns the authenticated
 * shop domain only); the heavy lifting happens client-side via two
 * `useFetcher()` calls (one to /api/portal/order, one to
 * /api/admin/create-return). These tests cover:
 *   1. Loader auth + shape contract
 *   2. The route module exports (loader + default component)
 *   3. Behavior under various authenticate.admin outcomes
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { authenticateMock, fetchOrderByOrderNumberMock, checkReturnEligibilityMock } = vi.hoisted(
  () => ({
    authenticateMock: vi.fn(),
    fetchOrderByOrderNumberMock: vi.fn(),
    checkReturnEligibilityMock: vi.fn(() => ({ eligible: true })),
  }),
);

vi.mock("../../shopify.server", () => ({
  authenticate: { admin: authenticateMock },
}));
vi.mock("../../lib/shopify-admin.server", () => ({
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
  fetchOrderByFyndAffiliateId: vi.fn(),
  withRestCredentials: vi.fn((a: unknown) => a),
}));
vi.mock("../../lib/return-rules.server", () => ({
  checkReturnEligibility: checkReturnEligibilityMock,
}));

import { loader } from "../app.returns.create";
import * as routeModule from "../app.returns.create";

function makeRequest(url = "https://app.example/app/returns/create") {
  return new Request(url);
}

beforeEach(() => {
  authenticateMock.mockReset();
  fetchOrderByOrderNumberMock.mockReset();
  checkReturnEligibilityMock.mockReset().mockReturnValue({ eligible: true });
});

describe("app.returns.create loader", () => {
  it("calls authenticate.admin with the request", async () => {
    authenticateMock.mockResolvedValueOnce({ session: { shop: "store.myshopify.com" } });
    const req = makeRequest();
    await loader({ request: req, params: {}, context: {} } as never);
    expect(authenticateMock).toHaveBeenCalledTimes(1);
    expect(authenticateMock).toHaveBeenCalledWith(req);
  });

  it("returns shopDomain from the authenticated session", async () => {
    authenticateMock.mockResolvedValueOnce({ session: { shop: "store.myshopify.com" } });
    const data = await loader({ request: makeRequest(), params: {}, context: {} } as never);
    expect(data).toEqual({ shopDomain: "store.myshopify.com" });
  });

  it("returns shopDomain for a different shop", async () => {
    authenticateMock.mockResolvedValueOnce({ session: { shop: "another.myshopify.com" } });
    const data = await loader({ request: makeRequest(), params: {}, context: {} } as never);
    expect(data.shopDomain).toBe("another.myshopify.com");
  });

  it("propagates authentication failures (e.g. redirect Response)", async () => {
    const redirect = new Response(null, { status: 302, headers: { Location: "/auth" } });
    authenticateMock.mockRejectedValueOnce(redirect);
    await expect(loader({ request: makeRequest(), params: {}, context: {} } as never)).rejects.toBe(
      redirect,
    );
  });

  it("propagates thrown Errors from authenticate.admin", async () => {
    authenticateMock.mockRejectedValueOnce(new Error("boom"));
    await expect(
      loader({ request: makeRequest(), params: {}, context: {} } as never),
    ).rejects.toThrow(/boom/);
  });

  it("does NOT include sensitive session fields beyond shopDomain", async () => {
    authenticateMock.mockResolvedValueOnce({
      session: {
        shop: "store.myshopify.com",
        accessToken: "shpat_secret",
        scope: "read_orders,write_orders",
        id: "session-1",
      },
      admin: { graphql: vi.fn() },
    });
    const data = await loader({ request: makeRequest(), params: {}, context: {} } as never);
    expect(Object.keys(data)).toEqual(["shopDomain"]);
    expect((data as Record<string, unknown>).accessToken).toBeUndefined();
  });

  it("does not call fetchOrderByOrderNumber (loader has no order data)", async () => {
    authenticateMock.mockResolvedValueOnce({ session: { shop: "store.myshopify.com" } });
    await loader({ request: makeRequest(), params: {}, context: {} } as never);
    // Order data is fetched client-side via /api/portal/order, NOT in the
    // loader. This guards against a regression that would tightly couple
    // the loader to Shopify Admin API on every page navigation.
    expect(fetchOrderByOrderNumberMock).not.toHaveBeenCalled();
  });

  it("does not invoke return-rules eligibility checks at load time", async () => {
    authenticateMock.mockResolvedValueOnce({ session: { shop: "store.myshopify.com" } });
    await loader({ request: makeRequest(), params: {}, context: {} } as never);
    // Eligibility is checked server-side in /api/admin/create-return, not
    // here. Guard against accidentally moving the check into the loader.
    expect(checkReturnEligibilityMock).not.toHaveBeenCalled();
  });

  it("works with shop domains that contain hyphens and numbers", async () => {
    authenticateMock.mockResolvedValueOnce({ session: { shop: "shop-123-abc.myshopify.com" } });
    const data = await loader({ request: makeRequest(), params: {}, context: {} } as never);
    expect(data.shopDomain).toBe("shop-123-abc.myshopify.com");
  });

  it("handles repeated invocations independently (no shared state)", async () => {
    authenticateMock
      .mockResolvedValueOnce({ session: { shop: "first.myshopify.com" } })
      .mockResolvedValueOnce({ session: { shop: "second.myshopify.com" } });
    const a = await loader({ request: makeRequest(), params: {}, context: {} } as never);
    const b = await loader({ request: makeRequest(), params: {}, context: {} } as never);
    expect(a.shopDomain).toBe("first.myshopify.com");
    expect(b.shopDomain).toBe("second.myshopify.com");
    expect(authenticateMock).toHaveBeenCalledTimes(2);
  });

  it("loader return value is JSON-serializable for React Router", async () => {
    authenticateMock.mockResolvedValueOnce({ session: { shop: "store.myshopify.com" } });
    const data = await loader({ request: makeRequest(), params: {}, context: {} } as never);
    expect(() => JSON.stringify(data)).not.toThrow();
    expect(JSON.parse(JSON.stringify(data))).toEqual({ shopDomain: "store.myshopify.com" });
  });
});

describe("app.returns.create module exports", () => {
  it("exports a loader function", () => {
    expect(typeof routeModule.loader).toBe("function");
  });

  it("exports a default React component", () => {
    expect(typeof routeModule.default).toBe("function");
    // React Router wraps the component with `WithComponentProps`, so we
    // assert it's a function rather than checking the inner displayName.
    expect(routeModule.default.length).toBeGreaterThanOrEqual(0);
  });

  it("does not export an action (creation is delegated to /api/admin/create-return)", () => {
    // The submit step uses submitFetcher.submit({ action: "/api/admin/create-return" })
    // — this page must not also expose its own action handler, or the
    // form would post to the wrong endpoint and bypass admin auth.
    expect((routeModule as Record<string, unknown>).action).toBeUndefined();
  });
});
