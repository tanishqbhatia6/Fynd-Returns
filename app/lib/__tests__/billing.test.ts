import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Billing gate unit tests.
 * ────────────────────────────────────────────────────────────────────
 * Covers the three-layer decision tree in billing.server.ts:
 *   1. APP_BILLING_MODE env (dev / prod / unset)
 *   2. Per-shop override (free / paid / null)
 *   3. Live subscription check (mocked via the Admin GraphQL fn)
 *
 * Plus the superadmin email classifier and the Managed Pricing URL
 * builder (both pure).
 *
 * We use vi.hoisted for the Prisma mock so vi.mock's factory can reach
 * it — the same pattern used elsewhere in this repo.
 */

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    shop: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
    },
    shopSettings: {
      upsert: vi.fn(),
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
  fetchSubscriptionSnapshot,
  setBillingPlanOverride,
  selectFreeBillingPlan,
} from "../billing.server";

beforeEach(() => {
  prismaMock.shop.upsert.mockReset();
  prismaMock.shop.findUnique.mockReset();
  prismaMock.shopSettings.upsert.mockReset().mockResolvedValue({ id: "settings-created" });
  prismaMock.shopSettings.update.mockReset().mockResolvedValue({});
});

afterEach(() => {
  delete process.env.APP_BILLING_MODE;
  delete process.env.SUPERADMIN_EMAILS;
  delete process.env.APP_MANAGED_PRICING_HANDLE;
  delete process.env.SHOPIFY_API_KEY;
});

/* ── getBillingMode ────────────────────────────────────────────────── */

describe("getBillingMode", () => {
  it("returns 'dev' when APP_BILLING_MODE is unset", () => {
    expect(getBillingMode()).toBe("dev");
  });
  it("returns 'prod' when APP_BILLING_MODE=prod", () => {
    process.env.APP_BILLING_MODE = "prod";
    expect(getBillingMode()).toBe("prod");
  });
  it("returns 'prod' when APP_BILLING_MODE=production", () => {
    process.env.APP_BILLING_MODE = "production";
    expect(getBillingMode()).toBe("prod");
  });
  it("is case-insensitive", () => {
    process.env.APP_BILLING_MODE = "PROD";
    expect(getBillingMode()).toBe("prod");
  });
  it("returns 'dev' for any unknown value (fail-open)", () => {
    process.env.APP_BILLING_MODE = "staging";
    expect(getBillingMode()).toBe("dev");
  });
});

/* ── isSuperAdmin ──────────────────────────────────────────────────── */

describe("isSuperAdmin", () => {
  it("returns false when SUPERADMIN_EMAILS is unset", () => {
    expect(isSuperAdmin("a@x.com")).toBe(false);
  });
  it("returns false for null/empty emails", () => {
    process.env.SUPERADMIN_EMAILS = "a@x.com";
    expect(isSuperAdmin(null)).toBe(false);
    expect(isSuperAdmin(undefined)).toBe(false);
    expect(isSuperAdmin("")).toBe(false);
  });
  it("matches a single email", () => {
    process.env.SUPERADMIN_EMAILS = "admin@fynd.com";
    expect(isSuperAdmin("admin@fynd.com")).toBe(true);
  });
  it("matches within a comma-separated list", () => {
    process.env.SUPERADMIN_EMAILS = "a@x.com,b@x.com,c@x.com";
    expect(isSuperAdmin("b@x.com")).toBe(true);
  });
  it("is case-insensitive", () => {
    process.env.SUPERADMIN_EMAILS = "Admin@Fynd.com";
    expect(isSuperAdmin("ADMIN@fynd.com")).toBe(true);
  });
  it("trims whitespace", () => {
    process.env.SUPERADMIN_EMAILS = " a@x.com , b@x.com ";
    expect(isSuperAdmin("b@x.com")).toBe(true);
  });
  it("rejects non-listed emails", () => {
    process.env.SUPERADMIN_EMAILS = "admin@fynd.com";
    expect(isSuperAdmin("random@example.com")).toBe(false);
  });
});

/* ── getManagedPricingUpgradeUrl ───────────────────────────────────── */

describe("getManagedPricingUpgradeUrl", () => {
  it("builds URL using APP_MANAGED_PRICING_HANDLE when set", () => {
    process.env.APP_MANAGED_PRICING_HANDLE = "fynd-returns";
    const url = getManagedPricingUpgradeUrl("my-shop.myshopify.com");
    expect(url).toBe("https://admin.shopify.com/store/my-shop/charges/fynd-returns/pricing_plans");
  });
  it("falls back to SHOPIFY_API_KEY when handle unset", () => {
    process.env.SHOPIFY_API_KEY = "abc123client";
    const url = getManagedPricingUpgradeUrl("my-shop.myshopify.com");
    expect(url).toBe("https://admin.shopify.com/store/my-shop/charges/abc123client/pricing_plans");
  });
  it("strips https:// prefix from input", () => {
    process.env.APP_MANAGED_PRICING_HANDLE = "fr";
    const url = getManagedPricingUpgradeUrl("https://my-shop.myshopify.com/admin");
    expect(url).toContain("store/my-shop/");
  });
  it("strips .myshopify.com suffix to get store handle", () => {
    process.env.APP_MANAGED_PRICING_HANDLE = "fr";
    const url = getManagedPricingUpgradeUrl("sub-domain.myshopify.com");
    expect(url).toBe("https://admin.shopify.com/store/sub-domain/charges/fr/pricing_plans");
  });
});

/* ── fetchSubscriptionSnapshot ─────────────────────────────────────── */

function makeAdmin(response: object | null = null, throwNetwork = false) {
  return {
    graphql: vi.fn().mockImplementation(async () => {
      if (throwNetwork) throw new Error("network down");
      return {
        json: async () => response ?? {},
      };
    }),
  } as const;
}

describe("fetchSubscriptionSnapshot", () => {
  it("returns 'active' for an ACTIVE non-test subscription", async () => {
    const admin = makeAdmin({
      data: {
        currentAppInstallation: {
          activeSubscriptions: [{ id: "gid://1", name: "Monthly", status: "ACTIVE", test: false }],
        },
      },
    });
    const snap = await fetchSubscriptionSnapshot(admin);
    expect(snap).toEqual({ status: "active", name: "Monthly" });
  });

  it("returns 'inactive' when only test subscriptions exist", async () => {
    const admin = makeAdmin({
      data: {
        currentAppInstallation: {
          activeSubscriptions: [{ id: "gid://1", name: "Dev Plan", status: "ACTIVE", test: true }],
        },
      },
    });
    const snap = await fetchSubscriptionSnapshot(admin);
    expect(snap.status).toBe("inactive");
  });

  it("returns 'inactive' when subscription is PENDING/EXPIRED", async () => {
    const admin = makeAdmin({
      data: {
        currentAppInstallation: {
          activeSubscriptions: [
            { id: "gid://1", name: "Old Plan", status: "EXPIRED", test: false },
          ],
        },
      },
    });
    expect((await fetchSubscriptionSnapshot(admin)).status).toBe("inactive");
  });

  it("returns 'inactive' when no subscriptions at all", async () => {
    const admin = makeAdmin({
      data: { currentAppInstallation: { activeSubscriptions: [] } },
    });
    expect((await fetchSubscriptionSnapshot(admin)).status).toBe("inactive");
  });

  it("returns 'inactive' on network error (fail-closed)", async () => {
    const admin = makeAdmin(null, true);
    expect((await fetchSubscriptionSnapshot(admin)).status).toBe("inactive");
  });
});

/* ── getBillingStatus (full decision tree) ─────────────────────────── */

function mockShopUpsert(
  billingPlanOverride: "free" | "paid" | null = null,
  extra: Partial<{
    subscriptionStatus: "active" | "inactive" | null;
    subscriptionName: string | null;
    subscriptionCheckedAt: Date | null;
    billingPlanSelection: "free" | null;
    billingPlanSelectionAt: Date | null;
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
      billingPlanSelection: extra.billingPlanSelection ?? null,
      billingPlanSelectionAt: extra.billingPlanSelectionAt ?? null,
    },
  });
}

describe("getBillingStatus", () => {
  describe("Layer 1 — env mode", () => {
    it("dev mode grants access regardless of subscription", async () => {
      mockShopUpsert(null);
      const status = await getBillingStatus("my-shop.myshopify.com", null);
      expect(status.hasAccess).toBe(true);
      expect(status.reason).toBe("dev_mode");
    });
  });

  describe("Layer 2 — per-shop override", () => {
    it("'free' override grants access in prod mode", async () => {
      process.env.APP_BILLING_MODE = "prod";
      mockShopUpsert("free");
      const status = await getBillingStatus("my-shop.myshopify.com", null);
      expect(status.hasAccess).toBe(true);
      expect(status.reason).toBe("override_free");
    });

    it("'paid' override bypasses dev mode — requires live sub check", async () => {
      process.env.APP_BILLING_MODE = "dev";
      mockShopUpsert("paid");
      const admin = makeAdmin({
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{ id: "1", name: "M", status: "ACTIVE", test: false }],
          },
        },
      });
      const status = await getBillingStatus("my-shop.myshopify.com", admin);
      expect(status.hasAccess).toBe(true);
      expect(status.reason).toBe("subscription_active");
    });

    it("'paid' override with no subscription denies access", async () => {
      process.env.APP_BILLING_MODE = "dev";
      mockShopUpsert("paid");
      const admin = makeAdmin({
        data: { currentAppInstallation: { activeSubscriptions: [] } },
      });
      const status = await getBillingStatus("my-shop.myshopify.com", admin);
      expect(status.hasAccess).toBe(false);
      expect(status.reason).toBe("override_paid_no_sub");
    });
  });

  describe("Layer 3 — live subscription check", () => {
    beforeEach(() => {
      process.env.APP_BILLING_MODE = "prod";
    });

    it("merchant-selected free plan grants access in prod mode", async () => {
      const selectedAt = new Date(Date.now() - 60_000);
      mockShopUpsert(null, {
        billingPlanSelection: "free",
        billingPlanSelectionAt: selectedAt,
      });
      const status = await getBillingStatus("my-shop.myshopify.com", null);
      expect(status.hasAccess).toBe(true);
      expect(status.reason).toBe("free_plan_selected");
      expect(status.subscriptionName).toBe("Free");
      expect(status.subscriptionCheckedAt).toBe(selectedAt);
    });

    it("paid override still requires a Shopify subscription even if free was selected", async () => {
      mockShopUpsert("paid", { billingPlanSelection: "free" });
      const admin = makeAdmin({
        data: { currentAppInstallation: { activeSubscriptions: [] } },
      });
      const status = await getBillingStatus("my-shop.myshopify.com", admin);
      expect(status.hasAccess).toBe(false);
      expect(status.reason).toBe("override_paid_no_sub");
    });

    it("active subscription → access granted", async () => {
      mockShopUpsert(null);
      const admin = makeAdmin({
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{ id: "1", name: "Growth", status: "ACTIVE", test: false }],
          },
        },
      });
      const status = await getBillingStatus("my-shop.myshopify.com", admin);
      expect(status.hasAccess).toBe(true);
      expect(status.reason).toBe("subscription_active");
      expect(status.subscriptionName).toBe("Growth");
    });

    it("no active subscription → access denied", async () => {
      mockShopUpsert(null);
      const admin = makeAdmin({
        data: { currentAppInstallation: { activeSubscriptions: [] } },
      });
      const status = await getBillingStatus("my-shop.myshopify.com", admin);
      expect(status.hasAccess).toBe(false);
      expect(status.reason).toBe("subscription_missing");
    });

    it("uses cached snapshot when admin is null and cache is fresh", async () => {
      const recentCheck = new Date(Date.now() - 60_000); // 1 min ago
      mockShopUpsert(null, {
        subscriptionStatus: "active",
        subscriptionName: "Cached",
        subscriptionCheckedAt: recentCheck,
      });
      const status = await getBillingStatus("my-shop.myshopify.com", null);
      expect(status.hasAccess).toBe(true);
      expect(status.subscriptionName).toBe("Cached");
    });

    it("denies when admin is null and cache is stale (>10 min)", async () => {
      const staleCheck = new Date(Date.now() - 30 * 60 * 1000); // 30 min ago
      mockShopUpsert(null, {
        subscriptionStatus: "active",
        subscriptionName: "StaleCache",
        subscriptionCheckedAt: staleCheck,
      });
      const status = await getBillingStatus("my-shop.myshopify.com", null);
      expect(status.hasAccess).toBe(false);
      expect(status.reason).toBe("subscription_missing");
    });

    it("persists the live snapshot to the cache for next time", async () => {
      mockShopUpsert(null);
      const admin = makeAdmin({
        data: {
          currentAppInstallation: {
            activeSubscriptions: [{ id: "1", name: "Pro", status: "ACTIVE", test: false }],
          },
        },
      });
      await getBillingStatus("my-shop.myshopify.com", admin);
      expect(prismaMock.shopSettings.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "settings-1" },
          data: expect.objectContaining({
            subscriptionStatus: "active",
            subscriptionName: "Pro",
          }),
        }),
      );
    });
  });

  it("upserts the shop on first access (new install)", async () => {
    prismaMock.shop.upsert.mockResolvedValue({
      id: "new-shop",
      shopDomain: "new.myshopify.com",
      settings: { id: "s1", billingPlanOverride: null },
    });
    await getBillingStatus("new.myshopify.com", null);
    expect(prismaMock.shop.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopDomain: "new.myshopify.com" },
      }),
    );
  });

  it("creates missing settings for an existing shop before evaluating billing", async () => {
    process.env.APP_BILLING_MODE = "prod";
    prismaMock.shop.upsert.mockResolvedValue({
      id: "existing-shop",
      shopDomain: "existing.myshopify.com",
      settings: null,
    });
    prismaMock.shopSettings.upsert.mockResolvedValue({
      id: "settings-created",
      billingPlanOverride: null,
      billingPlanSelection: "free",
      billingPlanSelectionAt: new Date("2026-06-10T10:00:00.000Z"),
      subscriptionStatus: null,
      subscriptionName: null,
      subscriptionCheckedAt: null,
    });

    const status = await getBillingStatus("existing.myshopify.com", null);

    expect(prismaMock.shopSettings.upsert).toHaveBeenCalledWith({
      where: { shopId: "existing-shop" },
      create: { shopId: "existing-shop" },
      update: {},
    });
    expect(status.hasAccess).toBe(true);
    expect(status.reason).toBe("free_plan_selected");
  });
});

/* ── selectFreeBillingPlan ────────────────────────────────────────── */

describe("selectFreeBillingPlan", () => {
  it("creates missing settings before recording a merchant free-plan selection", async () => {
    prismaMock.shop.upsert.mockResolvedValue({
      id: "existing-shop",
      shopDomain: "store.myshopify.com",
      settings: null,
    });
    prismaMock.shopSettings.upsert.mockResolvedValue({ id: "settings-created" });

    await selectFreeBillingPlan("store.myshopify.com");

    expect(prismaMock.shopSettings.upsert).toHaveBeenCalledWith({
      where: { shopId: "existing-shop" },
      create: { shopId: "existing-shop" },
      update: {},
    });
    expect(prismaMock.shopSettings.update).toHaveBeenCalledWith({
      where: { id: "settings-created" },
      data: expect.objectContaining({
        billingPlanSelection: "free",
        billingPlanSelectionAt: expect.any(Date),
      }),
    });
  });
});

/* ── setBillingPlanOverride ────────────────────────────────────────── */

describe("setBillingPlanOverride", () => {
  it("writes the override to the shop settings with audit fields", async () => {
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      shopDomain: "x.myshopify.com",
      settings: { id: "s1" },
    });
    prismaMock.shopSettings.update.mockResolvedValue({});

    await setBillingPlanOverride("x.myshopify.com", "free", "Partner shop", "admin@fynd.com");

    expect(prismaMock.shopSettings.update).toHaveBeenCalledWith({
      where: { id: "s1" },
      data: expect.objectContaining({
        billingPlanOverride: "free",
        billingPlanOverrideReason: "Partner shop",
        billingPlanOverrideBy: "admin@fynd.com",
        billingPlanOverrideAt: expect.any(Date),
      }),
    });
  });

  it("is a no-op when the shop doesn't exist", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(null);
    await setBillingPlanOverride("missing.myshopify.com", "free", "x", "a@b.com");
    expect(prismaMock.shopSettings.update).not.toHaveBeenCalled();
  });

  it("clears the override when value is null", async () => {
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      settings: { id: "s1" },
    });
    await setBillingPlanOverride("x.myshopify.com", null, "revert", "a@b.com");
    expect(prismaMock.shopSettings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ billingPlanOverride: null }),
      }),
    );
  });
});
