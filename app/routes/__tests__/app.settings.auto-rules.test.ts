/**
 * Loader + action tests for app.settings.auto-rules.tsx — auto-approve
 * rule editor. Verifies:
 *   - rules deserialize through parseAutoApproveRules helper
 *   - action validates the JSON shape (rejects malformed entries)
 *   - action upserts shopSettings with serialized rules
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateMock, findOrCreateShopMock, parseAutoApproveRulesMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  findOrCreateShopMock: vi.fn(),
  parseAutoApproveRulesMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../lib/shop.server", () => ({ findOrCreateShop: findOrCreateShopMock }));
vi.mock("../../lib/auto-approve.server", () => ({
  parseAutoApproveRules: parseAutoApproveRulesMock,
}));

import { loader, action } from "../app.settings.auto-rules";

function formReq(form: Record<string, string>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) fd.append(k, v);
  return new Request("https://x", { method: "POST", body: fd });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  findOrCreateShopMock.mockReset();
  parseAutoApproveRulesMock.mockReset().mockReturnValue([]);
});

describe("loader", () => {
  it("returns empty rules + autoApproveEnabled=false when no settings", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1", settings: null });
    parseAutoApproveRulesMock.mockReturnValueOnce([]);
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data).toEqual({ rules: [], autoApproveEnabled: false });
  });

  it("delegates rule parsing to parseAutoApproveRules helper", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({
      id: "shop-1",
      settings: { autoApproveRulesJson: '[{"field":"orderValue"}]', autoApproveEnabled: true },
    });
    parseAutoApproveRulesMock.mockReturnValueOnce([
      { field: "orderValue", operator: "lte", value: "100", action: "approve" },
    ]);
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.rules).toHaveLength(1);
    expect(data.autoApproveEnabled).toBe(true);
    expect(parseAutoApproveRulesMock).toHaveBeenCalledWith('[{"field":"orderValue"}]');
  });
});

describe("action", () => {
  it("returns success:true and writes empty array when no rulesJson", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({ request: formReq({}), params: {}, context: {} } as never);
    expect(res).toEqual({ success: true });
    const upsertArg = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(JSON.parse(upsertArg.update.autoApproveRulesJson)).toEqual([]);
  });

  it("filters out malformed rule objects (missing required fields)", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    const malformed = JSON.stringify([
      { field: "orderValue", operator: "lte", value: "100", action: "approve" },
      { field: "orderValue" },                  // missing fields → dropped
      "garbage",                                // wrong type → dropped
      null,                                     // null → dropped
    ]);
    await action({ request: formReq({ rulesJson: malformed }), params: {}, context: {} } as never);
    const upsertArg = prismaMock.shopSettings.upsert.mock.calls[0][0];
    const stored = JSON.parse(upsertArg.update.autoApproveRulesJson);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ field: "orderValue", operator: "lte" });
  });

  it("writes empty array when rulesJson is not an array (e.g. plain object)", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({ rulesJson: JSON.stringify({ field: "x" }) }),
      params: {}, context: {},
    } as never);
    const upsertArg = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(JSON.parse(upsertArg.update.autoApproveRulesJson)).toEqual([]);
  });

  it("returns Invalid rules format on JSON parse error", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({
      request: formReq({ rulesJson: "{not json" }),
      params: {}, context: {},
    } as never);
    expect(res).toEqual({ error: "Invalid rules format" });
  });

  it("upserts settings with the validated rules array", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    const valid = JSON.stringify([
      { field: "orderValue", operator: "lte", value: "100", action: "approve" },
    ]);
    await action({ request: formReq({ rulesJson: valid }), params: {}, context: {} } as never);
    expect(prismaMock.shopSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { shopId: "shop-1" },
    }));
  });
});
