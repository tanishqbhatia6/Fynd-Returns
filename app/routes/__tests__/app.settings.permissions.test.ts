/**
 * Loader + action tests for app.settings.permissions.tsx — toggles
 * `readAllOrdersEnabled` and surfaces the SCOPES env so the UI can
 * warn about the missing read_all_orders scope.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

import { loader, action } from "../app.settings.permissions";

function formReq(form: Record<string, string>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) fd.append(k, v);
  return new Request("https://x", { method: "POST", body: fd });
}

const origScopes = process.env.SCOPES;
beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  findOrCreateShopMock.mockReset();
});
afterEach(() => {
  if (origScopes === undefined) delete process.env.SCOPES;
  else process.env.SCOPES = origScopes;
});

describe("loader", () => {
  it("hasReadAllOrdersScope=true when SCOPES contains read_all_orders", async () => {
    process.env.SCOPES = "read_orders,write_orders,read_all_orders";
    findOrCreateShopMock.mockResolvedValueOnce({
      settings: { readAllOrdersEnabled: true },
    });
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.hasReadAllOrdersScope).toBe(true);
    expect(data.readAllOrdersEnabled).toBe(true);
  });

  it("hasReadAllOrdersScope=false when SCOPES is missing it", async () => {
    process.env.SCOPES = "read_orders,write_orders";
    findOrCreateShopMock.mockResolvedValueOnce({ settings: null });
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.hasReadAllOrdersScope).toBe(false);
    expect(data.readAllOrdersEnabled).toBe(false);
  });

  it("returns scopes array (split + preserved)", async () => {
    process.env.SCOPES = "a,b,c";
    findOrCreateShopMock.mockResolvedValueOnce({ settings: null });
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.scopes).toEqual(["a", "b", "c"]);
  });

  it("scopes is empty array when SCOPES env unset", async () => {
    delete process.env.SCOPES;
    findOrCreateShopMock.mockResolvedValueOnce({ settings: null });
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.scopes).toEqual([]);
  });
});

describe("action", () => {
  it("saves readAllOrdersEnabled=true when checkbox is on", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({
      request: formReq({ readAllOrdersEnabled: "on" }),
      params: {}, context: {},
    } as never);
    expect(res).toEqual({ success: true });
    expect(prismaMock.shopSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { readAllOrdersEnabled: true },
        create: { shopId: "shop-1", readAllOrdersEnabled: true },
      }),
    );
  });

  it("saves readAllOrdersEnabled=false when checkbox absent", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({
      request: formReq({}),
      params: {}, context: {},
    } as never);
    expect(res).toEqual({ success: true });
    expect(prismaMock.shopSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { readAllOrdersEnabled: false },
      }),
    );
  });

  it("returns success:false with error message when DB throws", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.shopSettings.upsert.mockRejectedValueOnce(new Error("DB unavailable"));
    const res = await action({
      request: formReq({ readAllOrdersEnabled: "on" }),
      params: {}, context: {},
    } as never);
    expect(res).toEqual({ success: false, error: "DB unavailable" });
  });
});
