/**
 * Loader + action tests for app.settings.api-keys.tsx — manage merchant
 * API keys (create / revoke / delete). Locks in: validation guards,
 * one-time fullKey return contract on generate, soft-revoke vs hard-delete.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateMock, generateApiKeyMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  generateApiKeyMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    fullKey: "rpm_secret_FULLKEY",
    keyPrefix: "rpm_secret",
    keyHash: "$2b$10$hashedhashedhashed",
  })),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../lib/api-key-auth.server", () => ({
  generateApiKey: generateApiKeyMock,
  ALL_PERMISSIONS: ["read_returns", "write_returns", "read_settings", "manage_webhooks"] as const,
}));

import { loader, action } from "../app.settings.api-keys";

function formReq(form: Record<string, string>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) fd.append(k, v);
  return new Request("https://x", { method: "POST", body: fd });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  generateApiKeyMock.mockReset().mockResolvedValue({
    fullKey: "rpm_secret_FULLKEY",
    keyPrefix: "rpm_secret",
    keyHash: "$2b$10$hashedhashedhashed",
  });
});

describe("loader", () => {
  it("returns empty keys when shop not found", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data).toEqual({ keys: [] });
  });

  it("returns keys list scoped by shopId", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", shopDomain: "store.myshopify.com" });
    prismaMock.apiKey.findMany.mockResolvedValueOnce([
      { id: "k-1", name: "CI key", keyPrefix: "rpm_x", permissions: '["read_returns"]', isActive: true, lastUsedAt: null, revokedAt: null, createdAt: new Date() },
    ]);
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.keys).toHaveLength(1);
    expect(prismaMock.apiKey.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { shopId: "shop-1" },
      }),
    );
  });
});

describe("action: generate", () => {
  it("rejects missing name", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({ request: formReq({ _action: "generate" }), params: {}, context: {} } as never);
    expect(res).toEqual({ error: "Key name is required" });
  });

  it("rejects name >100 chars", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({
      request: formReq({ _action: "generate", name: "x".repeat(150) }),
      params: {}, context: {},
    } as never);
    expect(res).toEqual({ error: "Key name must be 100 characters or less" });
  });

  it("rejects when no permissions selected", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({
      request: formReq({ _action: "generate", name: "valid" }),
      params: {}, context: {},
    } as never);
    expect(res).toEqual({ error: "Select at least one permission" });
  });

  it("creates key with selected permissions and returns fullKey ONCE", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({
      request: formReq({
        _action: "generate",
        name: "CI key",
        perm_read_returns: "on",
        perm_write_returns: "on",
      }),
      params: {}, context: {},
    } as never);
    expect(res).toMatchObject({
      generatedKey: "rpm_secret_FULLKEY",
      keyName: "CI key",
    });
    expect(prismaMock.apiKey.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        shopId: "shop-1",
        name: "CI key",
        keyPrefix: "rpm_secret",
        permissions: expect.stringContaining("read_returns"),
      }),
    }));
    // permissions stored as JSON array of selected ones only
    const { data } = prismaMock.apiKey.create.mock.calls[0][0];
    expect(JSON.parse(data.permissions)).toEqual(expect.arrayContaining(["read_returns", "write_returns"]));
  });
});

describe("action: revoke", () => {
  it("rejects missing keyId", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({ request: formReq({ _action: "revoke" }), params: {}, context: {} } as never);
    expect(res).toEqual({ error: "Key ID required" });
  });

  it("soft-revokes (isActive=false + revokedAt timestamp)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({
      request: formReq({ _action: "revoke", keyId: "k-1" }),
      params: {}, context: {},
    } as never);
    expect(res).toEqual({ success: "API key revoked" });
    const updateArg = prismaMock.apiKey.update.mock.calls[0][0];
    expect(updateArg.data.isActive).toBe(false);
    expect(updateArg.data.revokedAt).toBeInstanceOf(Date);
  });
});

describe("action: delete", () => {
  it("rejects missing keyId", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({ request: formReq({ _action: "delete" }), params: {}, context: {} } as never);
    expect(res).toEqual({ error: "Key ID required" });
  });

  it("hard-deletes by id", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({
      request: formReq({ _action: "delete", keyId: "k-1" }),
      params: {}, context: {},
    } as never);
    expect(res).toEqual({ success: "API key deleted" });
    expect(prismaMock.apiKey.delete).toHaveBeenCalledWith({ where: { id: "k-1" } });
  });
});

describe("action: shop-not-found / unknown action", () => {
  it("returns error when shop missing", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await action({ request: formReq({ _action: "generate" }), params: {}, context: {} } as never);
    expect(res).toEqual({ error: "Shop not found" });
  });

  it("rejects unknown _action", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({ request: formReq({ _action: "garbage" }), params: {}, context: {} } as never);
    expect(res).toEqual({ error: "Unknown action" });
  });
});
