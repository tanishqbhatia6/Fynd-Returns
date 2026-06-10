/**
 * Loader tests for app.billing.tsx — the billing status page reachable
 * either from the app.tsx root-loader gate (when a prod shop has no
 * active subscription) or directly via settings → Billing. Covers the
 * billing-status passthrough, the Shopify Managed Pricing upgrade URL,
 * the dev/prod mode flag, superadmin detection, and the session-email
 * extraction shape (online-access info → null fallback).
 *
 * Paid plan changes render an `<a href>` pointing at
 * `getManagedPricingUpgradeUrl(...)`, which Shopify-managed pricing
 * redirects from. Free plan selection posts to the route action.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import jwt from "jsonwebtoken";

const {
  authenticateMock,
  getBillingStatusMock,
  getManagedPricingUpgradeUrlMock,
  getBillingModeMock,
  isSuperAdminMock,
  selectFreeBillingPlanMock,
} = vi.hoisted(() => ({
  authenticateMock: vi.fn(),
  getBillingStatusMock: vi.fn(),
  getManagedPricingUpgradeUrlMock: vi.fn(),
  getBillingModeMock: vi.fn(),
  isSuperAdminMock: vi.fn(),
  selectFreeBillingPlanMock: vi.fn(),
}));

vi.mock("../../shopify.server", () => ({
  authenticate: { admin: authenticateMock },
}));
vi.mock("../../lib/billing.server", () => ({
  getBillingStatus: getBillingStatusMock,
  getManagedPricingUpgradeUrl: getManagedPricingUpgradeUrlMock,
  getBillingMode: getBillingModeMock,
  isSuperAdmin: isSuperAdminMock,
  selectFreeBillingPlan: selectFreeBillingPlanMock,
}));

import { action, loader } from "../app.billing";

function mkReq(path = "/app/billing") {
  return new Request(`https://app.example${path}`);
}

beforeEach(() => {
  authenticateMock.mockReset().mockResolvedValue({
    session: { shop: "store.myshopify.com" },
    admin: { graphql: vi.fn() },
  });
  getBillingStatusMock.mockReset().mockResolvedValue({
    hasAccess: true,
    reason: "subscription_active",
    subscriptionName: "Pro",
  });
  getManagedPricingUpgradeUrlMock
    .mockReset()
    .mockReturnValue("https://admin.shopify.com/store/store/charges/fynd-returns/pricing_plans");
  getBillingModeMock.mockReset().mockReturnValue("prod");
  isSuperAdminMock.mockReset().mockReturnValue(false);
  selectFreeBillingPlanMock.mockReset().mockResolvedValue(undefined);
});

describe("app.billing loader", () => {
  it("authenticates the request as admin", async () => {
    const req = mkReq();
    await loader({ request: req, params: {}, context: {} } as never);
    expect(authenticateMock).toHaveBeenCalledTimes(1);
    expect(authenticateMock).toHaveBeenCalledWith(req);
  });

  it("returns billing status from getBillingStatus", async () => {
    getBillingStatusMock.mockResolvedValueOnce({
      hasAccess: true,
      reason: "subscription_active",
      subscriptionName: "Growth",
    });
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.status).toEqual({
      hasAccess: true,
      reason: "subscription_active",
      subscriptionName: "Growth",
    });
    expect(getBillingStatusMock).toHaveBeenCalledWith("store.myshopify.com", expect.any(Object));
  });

  it("returns subscription_missing status for shops with no active plan", async () => {
    getBillingStatusMock.mockResolvedValueOnce({
      hasAccess: false,
      reason: "subscription_missing",
      subscriptionName: null,
    });
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.status.hasAccess).toBe(false);
    expect(data.status.reason).toBe("subscription_missing");
  });

  it("returns the Shopify Managed Pricing upgrade URL for the current shop", async () => {
    getManagedPricingUpgradeUrlMock.mockReturnValueOnce(
      "https://admin.shopify.com/store/foo/charges/fynd-returns/pricing_plans",
    );
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(getManagedPricingUpgradeUrlMock).toHaveBeenCalledWith("store.myshopify.com");
    expect(data.upgradeUrl).toBe(
      "https://admin.shopify.com/store/foo/charges/fynd-returns/pricing_plans",
    );
  });

  it("returns billing mode = 'prod' in production builds", async () => {
    getBillingModeMock.mockReturnValueOnce("prod");
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.mode).toBe("prod");
  });

  it("returns billing mode = 'dev' when APP_BILLING_MODE=dev", async () => {
    getBillingModeMock.mockReturnValueOnce("dev");
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.mode).toBe("dev");
  });

  it("flags superadmin sessions via isSuperAdmin(email)", async () => {
    authenticateMock.mockResolvedValueOnce({
      session: {
        shop: "store.myshopify.com",
        onlineAccessInfo: { associated_user: { email: "boss@fynd.com" } },
      },
      admin: { graphql: vi.fn() },
    });
    isSuperAdminMock.mockReturnValueOnce(true);
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(isSuperAdminMock).toHaveBeenCalledWith("boss@fynd.com");
    expect(data.isSuperadmin).toBe(true);
    expect(data.sessionEmail).toBe("boss@fynd.com");
  });

  it("does not flag superadmin for ordinary merchant sessions", async () => {
    authenticateMock.mockResolvedValueOnce({
      session: {
        shop: "store.myshopify.com",
        onlineAccessInfo: { associated_user: { email: "owner@store.com" } },
      },
      admin: { graphql: vi.fn() },
    });
    isSuperAdminMock.mockReturnValueOnce(false);
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.isSuperadmin).toBe(false);
    expect(data.sessionEmail).toBe("owner@store.com");
  });

  it("returns null sessionEmail when session has no onlineAccessInfo (offline token)", async () => {
    authenticateMock.mockResolvedValueOnce({
      session: { shop: "store.myshopify.com" },
      admin: { graphql: vi.fn() },
    });
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.sessionEmail).toBeNull();
    expect(isSuperAdminMock).toHaveBeenCalledWith(null);
  });

  it("returns null sessionEmail when associated_user has no email", async () => {
    authenticateMock.mockResolvedValueOnce({
      session: {
        shop: "store.myshopify.com",
        onlineAccessInfo: { associated_user: {} },
      },
      admin: { graphql: vi.fn() },
    });
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data.sessionEmail).toBeNull();
  });

  it("composes the full payload with status, upgradeUrl, mode, isSuperadmin, sessionEmail", async () => {
    const data = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(data).toEqual({
      status: expect.objectContaining({ hasAccess: true }),
      upgradeUrl: expect.stringContaining("admin.shopify.com"),
      mode: "prod",
      isSuperadmin: false,
      sessionEmail: null,
    });
  });

  it("propagates errors thrown by getBillingStatus", async () => {
    getBillingStatusMock.mockRejectedValueOnce(new Error("graphql failure"));
    await expect(loader({ request: mkReq(), params: {}, context: {} } as never)).rejects.toThrow(
      "graphql failure",
    );
  });
});

describe("app.billing action", () => {
  it("records merchant free-plan selection and redirects back to embedded /app", async () => {
    const fd = new FormData();
    fd.set("intent", "select-free-plan");
    const req = new Request(
      "https://app.example/app/billing?embedded=1&shop=store.myshopify.com&host=abc",
      {
        method: "POST",
        body: fd,
      },
    );

    let thrown: unknown;
    try {
      await action({ request: req, params: {}, context: {} } as never);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(302);
    expect((thrown as Response).headers.get("Location")).toBe(
      "/app?embedded=1&shop=store.myshopify.com&host=abc",
    );
    expect(selectFreeBillingPlanMock).toHaveBeenCalledWith("store.myshopify.com");
  });

  it("rebuilds embedded context on free-plan redirect when Shopify only sends the session", async () => {
    const fd = new FormData();
    fd.set("intent", "select-free-plan");
    const req = new Request("https://app.example/app/billing", {
      method: "POST",
      body: fd,
    });

    let thrown: unknown;
    try {
      await action({ request: req, params: {}, context: {} } as never);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
    const location = (thrown as Response).headers.get("Location") ?? "";
    expect(location).toContain("/app?");
    expect(location).toContain("shop=store.myshopify.com");
    expect(location).toContain("host=YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvc3RvcmU");
    expect(location).toContain("embedded=1");
    expect(selectFreeBillingPlanMock).toHaveBeenCalledWith("store.myshopify.com");
  });

  it("accepts Shopify session-token fallback for embedded data POSTs", async () => {
    process.env.SHOPIFY_API_KEY = "client-id";
    process.env.SHOPIFY_API_SECRET = "test-secret";
    authenticateMock.mockRejectedValueOnce(new Error("Bad Request"));
    const token = jwt.sign(
      {
        dest: "https://store.myshopify.com",
        aud: "client-id",
        sub: "81835655318",
      },
      "test-secret",
      { algorithm: "HS256", expiresIn: "5m" },
    );
    const fd = new FormData();
    fd.set("intent", "select-free-plan");
    const req = new Request(
      `https://app.example/app/billing.data?embedded=1&shop=store.myshopify.com&host=abc&id_token=${token}`,
      {
        method: "POST",
        body: fd,
      },
    );

    let thrown: unknown;
    try {
      await action({ request: req, params: {}, context: {} } as never);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).headers.get("Location")).toContain("/app?");
    expect(selectFreeBillingPlanMock).toHaveBeenCalledWith("store.myshopify.com");
  });

  it("does not use session-token fallback when the token shop mismatches the query shop", async () => {
    process.env.SHOPIFY_API_KEY = "client-id";
    process.env.SHOPIFY_API_SECRET = "test-secret";
    const authError = new Error("Bad Request");
    authenticateMock.mockRejectedValueOnce(authError);
    const token = jwt.sign(
      {
        dest: "https://other.myshopify.com",
        aud: "client-id",
        sub: "81835655318",
      },
      "test-secret",
      { algorithm: "HS256", expiresIn: "5m" },
    );
    const fd = new FormData();
    fd.set("intent", "select-free-plan");
    const req = new Request(
      `https://app.example/app/billing.data?shop=store.myshopify.com&id_token=${token}`,
      {
        method: "POST",
        body: fd,
      },
    );

    await expect(action({ request: req, params: {}, context: {} } as never)).rejects.toThrow(
      "Bad Request",
    );
    expect(selectFreeBillingPlanMock).not.toHaveBeenCalled();
  });

  it("rejects unsupported billing actions", async () => {
    const fd = new FormData();
    fd.set("intent", "unknown");
    const req = new Request("https://app.example/app/billing", {
      method: "POST",
      body: fd,
    });

    await expect(action({ request: req, params: {}, context: {} } as never)).resolves.toEqual({
      error: "Unsupported billing action",
    });
    expect(selectFreeBillingPlanMock).not.toHaveBeenCalled();
  });
});
