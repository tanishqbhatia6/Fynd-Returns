/**
 * Loader tests for app.billing.tsx — the billing status page reachable
 * either from the app.tsx root-loader gate (when a prod shop has no
 * active subscription) or directly via settings → Billing. Covers the
 * billing-status passthrough, the Shopify Managed Pricing upgrade URL,
 * the dev/prod mode flag, superadmin detection, and the session-email
 * extraction shape (online-access info → null fallback).
 *
 * Note: app.billing.tsx exports only a `loader`. The "initiate plan
 * change" path is not a remix `action` — the page renders an `<a href>`
 * pointing at `getManagedPricingUpgradeUrl(...)`, which Shopify-managed
 * pricing redirects from. We assert the loader hands that URL through
 * unchanged so the rendered link is correct.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  authenticateMock,
  getBillingStatusMock,
  getManagedPricingUpgradeUrlMock,
  getBillingModeMock,
  isSuperAdminMock,
} = vi.hoisted(() => ({
  authenticateMock: vi.fn(),
  getBillingStatusMock: vi.fn(),
  getManagedPricingUpgradeUrlMock: vi.fn(),
  getBillingModeMock: vi.fn(),
  isSuperAdminMock: vi.fn(),
}));

vi.mock("../../shopify.server", () => ({
  authenticate: { admin: authenticateMock },
}));
vi.mock("../../lib/billing.server", () => ({
  getBillingStatus: getBillingStatusMock,
  getManagedPricingUpgradeUrl: getManagedPricingUpgradeUrlMock,
  getBillingMode: getBillingModeMock,
  isSuperAdmin: isSuperAdminMock,
}));

import { loader } from "../app.billing";

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
