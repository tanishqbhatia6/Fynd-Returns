/**
 * Shopify Managed Pricing billing gate.
 * ==========================================================================
 *
 * This module decides whether a given shop is allowed into the embedded
 * admin. Three layers, checked top-to-bottom:
 *
 *   1. Environment gate (APP_BILLING_MODE)
 *        "dev"  → billing bypassed entirely. Every shop gets full
 *                 access regardless of subscription state. Used by
 *                 UAT + local dev.
 *        "prod" → subscription enforced unless layer 2, 3, or 4 says
 *                 otherwise. Used by the production deployment.
 *        (unset) → defaults to "dev" — fail-open for safety during
 *                 first boot so nobody gets locked out.
 *
 *   2. Per-shop override (ShopSettings.billingPlanOverride)
 *        "free"  → force free access (partner shops, beta testers,
 *                 internal QA) even when APP_BILLING_MODE=prod.
 *        "paid"  → force billing even when APP_BILLING_MODE=dev.
 *                 (Useful for dogfooding a paid flow on a dev build.)
 *        null    → fall through to layer 3.
 *
 *   3. Merchant free plan selection
 *        "free" → merchant selected the app's free tier from /app/billing.
 *                 Grants access without a Shopify charge.
 *
 *   4. Live subscription check
 *        Calls Shopify's currentAppInstallation.activeSubscriptions
 *        GraphQL query. Cached snapshot stored on ShopSettings so we
 *        don't hit Shopify on every request. Refreshed on the
 *        app_subscriptions/update webhook and when stale (>10 min).
 *
 * Superadmins (SUPERADMIN_EMAILS env var) are the only users who can
 * toggle the per-shop override — regular merchants never see the
 * override UI and can't grant themselves free access.
 *
 * All architectural decisions documented in SHOPIFY_APP_STORE_READINESS.md.
 */

import prisma from "../db.server";
import type { AdminGraphQL } from "./shopify-admin.server";

/* ── Types ─────────────────────────────────────────────────────────── */

export type BillingMode = "dev" | "prod";

export type BillingPlanOverride = "free" | "paid" | null;

export type BillingStatus = {
  /** Whether this shop currently has full app access. */
  hasAccess: boolean;
  /**
   * Why access was granted / denied. Useful for logging + the billing
   * page UI.
   */
  reason:
    | "dev_mode" // APP_BILLING_MODE=dev, billing bypassed
    | "override_free" // per-shop override forces free
    | "free_plan_selected" // merchant selected the first-party free plan
    | "subscription_active" // Shopify reports an active, non-test subscription
    | "subscription_missing" // no active subscription — access denied
    | "override_paid_no_sub"; // override says paid but no subscription — access denied
  mode: BillingMode;
  override: BillingPlanOverride;
  /** Cached subscription details — null if never checked or none found. */
  subscriptionName?: string | null;
  subscriptionCheckedAt?: Date | null;
};

/* ── Env helpers ───────────────────────────────────────────────────── */

/**
 * Read APP_BILLING_MODE. Defaults to "dev" when unset so we fail-open
 * during first boot / misconfiguration (better than locking everyone
 * out of a misconfigured production).
 */
export function getBillingMode(): BillingMode {
  const v = (process.env.APP_BILLING_MODE ?? "").toLowerCase();
  if (v === "prod" || v === "production") return "prod";
  return "dev";
}

/**
 * Parse SUPERADMIN_EMAILS — comma-separated list of user emails that
 * can view + toggle the per-shop billing override. Empty list = no
 * superadmins (the override UI is completely hidden).
 */
function getSuperadminEmails(): string[] {
  const raw = process.env.SUPERADMIN_EMAILS ?? "";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Return true if the given email is listed in SUPERADMIN_EMAILS.
 * Case-insensitive; whitespace-tolerant.
 */
export function isSuperAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  const list = getSuperadminEmails();
  if (list.length === 0) return false;
  return list.includes(email.trim().toLowerCase());
}

/* ── GraphQL ───────────────────────────────────────────────────────── */

const ACTIVE_SUBSCRIPTIONS_QUERY = `#graphql
  query currentAppSubscriptions {
    currentAppInstallation {
      activeSubscriptions {
        id
        name
        status
        test
        currentPeriodEnd
        lineItems {
          plan {
            pricingDetails {
              __typename
              ... on AppRecurringPricing {
                price { amount currencyCode }
                interval
              }
            }
          }
        }
      }
    }
  }
`;

type ActiveSubscription = {
  id: string;
  name: string;
  status: string;
  test: boolean;
  currentPeriodEnd?: string;
};

type SubscriptionSnapshot = {
  status: "active" | "inactive";
  name: string | null;
};

/**
 * Ask Shopify for the shop's current active subscription(s). Returns
 * the first non-test active subscription, or `inactive` if none exist.
 *
 * Test-mode subscriptions (created during development) are IGNORED for
 * production billing decisions — otherwise every dev install would
 * register as "paying" and skip the real billing UI.
 */
export async function fetchSubscriptionSnapshot(
  admin: AdminGraphQL,
): Promise<SubscriptionSnapshot> {
  let res: Response;
  try {
    res = await admin.graphql(ACTIVE_SUBSCRIPTIONS_QUERY);
  } catch {
    // Network error → assume inactive. The gate will redirect to
    // /app/billing where we can show an "can't verify subscription"
    // message. We never silently grant access on a failed check.
    return { status: "inactive", name: null };
  }
  const json = (await res.json().catch(() => ({}))) as {
    data?: {
      currentAppInstallation?: {
        activeSubscriptions?: ActiveSubscription[];
      };
    };
  };
  const subs = json.data?.currentAppInstallation?.activeSubscriptions ?? [];
  const liveSub = subs.find((s) => s.status === "ACTIVE" && s.test !== true);
  if (liveSub) {
    return { status: "active", name: liveSub.name };
  }
  return { status: "inactive", name: null };
}

/* ── The gate ──────────────────────────────────────────────────────── */

const SNAPSHOT_TTL_MS = 10 * 60 * 1000; // refresh subscription cache every 10 min

function normalizeShopDomain(shopDomain: string): string {
  return shopDomain.trim().toLowerCase().replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
}

async function findOrCreateBillingShop(shopDomain: string) {
  const normalizedShopDomain = normalizeShopDomain(shopDomain);
  const shop = await prisma.shop.upsert({
    where: { shopDomain: normalizedShopDomain },
    create: {
      shopDomain: normalizedShopDomain,
      settings: { create: {} },
    },
    update: {},
    include: { settings: true },
  });

  if (shop.settings) return shop;

  const settings = await prisma.shopSettings.upsert({
    where: { shopId: shop.id },
    create: { shopId: shop.id },
    update: {},
  });

  return { ...shop, settings };
}

/**
 * Evaluate the full billing status for a shop. This is the single
 * entry point used by the app.tsx loader gate and the /app/billing
 * status page.
 *
 * @param shopDomain  e.g. "my-store.myshopify.com"
 * @param admin       Shopify Admin GraphQL client (for live sub check).
 *                    Pass null to use only cached data (e.g. from a
 *                    webhook handler that doesn't have a session).
 */
export async function getBillingStatus(
  shopDomain: string,
  admin: AdminGraphQL | null,
): Promise<BillingStatus> {
  const mode = getBillingMode();

  // Load the shop + settings. Create either row if missing (first request
  // after install, or old installs created before ShopSettings existed).
  const shop = await findOrCreateBillingShop(shopDomain);
  const override = (shop.settings?.billingPlanOverride as BillingPlanOverride) ?? null;
  const selectedPlan = shop.settings?.billingPlanSelection ?? null;

  // ── Layer 1: env mode ───────────────────────────────────────────
  // dev mode is the easy path: everyone gets in, we don't bother
  // Shopify with a subscription query. Override can still force
  // "paid" mode for dogfooding.
  if (mode === "dev" && override !== "paid") {
    return {
      hasAccess: true,
      reason: "dev_mode",
      mode,
      override,
      subscriptionName: shop.settings?.subscriptionName ?? null,
      subscriptionCheckedAt: shop.settings?.subscriptionCheckedAt ?? null,
    };
  }

  // ── Layer 2: per-shop override ──────────────────────────────────
  if (override === "free") {
    return {
      hasAccess: true,
      reason: "override_free",
      mode,
      override,
      subscriptionName: shop.settings?.subscriptionName ?? null,
      subscriptionCheckedAt: shop.settings?.subscriptionCheckedAt ?? null,
    };
  }

  // ── Layer 3: merchant-selected free plan ────────────────────────
  if (selectedPlan === "free" && override !== "paid") {
    return {
      hasAccess: true,
      reason: "free_plan_selected",
      mode,
      override,
      subscriptionName: "Free",
      subscriptionCheckedAt: shop.settings?.billingPlanSelectionAt ?? null,
    };
  }

  // ── Layer 4: live subscription check ────────────────────────────
  // Use cached snapshot if recent enough + we don't have a live admin
  // client (e.g. webhook context).
  const cached = shop.settings;
  const cacheAge = cached?.subscriptionCheckedAt
    ? Date.now() - cached.subscriptionCheckedAt.getTime()
    : Infinity;

  let snapshot: SubscriptionSnapshot | null = null;
  if (admin) {
    snapshot = await fetchSubscriptionSnapshot(admin);
    // Persist the snapshot for the next webhook / no-admin call.
    if (cached) {
      await prisma.shopSettings
        .update({
          where: { id: cached.id },
          data: {
            subscriptionStatus: snapshot.status,
            subscriptionName: snapshot.name,
            subscriptionCheckedAt: new Date(),
          },
        })
        .catch(() => {});
    }
  } else if (cacheAge < SNAPSHOT_TTL_MS && cached?.subscriptionStatus) {
    snapshot = {
      status: cached.subscriptionStatus as "active" | "inactive",
      name: cached.subscriptionName ?? null,
    };
  } else {
    // No admin + no fresh cache → assume inactive. Deny access.
    // The UI can surface this as a "can't verify subscription" error.
    snapshot = { status: "inactive", name: null };
  }

  const hasActive = snapshot.status === "active";
  if (hasActive) {
    return {
      hasAccess: true,
      reason: "subscription_active",
      mode,
      override,
      subscriptionName: snapshot.name,
      subscriptionCheckedAt: new Date(),
    };
  }

  // Distinguish "no sub in prod" from "override=paid but no sub in dev"
  // so the billing UI can show accurate copy.
  if (override === "paid") {
    return {
      hasAccess: false,
      reason: "override_paid_no_sub",
      mode,
      override,
      subscriptionName: null,
      subscriptionCheckedAt: new Date(),
    };
  }
  return {
    hasAccess: false,
    reason: "subscription_missing",
    mode,
    override,
    subscriptionName: null,
    subscriptionCheckedAt: new Date(),
  };
}

/* ── Managed Pricing upgrade URL ───────────────────────────────────── */

/**
 * Build the Shopify Managed Pricing plan-picker URL for a shop. The
 * handle comes from the app's Partner Dashboard configuration — it's
 * the URL slug merchants see in `admin/charges/<handle>/pricing_plans`.
 *
 * Falls back to the client-id format when APP_MANAGED_PRICING_HANDLE
 * isn't set, which is the default for apps that use the client-id as
 * their handle.
 */
export function getManagedPricingUpgradeUrl(shopDomain: string): string {
  const handle = process.env.APP_MANAGED_PRICING_HANDLE || process.env.SHOPIFY_API_KEY || "";
  const shop = shopDomain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return `https://admin.shopify.com/store/${shop.replace(".myshopify.com", "")}/charges/${handle}/pricing_plans`;
}

/* ── Superadmin override mutations ─────────────────────────────────── */

/**
 * Set or clear the per-shop billing override. Caller is responsible
 * for verifying the acting user is a superadmin (via isSuperAdmin()).
 * An audit trail is written to the ShopSettings row.
 */
export async function setBillingPlanOverride(
  shopDomain: string,
  value: BillingPlanOverride,
  reason: string,
  adminEmail: string,
): Promise<void> {
  const normalizedShopDomain = normalizeShopDomain(shopDomain);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: normalizedShopDomain },
    include: { settings: true },
  });
  if (!shop?.settings) return;
  await prisma.shopSettings.update({
    where: { id: shop.settings.id },
    data: {
      billingPlanOverride: value,
      billingPlanOverrideReason: reason || null,
      billingPlanOverrideBy: adminEmail,
      billingPlanOverrideAt: new Date(),
    },
  });
}

/**
 * Merchant-facing free tier selection. This is intentionally separate
 * from the superadmin override so audit/UX can distinguish "merchant
 * chose Free" from "internal user granted free access".
 */
export async function selectFreeBillingPlan(shopDomain: string): Promise<void> {
  const shop = await findOrCreateBillingShop(shopDomain);

  await prisma.shopSettings.update({
    where: { id: shop.settings.id },
    data: {
      billingPlanSelection: "free",
      billingPlanSelectionAt: new Date(),
    },
  });
}
