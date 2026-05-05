/**
 * Loader + action tests for app.settings.product-policies.tsx — per-product
 * return policy rules. Covers JSON parse tolerance, validation/normalisation
 * of rule entries (windowDays clamped, matchValue trimmed, returnable
 * default-true), and DB save error path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateMock, findOrCreateShopMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  findOrCreateShopMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../lib/shop.server", () => ({ findOrCreateShop: findOrCreateShopMock }));

import { loader, action } from "../app.settings.product-policies";

function formReq(form: Record<string, string>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) fd.append(k, v);
  return new Request("https://x", { method: "POST", body: fd });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  findOrCreateShopMock.mockReset();
});

describe("loader", () => {
  it("returns empty rules when no settings", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1", settings: null });
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data).toEqual({ rules: [] });
  });

  it("parses valid productPoliciesJson", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({
      id: "shop-1",
      settings: { productPoliciesJson: JSON.stringify([{ id: "r1", matchType: "tags", matchValue: "final-sale", windowDays: 14, returnable: false }]) },
    });
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.rules).toHaveLength(1);
    expect(data.rules[0]).toMatchObject({ matchType: "tags", returnable: false });
  });

  it("tolerates malformed JSON", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({
      id: "shop-1",
      settings: { productPoliciesJson: "{not json" },
    });
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.rules).toEqual([]);
  });

  it("returns empty when productPoliciesJson is not an array", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({
      id: "shop-1",
      settings: { productPoliciesJson: JSON.stringify({ field: "x" }) },
    });
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.rules).toEqual([]);
  });
});

describe("action", () => {
  it("trims matchValue, clamps windowDays to >=0, defaults returnable=true", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    const rules = JSON.stringify([
      { matchType: "tags", matchValue: "  final-sale  ", windowDays: -5 },
    ]);
    await action({ request: formReq({ rulesJson: rules }), params: {}, context: {} } as never);
    const upsertArg = prismaMock.shopSettings.upsert.mock.calls[0][0];
    const stored = JSON.parse(upsertArg.update.productPoliciesJson);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      matchType: "tags",
      matchValue: "final-sale",   // trimmed
      windowDays: 0,               // clamped from -5
      returnable: true,            // default
    });
    // generated id when none supplied
    expect(typeof stored[0].id).toBe("string");
    expect(stored[0].id.length).toBeGreaterThan(0);
  });

  it("preserves explicit id and returnable=false", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    const rules = JSON.stringify([
      { id: "rule-keep", matchType: "product_type", matchValue: "perishable", windowDays: 0, returnable: false },
    ]);
    await action({ request: formReq({ rulesJson: rules }), params: {}, context: {} } as never);
    const stored = JSON.parse(prismaMock.shopSettings.upsert.mock.calls[0][0].update.productPoliciesJson);
    expect(stored[0]).toMatchObject({ id: "rule-keep", returnable: false });
  });

  it("filters out malformed rules (no matchType)", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    const rules = JSON.stringify([
      { matchType: "tags", matchValue: "ok", windowDays: 5 },
      { matchValue: "no matchType" },
      "string-not-object",
      null,
    ]);
    await action({ request: formReq({ rulesJson: rules }), params: {}, context: {} } as never);
    const stored = JSON.parse(prismaMock.shopSettings.upsert.mock.calls[0][0].update.productPoliciesJson);
    expect(stored).toHaveLength(1);
  });

  it("returns Invalid rules format on JSON parse error", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({
      request: formReq({ rulesJson: "{not json" }),
      params: {}, context: {},
    } as never);
    expect(res).toEqual({ success: false, error: "Invalid rules format." });
  });

  it("writes empty array when rulesJson is missing", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({ request: formReq({}), params: {}, context: {} } as never);
    expect(res).toEqual({ success: true });
    const stored = JSON.parse(prismaMock.shopSettings.upsert.mock.calls[0][0].update.productPoliciesJson);
    expect(stored).toEqual([]);
  });

  it("returns success:false when DB upsert throws", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.shopSettings.upsert.mockRejectedValueOnce(new Error("DB unavailable"));
    const res = await action({
      request: formReq({ rulesJson: JSON.stringify([]) }),
      params: {}, context: {},
    } as never);
    expect(res).toEqual({ success: false, error: "DB unavailable" });
  });

  it("converts non-numeric windowDays to default 30", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    const rules = JSON.stringify([
      { matchType: "tags", matchValue: "x", windowDays: "abc" },
    ]);
    await action({ request: formReq({ rulesJson: rules }), params: {}, context: {} } as never);
    const stored = JSON.parse(prismaMock.shopSettings.upsert.mock.calls[0][0].update.productPoliciesJson);
    expect(stored[0].windowDays).toBe(30);
  });

  it("strips empty policyText to undefined", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    const rules = JSON.stringify([
      { matchType: "tags", matchValue: "x", windowDays: 30, policyText: "   " },
    ]);
    await action({ request: formReq({ rulesJson: rules }), params: {}, context: {} } as never);
    const stored = JSON.parse(prismaMock.shopSettings.upsert.mock.calls[0][0].update.productPoliciesJson);
    expect(stored[0].policyText).toBeUndefined();
  });
});
