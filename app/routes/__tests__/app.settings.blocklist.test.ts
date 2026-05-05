/**
 * Loader + action tests for app.settings.blocklist.tsx — blocklist
 * management UI. Covers: list rendering data shape, toggle/add/delete
 * intents, validation guards.
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

import { loader, action } from "../app.settings.blocklist";

function formReq(form: Record<string, string>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) fd.append(k, v);
  return new Request("https://x/app/settings/blocklist", { method: "POST", body: fd });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({
    session: { shop: "store.myshopify.com", onlineAccessInfo: { associated_user: { email: "admin@x.com" } } },
  });
  findOrCreateShopMock.mockReset();
});

describe("loader", () => {
  it("returns empty entries when shop has no settings", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1", settings: null });
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.entries).toEqual([]);
    expect(data.blocklistEnabled).toBe(false);
  });

  it("maps entries and includes ISO createdAt", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", blocklistEnabled: true, shopLocale: "en", shopTimezone: "UTC" },
    });
    prismaMock.blocklistEntry.findMany.mockResolvedValueOnce([
      { id: "b-1", type: "email", value: "bad@x.com", reason: "fraud", blockedBy: "admin", createdAt: new Date("2025-01-01T00:00:00.000Z") },
    ]);
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.blocklistEnabled).toBe(true);
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0]).toMatchObject({
      id: "b-1",
      type: "email",
      value: "bad@x.com",
      reason: "fraud",
      blockedBy: "admin",
    });
    expect(typeof data.entries[0].createdAt).toBe("string");
  });
});

describe("action: toggle intent", () => {
  it("flips blocklistEnabled to true when checkbox is on", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.shopSettings.upsert.mockResolvedValueOnce({ id: "s-1" });
    const res = await action({ request: formReq({ intent: "toggle", blocklistEnabled: "on" }), params: {}, context: {} } as never);
    expect(res).toEqual({ success: true });
    expect(prismaMock.shopSettings.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { blocklistEnabled: true },
    }));
  });

  it("flips blocklistEnabled to false when checkbox absent", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.shopSettings.upsert.mockResolvedValueOnce({ id: "s-1" });
    await action({ request: formReq({ intent: "toggle" }), params: {}, context: {} } as never);
    expect(prismaMock.shopSettings.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { blocklistEnabled: false },
    }));
  });
});

describe("action: add intent", () => {
  it("rejects invalid entry type", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.shopSettings.upsert.mockResolvedValueOnce({ id: "s-1" });
    const res = await action({ request: formReq({ intent: "add", type: "bogus", value: "x@y.com" }), params: {}, context: {} } as never);
    expect(res).toEqual({ error: "Invalid entry type" });
  });

  it("rejects empty value", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.shopSettings.upsert.mockResolvedValueOnce({ id: "s-1" });
    const res = await action({ request: formReq({ intent: "add", type: "email", value: "" }), params: {}, context: {} } as never);
    expect(res).toEqual({ error: "Value is required (max 256 characters)" });
  });

  it("rejects oversized value (>256 chars)", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.shopSettings.upsert.mockResolvedValueOnce({ id: "s-1" });
    const res = await action({ request: formReq({ intent: "add", type: "email", value: "a".repeat(300) }), params: {}, context: {} } as never);
    expect(res).toEqual({ error: "Value is required (max 256 characters)" });
  });

  it("rejects duplicate entry", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.shopSettings.upsert.mockResolvedValueOnce({ id: "s-1" });
    prismaMock.blocklistEntry.findUnique.mockResolvedValueOnce({ id: "existing" });
    const res = await action({ request: formReq({ intent: "add", type: "email", value: "x@y.com" }), params: {}, context: {} } as never);
    expect(res).toEqual({ error: "This entry already exists in the blocklist" });
  });

  it("normalizes value to lowercase and creates entry", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.shopSettings.upsert.mockResolvedValueOnce({ id: "s-1" });
    prismaMock.blocklistEntry.findUnique.mockResolvedValueOnce(null);
    const res = await action({
      request: formReq({ intent: "add", type: "email", value: "  Bad@Example.COM  ", reason: "fraud" }),
      params: {}, context: {},
    } as never);
    expect(res).toEqual({ success: true });
    expect(prismaMock.blocklistEntry.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        type: "email",
        value: "bad@example.com",
        reason: "fraud",
      }),
    }));
  });

  it("accepts all 4 valid entry types", async () => {
    for (const type of ["email", "phone", "order_name", "ip"]) {
      resetPrismaMock(prismaMock);
      findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
      prismaMock.shopSettings.upsert.mockResolvedValueOnce({ id: "s-1" });
      prismaMock.blocklistEntry.findUnique.mockResolvedValueOnce(null);
      const res = await action({
        request: formReq({ intent: "add", type, value: "x" }),
        params: {}, context: {},
      } as never);
      expect(res).toEqual({ success: true });
    }
  });
});

describe("action: delete intent", () => {
  it("deletes entry scoped to settingsId", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.shopSettings.upsert.mockResolvedValueOnce({ id: "s-1" });
    const res = await action({
      request: formReq({ intent: "delete", entryId: "b-target" }),
      params: {}, context: {},
    } as never);
    expect(res).toEqual({ success: true });
    expect(prismaMock.blocklistEntry.deleteMany).toHaveBeenCalledWith({
      where: { id: "b-target", settingsId: "s-1" },
    });
  });

  it("no-op when entryId missing", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.shopSettings.upsert.mockResolvedValueOnce({ id: "s-1" });
    const res = await action({
      request: formReq({ intent: "delete" }),
      params: {}, context: {},
    } as never);
    expect(res).toEqual({ success: true });
    expect(prismaMock.blocklistEntry.deleteMany).not.toHaveBeenCalled();
  });
});

describe("action: unknown intent", () => {
  it("returns error", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.shopSettings.upsert.mockResolvedValueOnce({ id: "s-1" });
    const res = await action({ request: formReq({ intent: "garbage" }), params: {}, context: {} } as never);
    expect(res).toEqual({ error: "Unknown action" });
  });
});
