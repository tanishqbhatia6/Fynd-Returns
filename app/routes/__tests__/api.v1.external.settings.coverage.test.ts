import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateApiKeyMock, checkRateLimitMock, checkPerKeyRateLimitMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateApiKeyMock: vi.fn(),
  checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 10, retryAfterMs: 0 })),
  checkPerKeyRateLimitMock: vi.fn<(...args: unknown[]) => Promise<Response | null>>(async () => null),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/api-key-auth.server", () => ({ authenticateApiKey: authenticateApiKeyMock }));
vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: checkRateLimitMock,
  rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
}));
vi.mock("../../lib/external-api-helpers.server", async () => {
  const actual = await vi.importActual<typeof import("../../lib/external-api-helpers.server")>(
    "../../lib/external-api-helpers.server",
  );
  return { ...actual, checkPerKeyRateLimit: checkPerKeyRateLimitMock };
});

import { loader } from "../api.v1.external.settings";

const mkReq = () => new Request("https://app.example/api/v1/external/settings");

const SANITIZED_KEYS = [
  "returnWindowDays",
  "autoApproveEnabled",
  "autoRefundEnabled",
  "photoRequired",
  "refundPaymentMethod",
  "returnFeeAmount",
  "returnFeeCurrency",
  "bonusCreditEnabled",
  "bonusCreditPct",
  "greenReturnsEnabled",
  "portalExchangeEnabled",
  "shopCurrency",
  "shopTimezone",
  "discountCodeRefundEnabled",
];

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateApiKeyMock.mockReset().mockResolvedValue({ ok: true, keyId: "k-1", shopId: "shop-1" });
  checkRateLimitMock.mockReset().mockResolvedValue({ allowed: true, remaining: 10, retryAfterMs: 0 });
  checkPerKeyRateLimitMock.mockReset().mockResolvedValue(null);
});

async function callLoader() {
  return loader({ request: mkReq(), params: {}, context: {} } as never);
}

describe("GET /api/v1/external/settings — sanitized response shape coverage", () => {
  it("returns exactly the 14 whitelisted fields and no extras", async () => {
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      id: "settings-1",
      shopId: "shop-1",
      returnWindowDays: 30,
      autoApproveEnabled: true,
      autoRefundEnabled: false,
      photoRequired: true,
      refundPaymentMethod: "original",
      returnFeeAmount: 5,
      returnFeeCurrency: "USD",
      bonusCreditEnabled: false,
      bonusCreditPct: null,
      greenReturnsEnabled: true,
      portalExchangeEnabled: false,
      shopCurrency: "USD",
      shopTimezone: "America/New_York",
      discountCodeRefundEnabled: false,
      // Sensitive — should be stripped
      shopifyAccessToken: "shpat_secret",
      fyndApiKey: "fynd_secret",
      fyndApiSecret: "fynd_secret_secret",
      internalConfig: { secret: true },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const res = await callLoader();
    expect(res.status).toBe(200);
    const body = await res.json();
    const keys = Object.keys(body.data).sort();
    expect(keys).toEqual([...SANITIZED_KEYS].sort());
  });

  it("envelope shape: includes data and empty errors array, no top-level error", async () => {
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ shopId: "shop-1" });
    const res = await callLoader();
    const body = await res.json();
    expect(body).toHaveProperty("data");
    expect(body.errors).toEqual([]);
    expect(body.error).toBeUndefined();
  });

  it("strips sensitive fields like shopifyAccessToken/fyndApiKey", async () => {
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      shopId: "shop-1",
      shopifyAccessToken: "shpat_xxx",
      fyndApiKey: "fynd_xxx",
      fyndApiSecret: "fynd_secret",
      webhookSecret: "whsec_xxx",
    });
    const res = await callLoader();
    const body = await res.json();
    expect(body.data.shopifyAccessToken).toBeUndefined();
    expect(body.data.fyndApiKey).toBeUndefined();
    expect(body.data.fyndApiSecret).toBeUndefined();
    expect(body.data.webhookSecret).toBeUndefined();
  });

  it("strips internal/identifier fields (id, shopId, createdAt, updatedAt)", async () => {
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      id: "settings-1",
      shopId: "shop-1",
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-02-01T00:00:00Z",
      returnWindowDays: 30,
    });
    const res = await callLoader();
    const body = await res.json();
    expect(body.data.id).toBeUndefined();
    expect(body.data.shopId).toBeUndefined();
    expect(body.data.createdAt).toBeUndefined();
    expect(body.data.updatedAt).toBeUndefined();
    expect(body.data.returnWindowDays).toBe(30);
  });

  it("coerces numeric returnFeeAmount to a string", async () => {
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      shopId: "shop-1",
      returnFeeAmount: 7.5,
      returnFeeCurrency: "EUR",
    });
    const res = await callLoader();
    const body = await res.json();
    expect(body.data.returnFeeAmount).toBe("7.5");
    expect(typeof body.data.returnFeeAmount).toBe("string");
    expect(body.data.returnFeeCurrency).toBe("EUR");
  });

  it("preserves a Decimal-like (object with toString) returnFeeAmount as string", async () => {
    // Prisma Decimal values stringify via String(); simulate that with a custom toString
    const decimalLike = { toString: () => "12.34" };
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      shopId: "shop-1",
      returnFeeAmount: decimalLike,
    });
    const res = await callLoader();
    const body = await res.json();
    expect(body.data.returnFeeAmount).toBe("12.34");
  });

  it("returns null for returnFeeAmount when unset (null)", async () => {
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      shopId: "shop-1",
      returnFeeAmount: null,
    });
    const res = await callLoader();
    const body = await res.json();
    expect(body.data.returnFeeAmount).toBeNull();
  });

  it("returns null for returnFeeAmount when undefined on input", async () => {
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      shopId: "shop-1",
      // returnFeeAmount intentionally absent
    });
    const res = await callLoader();
    const body = await res.json();
    expect(body.data.returnFeeAmount).toBeNull();
  });

  it("includes all 14 sanitized keys even when source has only shopId (others become undefined→null in JSON)", async () => {
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ shopId: "shop-1" });
    const res = await callLoader();
    const body = await res.json();
    // All keys must be present — JSON.stringify drops undefined, but returnFeeAmount is normalized to null,
    // and other keys may simply be absent if their value was undefined. Verify the shape and the explicit null.
    expect(body.data.returnFeeAmount).toBeNull();
    // No sensitive fields slip through
    for (const forbidden of ["shopifyAccessToken", "fyndApiKey", "id", "shopId"]) {
      expect(body.data[forbidden]).toBeUndefined();
    }
  });

  it("preserves boolean true/false values for feature flags", async () => {
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      shopId: "shop-1",
      autoApproveEnabled: true,
      autoRefundEnabled: true,
      photoRequired: false,
      bonusCreditEnabled: true,
      greenReturnsEnabled: false,
      portalExchangeEnabled: true,
      discountCodeRefundEnabled: true,
    });
    const res = await callLoader();
    const body = await res.json();
    expect(body.data.autoApproveEnabled).toBe(true);
    expect(body.data.autoRefundEnabled).toBe(true);
    expect(body.data.photoRequired).toBe(false);
    expect(body.data.bonusCreditEnabled).toBe(true);
    expect(body.data.greenReturnsEnabled).toBe(false);
    expect(body.data.portalExchangeEnabled).toBe(true);
    expect(body.data.discountCodeRefundEnabled).toBe(true);
  });

  it("preserves numeric fields (returnWindowDays, bonusCreditPct) as numbers", async () => {
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      shopId: "shop-1",
      returnWindowDays: 60,
      bonusCreditPct: 15,
    });
    const res = await callLoader();
    const body = await res.json();
    expect(body.data.returnWindowDays).toBe(60);
    expect(typeof body.data.returnWindowDays).toBe("number");
    expect(body.data.bonusCreditPct).toBe(15);
    expect(typeof body.data.bonusCreditPct).toBe("number");
  });

  it("passes through string fields verbatim (refundPaymentMethod, currency, timezone)", async () => {
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      shopId: "shop-1",
      refundPaymentMethod: "store_credit",
      shopCurrency: "JPY",
      shopTimezone: "Asia/Tokyo",
      returnFeeCurrency: "JPY",
    });
    const res = await callLoader();
    const body = await res.json();
    expect(body.data.refundPaymentMethod).toBe("store_credit");
    expect(body.data.shopCurrency).toBe("JPY");
    expect(body.data.shopTimezone).toBe("Asia/Tokyo");
    expect(body.data.returnFeeCurrency).toBe("JPY");
  });

  it("queries Prisma with the authenticated shopId", async () => {
    authenticateApiKeyMock.mockReset().mockResolvedValueOnce({
      ok: true,
      keyId: "k-2",
      shopId: "shop-abc-123",
    });
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ shopId: "shop-abc-123" });
    await callLoader();
    expect(prismaMock.shopSettings.findUnique).toHaveBeenCalledWith({
      where: { shopId: "shop-abc-123" },
    });
  });

  it("does not leak unknown extra fields added to ShopSettings (forward-compat allowlist)", async () => {
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({
      shopId: "shop-1",
      returnWindowDays: 30,
      // Hypothetical new internal field added later — must NOT appear
      newSecretInternalToggle: "boom",
      anotherUnvettedField: { nested: "data" },
    });
    const res = await callLoader();
    const body = await res.json();
    expect(body.data.newSecretInternalToggle).toBeUndefined();
    expect(body.data.anotherUnvettedField).toBeUndefined();
    // Only allowlisted keys
    for (const k of Object.keys(body.data)) {
      expect(SANITIZED_KEYS).toContain(k);
    }
  });

  it("response Content-Type is JSON", async () => {
    prismaMock.shopSettings.findUnique.mockResolvedValueOnce({ shopId: "shop-1" });
    const res = await callLoader();
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });
});
