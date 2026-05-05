/**
 * Loader + action tests for app.settings.rules.tsx — return policy rules
 * (window, reasons, regions, offers, fees-by-reason, windows-by-country).
 * Verifies parse-tolerant loader, action clamps, malformed-JSON
 * preserve-existing semantics.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateMock,
  findOrCreateShopMock,
  parseJsonArrayMock,
  parseJsonObjectMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  findOrCreateShopMock: vi.fn(),
  parseJsonArrayMock: vi.fn(),
  parseJsonObjectMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../lib/shop.server", () => ({ findOrCreateShop: findOrCreateShopMock }));
vi.mock("../../lib/parse-json", () => ({
  parseJsonArray: parseJsonArrayMock,
  parseJsonObject: parseJsonObjectMock,
}));

import { loader, action } from "../app.settings.rules";

function formReq(form: Record<string, string>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) fd.append(k, v);
  return new Request("https://x", { method: "POST", body: fd });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  findOrCreateShopMock.mockReset();
  parseJsonArrayMock.mockReset().mockImplementation((_s: string | null, fallback: unknown[]) => fallback);
  parseJsonObjectMock.mockReset().mockReturnValue({});
});

describe("loader", () => {
  it("returns defaults when shop has no settings", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ settings: null });
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.returnWindowDays).toBe(30);
    expect(data.minimumReturnPrice).toBe("0");
    expect(data.returnOffersEnabled).toBe(false);
    expect(data.shopCurrency).toBe("USD");
  });

  it("returns settings values + parsed JSON arrays/objects", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({
      settings: {
        returnWindowDays: 14,
        minimumReturnPrice: "9.99",
        returnReasonsJson: "[]",
        returnOffersEnabled: true,
        shopCurrency: "EUR",
      },
    });
    parseJsonArrayMock.mockReturnValueOnce(["a", "b"]); // reasons
    parseJsonArrayMock.mockReturnValueOnce([]);          // regions
    parseJsonArrayMock.mockReturnValueOnce([]);          // offers
    parseJsonObjectMock.mockReturnValueOnce({ apparel: ["too tight"] });
    parseJsonArrayMock.mockReturnValueOnce([]);          // fees
    parseJsonArrayMock.mockReturnValueOnce([]);          // windows
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.returnWindowDays).toBe(14);
    expect(data.minimumReturnPrice).toBe("9.99");
    expect(data.returnReasons).toEqual(["a", "b"]);
    expect(data.returnReasonsByCategory).toHaveLength(1);
    expect(data.returnReasonsByCategory[0]).toMatchObject({
      category: "apparel",
      reasons: ["too tight"],
    });
  });

  it("filters out non-array values in reasonsByCategory map", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({
      settings: { returnReasonsByCategoryJson: '{"x":"not-array"}' },
    });
    parseJsonArrayMock.mockReturnValue([]);
    parseJsonObjectMock.mockReturnValueOnce({ x: "not-array", y: ["ok"] });
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.returnReasonsByCategory).toHaveLength(2);
    // entry x → reasons becomes [] (Array.isArray fallback)
    expect(data.returnReasonsByCategory.find((c) => c.category === "x")?.reasons).toEqual([]);
    expect(data.returnReasonsByCategory.find((c) => c.category === "y")?.reasons).toEqual(["ok"]);
  });
});

describe("action", () => {
  it("clamps returnWindowDays to [1, 365]", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({ returnWindowDays: "10000" }),
      params: {}, context: {},
    } as never);
    const arg = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(arg.update.returnWindowDays).toBe(365);

    resetPrismaMock(prismaMock);
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({ returnWindowDays: "0" }),
      params: {}, context: {},
    } as never);
    const arg2 = prismaMock.shopSettings.upsert.mock.calls[0][0];
    // parseInt("0",10) is 0 which is falsy; the `|| 30` fallback engages,
    // so the user-entered "0" is treated as the default 30, not 1.
    expect(arg2.update.returnWindowDays).toBe(30);
  });

  it("falls back to 30 days when value is non-numeric", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({ returnWindowDays: "abc" }),
      params: {}, context: {},
    } as never);
    const arg = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(arg.update.returnWindowDays).toBe(30);
  });

  it("clamps minimumReturnPrice to >=0 and tolerates non-numeric", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({ minimumReturnPrice: "-5" }),
      params: {}, context: {},
    } as never);
    expect(prismaMock.shopSettings.upsert.mock.calls[0][0].update.minimumReturnPrice).toBe(0);

    resetPrismaMock(prismaMock);
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({ minimumReturnPrice: "abc" }),
      params: {}, context: {},
    } as never);
    expect(prismaMock.shopSettings.upsert.mock.calls[0][0].update.minimumReturnPrice).toBe(0);
  });

  it("returnOffersEnabled flips on 'on' value", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({ returnOffersEnabled: "on" }),
      params: {}, context: {},
    } as never);
    expect(prismaMock.shopSettings.upsert.mock.calls[0][0].update.returnOffersEnabled).toBe(true);
  });

  it("ignores malformed JSON inputs (preserve existing on update)", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({
        returnReasonsJson: "{not json",
        restrictedRegionsJson: "{also bad",
        returnOffersJson: "{",
        feesByReasonJson: "}",
        windowsByCountryJson: "[unparseable",
      }),
      params: {}, context: {},
    } as never);
    const update = prismaMock.shopSettings.upsert.mock.calls[0][0].update;
    expect(update.returnReasonsJson).toBeUndefined();
    expect(update.restrictedRegionsJson).toBeUndefined();
    expect(update.returnOffersJson).toBeUndefined();
    expect(update.returnFeesByReasonJson).toBeUndefined();
    expect(update.returnWindowByCountryJson).toBeUndefined();
  });

  it("ignores valid-JSON-but-not-array inputs", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({
        returnReasonsJson: JSON.stringify({ wrong: "shape" }),
        restrictedRegionsJson: JSON.stringify("string"),
      }),
      params: {}, context: {},
    } as never);
    const update = prismaMock.shopSettings.upsert.mock.calls[0][0].update;
    expect(update.returnReasonsJson).toBeUndefined();
    expect(update.restrictedRegionsJson).toBeUndefined();
  });

  it("persists valid array JSON inputs", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({
        returnReasonsJson: JSON.stringify(["damaged", "wrong size"]),
        returnOffersJson: JSON.stringify([{ offerType: "discount_pct", offerValue: 10 }]),
      }),
      params: {}, context: {},
    } as never);
    const update = prismaMock.shopSettings.upsert.mock.calls[0][0].update;
    expect(JSON.parse(update.returnReasonsJson)).toEqual(["damaged", "wrong size"]);
    expect(JSON.parse(update.returnOffersJson)).toHaveLength(1);
  });

  it("persists object reasonsByCategory but rejects array shape", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({
        returnReasonsByCategoryJson: JSON.stringify(["should-be-object"]),
      }),
      params: {}, context: {},
    } as never);
    const update = prismaMock.shopSettings.upsert.mock.calls[0][0].update;
    expect(update.returnReasonsByCategoryJson).toBeUndefined();

    resetPrismaMock(prismaMock);
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({
        returnReasonsByCategoryJson: JSON.stringify({ apparel: ["x"] }),
      }),
      params: {}, context: {},
    } as never);
    const update2 = prismaMock.shopSettings.upsert.mock.calls[0][0].update;
    expect(JSON.parse(update2.returnReasonsByCategoryJson)).toEqual({ apparel: ["x"] });
  });

  it("returns success:false on DB upsert failure", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.shopSettings.upsert.mockRejectedValueOnce(new Error("DB out"));
    const res = await action({
      request: formReq({}),
      params: {}, context: {},
    } as never);
    expect(res).toEqual({ success: false, error: "DB out" });
  });
});
