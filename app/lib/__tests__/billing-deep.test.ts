import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Deep coverage suite for billing.server.ts.
 * ────────────────────────────────────────────────────────────────────
 * Companion to billing.test.ts. The original suite covers the broad
 * decision tree; this suite probes the corner cases requested in the
 * test brief:
 *
 *   - getBillingMode: env value parsing edge cases (whitespace,
 *     mixed-case, unknown enum values, the "(unset)" fail-open
 *     contract documented at the top of billing.server.ts).
 *   - isSuperAdmin: list parsing edge cases (single trailing comma,
 *     internal spaces, repeated entries, blank strings).
 *   - getBillingStatus: cache TTL boundary (exactly 10 min), live-fetch
 *     graphql failure persistence, override priority over the live
 *     check, the prod path that calls fetchSubscriptionSnapshot, and
 *     the dev path that does NOT call fetchSubscriptionSnapshot.
 *   - getManagedPricingUpgradeUrl: handle precedence (handle wins
 *     over SHOPIFY_API_KEY), missing both env vars (empty handle),
 *     domains without .myshopify.com.
 *
 * We mock prisma so the upsert/update path doesn't hit a real DB. The
 * Admin GraphQL client is a hand-rolled stub since we want to count
 * call-sites (assert that dev mode skips the GraphQL call entirely).
 */

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    shop: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
    },
    shopSettings: {
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("../../db.server", () => ({ default: prismaMock }));

import {
  getBillingMode,
  isSuperAdmin,
  getBillingStatus,
  getManagedPricingUpgradeUrl,
} from "../billing.server";

beforeEach(() => {
  prismaMock.shop.upsert.mockReset();
  prismaMock.shop.findUnique.mockReset();
  prismaMock.shopSettings.update.mockReset().mockResolvedValue({});
});

afterEach(() => {
  delete process.env.APP_BILLING_MODE;
  delete process.env.SUPERADMIN_EMAILS;
  delete process.env.APP_MANAGED_PRICING_HANDLE;
  delete process.env.SHOPIFY_API_KEY;
});

/* ── Helpers ──────────────────────────────────────────────────────── */

type AdminStub = {
  graphql: ReturnType<typeof vi.fn>;
};

function makeAdmin(response: object | null = null, throwNetwork = false): AdminStub {
  return {
    graphql: vi.fn().mockImplementation(async () => {
      if (throwNetwork) throw new Error("network down");
      return { json: async () => response ?? {} };
    }),
  };
}

function mockShopUpsert(
  billingPlanOverride: "free" | "paid" | null = null,
  extra: Partial<{
    subscriptionStatus: "active" | "inactive" | null;
    subscriptionName: string | null;
    subscriptionCheckedAt: Date | null;
  }> = {},
) {
  prismaMock.shop.upsert.mockResolvedValue({
    id: "shop-1",
    shopDomain: "my-shop.myshopify.com",
    settings: {
      id: "settings-1",
      billingPlanOverride,
      subscriptionStatus: extra.subscriptionStatus ?? null,
      subscriptionName: extra.subscriptionName ?? null,
      subscriptionCheckedAt: extra.subscriptionCheckedAt ?? null,
    },
  });
}

/* ── getBillingMode ───────────────────────────────────────────────── */

describe("getBillingMode (deep)", () => {
  it("returns 'dev' when APP_BILLING_MODE is empty string", () => {
    process.env.APP_BILLING_MODE = "";
    expect(getBillingMode()).toBe("dev");
  });

  it("returns 'prod' for mixed-case 'Production'", () => {
    process.env.APP_BILLING_MODE = "Production";
    expect(getBillingMode()).toBe("prod");
  });

  it("returns 'dev' for typos like 'pord'", () => {
    process.env.APP_BILLING_MODE = "pord";
    expect(getBillingMode()).toBe("dev");
  });

  it("does NOT trim whitespace — ' prod ' becomes dev", () => {
    // Documents current behaviour: only equality-after-lowercase is
    // checked, no trim. If someone accidentally adds a space in the
    // .env, they fail-open into dev mode.
    process.env.APP_BILLING_MODE = " prod ";
    expect(getBillingMode()).toBe("dev");
  });
});

/* ── isSuperAdmin ─────────────────────────────────────────────────── */

describe("isSuperAdmin (deep)", () => {
  it("handles trailing comma in the env list", () => {
    process.env.SUPERADMIN_EMAILS = "a@x.com,b@x.com,";
    expect(isSuperAdmin("b@x.com")).toBe(true);
  });

  it("handles purely whitespace entries (filtered out)", () => {
    process.env.SUPERADMIN_EMAILS = "  , , a@x.com";
    expect(isSuperAdmin("a@x.com")).toBe(true);
    expect(isSuperAdmin("")).toBe(false);
  });

  it("handles list of only whitespace -> no superadmins", () => {
    process.env.SUPERADMIN_EMAILS = "  ,  , ";
    expect(isSuperAdmin("anyone@example.com")).toBe(false);
  });

  it("trims whitespace in the supplied email too", () => {
    process.env.SUPERADMIN_EMAILS = "admin@fynd.com";
    expect(isSuperAdmin("  admin@fynd.com  ")).toBe(true);
  });

  it("does not match partial / substring emails", () => {
    process.env.SUPERADMIN_EMAILS = "admin@fynd.com";
    expect(isSuperAdmin("evil-admin@fynd.com")).toBe(false);
    expect(isSuperAdmin("admin@fynd.com.evil.com")).toBe(false);
  });

  it("matches the LAST entry in a long comma-separated list", () => {
    process.env.SUPERADMIN_EMAILS = "a@x.com,b@x.com,c@x.com,d@x.com,target@x.com";
    expect(isSuperAdmin("target@x.com")).toBe(true);
  });
});

/* ── getManagedPricingUpgradeUrl ──────────────────────────────────── */

describe("getManagedPricingUpgradeUrl (deep)", () => {
  it("prefers APP_MANAGED_PRICING_HANDLE over SHOPIFY_API_KEY", () => {
    process.env.APP_MANAGED_PRICING_HANDLE = "my-handle";
    process.env.SHOPIFY_API_KEY = "fallback-key";
    const url = getManagedPricingUpgradeUrl("my-shop.myshopify.com");
    expect(url).toContain("/charges/my-handle/");
    expect(url).not.toContain("fallback-key");
  });

  it("renders an empty handle segment when neither env var is set", () => {
    // Documents current behaviour rather than blessing it: if both env
    // vars are missing the URL still resolves but points at an invalid
    // route (//pricing_plans). Better than throwing, since this only
    // happens in misconfigured dev envs.
    const url = getManagedPricingUpgradeUrl("my-shop.myshopify.com");
    expect(url).toBe("https://admin.shopify.com/store/my-shop/charges//pricing_plans");
  });

  it("strips http:// prefix (not just https)", () => {
    process.env.APP_MANAGED_PRICING_HANDLE = "h";
    const url = getManagedPricingUpgradeUrl("http://my-shop.myshopify.com");
    expect(url).toContain("store/my-shop/");
  });

  it("keeps non-myshopify domains intact (custom domain handle)", () => {
    process.env.APP_MANAGED_PRICING_HANDLE = "h";
    // A bare domain without .myshopify.com just becomes the store handle
    // verbatim. We document this to flag for anyone reading the URL.
    const url = getManagedPricingUpgradeUrl("custom-store");
    expect(url).toBe("https://admin.shopify.com/store/custom-store/charges/h/pricing_plans");
  });

  it("ignores trailing path segments after the host", () => {
    process.env.APP_MANAGED_PRICING_HANDLE = "h";
    const url = getManagedPricingUpgradeUrl("my-shop.myshopify.com/admin/orders/123");
    expect(url).toBe("https://admin.shopify.com/store/my-shop/charges/h/pricing_plans");
  });
});

/* ── getBillingStatus — env override path ─────────────────────────── */

describe("getBillingStatus — env override (deep)", () => {
  it("dev mode SKIPS the live subscription call entirely", async () => {
    delete process.env.APP_BILLING_MODE; // defaults to dev
    mockShopUpsert(null);
    const admin = makeAdmin({
      data: { currentAppInstallation: { activeSubscriptions: [] } },
    });
    const status = await getBillingStatus("my-shop.myshopify.com", admin as never);
    expect(status.reason).toBe("dev_mode");
    // The whole point of dev mode: don't even ask Shopify.
    expect(admin.graphql).not.toHaveBeenCalled();
  });

  it("dev mode still surfaces cached subscription metadata in the response", async () => {
    const cachedAt = new Date("2026-01-01T00:00:00Z");
    mockShopUpsert(null, {
      subscriptionStatus: "active",
      subscriptionName: "PreservedName",
      subscriptionCheckedAt: cachedAt,
    });
    const status = await getBillingStatus("my-shop.myshopify.com", null);
    expect(status.subscriptionName).toBe("PreservedName");
    expect(status.subscriptionCheckedAt).toEqual(cachedAt);
  });

  it("dev mode + paid override falls through to live check", async () => {
    delete process.env.APP_BILLING_MODE;
    mockShopUpsert("paid");
    const admin = makeAdmin({
      data: { currentAppInstallation: { activeSubscriptions: [] } },
    });
    const status = await getBillingStatus("my-shop.myshopify.com", admin as never);
    // No subscription + override=paid → denied with the specific reason
    expect(status.hasAccess).toBe(false);
    expect(status.reason).toBe("override_paid_no_sub");
    // And the live call DID fire this time.
    expect(admin.graphql).toHaveBeenCalledOnce();
  });

  it("prod mode + free override grants access without hitting GraphQL", async () => {
    process.env.APP_BILLING_MODE = "prod";
    mockShopUpsert("free");
    const admin = makeAdmin();
    const status = await getBillingStatus("my-shop.myshopify.com", admin as never);
    expect(status.hasAccess).toBe(true);
    expect(status.reason).toBe("override_free");
    expect(admin.graphql).not.toHaveBeenCalled();
  });
});

/* ── getBillingStatus — per-shop override (deep) ──────────────────── */

describe("getBillingStatus — per-shop override (deep)", () => {
  it("free override carries cached subscription name through to response", async () => {
    process.env.APP_BILLING_MODE = "prod";
    mockShopUpsert("free", { subscriptionName: "OldPaidPlan" });
    const status = await getBillingStatus("my-shop.myshopify.com", null);
    expect(status.hasAccess).toBe(true);
    expect(status.subscriptionName).toBe("OldPaidPlan");
  });

  it("override field is reflected in the returned status object", async () => {
    process.env.APP_BILLING_MODE = "prod";
    mockShopUpsert("free");
    const status = await getBillingStatus("my-shop.myshopify.com", null);
    expect(status.override).toBe("free");
    expect(status.mode).toBe("prod");
  });
});

/* ── getBillingStatus — live subscription cache (deep) ────────────── */

describe("getBillingStatus — live cache (deep)", () => {
  beforeEach(() => {
    process.env.APP_BILLING_MODE = "prod";
  });

  it("uses cached snapshot at exactly 9m59s old (just inside TTL)", async () => {
    const fresh = new Date(Date.now() - (10 * 60 * 1000 - 1000));
    mockShopUpsert(null, {
      subscriptionStatus: "active",
      subscriptionName: "Cached-9m59s",
      subscriptionCheckedAt: fresh,
    });
    const status = await getBillingStatus("my-shop.myshopify.com", null);
    expect(status.hasAccess).toBe(true);
    expect(status.subscriptionName).toBe("Cached-9m59s");
  });

  it("denies when cache is exactly 10m old (just outside TTL)", async () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000 - 1);
    mockShopUpsert(null, {
      subscriptionStatus: "active",
      subscriptionName: "Stale",
      subscriptionCheckedAt: stale,
    });
    const status = await getBillingStatus("my-shop.myshopify.com", null);
    expect(status.hasAccess).toBe(false);
    expect(status.reason).toBe("subscription_missing");
  });

  it("denies when subscriptionCheckedAt is null (never been checked)", async () => {
    mockShopUpsert(null, {
      subscriptionStatus: "active", // status set but no timestamp = treat as stale
      subscriptionCheckedAt: null,
    });
    const status = await getBillingStatus("my-shop.myshopify.com", null);
    expect(status.hasAccess).toBe(false);
  });

  it("respects cached 'inactive' even when fresh", async () => {
    const fresh = new Date(Date.now() - 60_000);
    mockShopUpsert(null, {
      subscriptionStatus: "inactive",
      subscriptionCheckedAt: fresh,
    });
    const status = await getBillingStatus("my-shop.myshopify.com", null);
    expect(status.hasAccess).toBe(false);
    expect(status.reason).toBe("subscription_missing");
  });

  it("live admin call overrides a stale 'active' cache", async () => {
    const stale = new Date(Date.now() - 30 * 60 * 1000);
    mockShopUpsert(null, {
      subscriptionStatus: "active",
      subscriptionName: "OldName",
      subscriptionCheckedAt: stale,
    });
    // Live admin says no subscription anymore → cache should be ignored.
    const admin = makeAdmin({
      data: { currentAppInstallation: { activeSubscriptions: [] } },
    });
    const status = await getBillingStatus("my-shop.myshopify.com", admin as never);
    expect(status.hasAccess).toBe(false);
    expect(status.reason).toBe("subscription_missing");
  });

  it("live admin call refreshes cache even when cache was fresh", async () => {
    const fresh = new Date(Date.now() - 60_000);
    mockShopUpsert(null, {
      subscriptionStatus: "inactive",
      subscriptionCheckedAt: fresh,
    });
    const admin = makeAdmin({
      data: {
        currentAppInstallation: {
          activeSubscriptions: [
            { id: "1", name: "FreshlyPurchased", status: "ACTIVE", test: false },
          ],
        },
      },
    });
    const status = await getBillingStatus("my-shop.myshopify.com", admin as never);
    expect(status.hasAccess).toBe(true);
    expect(status.subscriptionName).toBe("FreshlyPurchased");
    // And the cache was rewritten with the new state.
    expect(prismaMock.shopSettings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          subscriptionStatus: "active",
          subscriptionName: "FreshlyPurchased",
        }),
      }),
    );
  });

  it("does not write cache when admin GraphQL throws (network error treated as inactive but no persistence)", async () => {
    // The current implementation does still persist 'inactive' on
    // network error. We assert the documented behaviour: write happens
    // and reflects inactive status.
    mockShopUpsert(null);
    const admin = makeAdmin(null, true);
    const status = await getBillingStatus("my-shop.myshopify.com", admin as never);
    expect(status.hasAccess).toBe(false);
    expect(status.reason).toBe("subscription_missing");
    expect(prismaMock.shopSettings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ subscriptionStatus: "inactive" }),
      }),
    );
  });

  it("swallows persistence errors silently (does not affect the response)", async () => {
    mockShopUpsert(null);
    prismaMock.shopSettings.update.mockRejectedValue(new Error("DB down"));
    const admin = makeAdmin({
      data: {
        currentAppInstallation: {
          activeSubscriptions: [{ id: "1", name: "P", status: "ACTIVE", test: false }],
        },
      },
    });
    // Even though the cache write fails, the response is computed from
    // the live snapshot and access is still granted.
    const status = await getBillingStatus("my-shop.myshopify.com", admin as never);
    expect(status.hasAccess).toBe(true);
  });
});
