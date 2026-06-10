import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/**
 * Coverage-gap suite for billing.server.ts.
 * ────────────────────────────────────────────────────────────────────
 * Targets the residual uncovered branches not exercised by
 * billing.test.ts or billing-deep.test.ts:
 *
 *   1. fetchSubscriptionSnapshot — empty `data` object so the
 *      `?? []` fallback for activeSubscriptions executes.
 *   2. getBillingStatus — existing shop with settings null is repaired
 *      before subscription cache persistence.
 *   3. setBillingPlanOverride — empty-string reason exercises the
 *      `reason || null` fallback.
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
  fetchSubscriptionSnapshot,
  getBillingStatus,
  setBillingPlanOverride,
} from "../billing.server";

beforeEach(() => {
  prismaMock.shop.upsert.mockReset();
  prismaMock.shop.findUnique.mockReset();
  prismaMock.shopSettings.upsert.mockReset().mockResolvedValue({ id: "settings-created" });
  prismaMock.shopSettings.update.mockReset().mockResolvedValue({});
});

afterEach(() => {
  delete process.env.APP_BILLING_MODE;
});

function makeAdmin(response: object | null = null) {
  return {
    graphql: vi.fn().mockImplementation(async () => ({
      json: async () => response ?? {},
    })),
  } as const;
}

describe("billing.server — coverage gaps", () => {
  it("fetchSubscriptionSnapshot falls back to [] when activeSubscriptions field is missing", async () => {
    // currentAppInstallation present but activeSubscriptions missing —
    // hits the `?? []` branch in the destructure.
    const admin = makeAdmin({ data: { currentAppInstallation: {} } });
    const snap = await fetchSubscriptionSnapshot(admin);
    expect(snap).toEqual({ status: "inactive", name: null });
  });

  it("fetchSubscriptionSnapshot handles entirely empty json (no data key)", async () => {
    const admin = makeAdmin({});
    const snap = await fetchSubscriptionSnapshot(admin);
    expect(snap).toEqual({ status: "inactive", name: null });
  });

  it("fetchSubscriptionSnapshot swallows res.json() rejections (malformed body)", async () => {
    // graphql resolves but the response body fails to parse — exercises
    // the `.catch(() => ({}))` fallback on the json read.
    const admin = {
      graphql: vi.fn().mockResolvedValue({
        json: async () => {
          throw new Error("invalid json");
        },
      }),
    } as const;
    const snap = await fetchSubscriptionSnapshot(admin);
    expect(snap).toEqual({ status: "inactive", name: null });
  });

  it("getBillingStatus repairs a shop with no settings row and writes the cache", async () => {
    process.env.APP_BILLING_MODE = "prod";
    prismaMock.shop.upsert.mockResolvedValue({
      id: "shop-x",
      shopDomain: "no-settings.myshopify.com",
      settings: null,
    });
    prismaMock.shopSettings.upsert.mockResolvedValue({
      id: "settings-created",
      billingPlanOverride: null,
      billingPlanSelection: null,
      billingPlanSelectionAt: null,
      subscriptionStatus: null,
      subscriptionName: null,
      subscriptionCheckedAt: null,
    });
    const admin = makeAdmin({
      data: {
        currentAppInstallation: {
          activeSubscriptions: [{ id: "1", name: "Pro", status: "ACTIVE", test: false }],
        },
      },
    });
    const status = await getBillingStatus("no-settings.myshopify.com", admin);
    expect(status.hasAccess).toBe(true);
    expect(status.reason).toBe("subscription_active");
    expect(prismaMock.shopSettings.upsert).toHaveBeenCalledWith({
      where: { shopId: "shop-x" },
      create: { shopId: "shop-x" },
      update: {},
    });
    expect(prismaMock.shopSettings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "settings-created" },
        data: expect.objectContaining({
          subscriptionStatus: "active",
          subscriptionName: "Pro",
        }),
      }),
    );
  });

  it("setBillingPlanOverride coerces empty-string reason to null", async () => {
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      shopDomain: "x.myshopify.com",
      settings: { id: "s1" },
    });
    await setBillingPlanOverride("x.myshopify.com", "free", "", "admin@fynd.com");
    expect(prismaMock.shopSettings.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          billingPlanOverrideReason: null,
        }),
      }),
    );
  });
});
