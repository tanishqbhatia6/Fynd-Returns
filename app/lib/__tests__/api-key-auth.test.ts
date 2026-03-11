import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

// --- Mock prisma ---
// vi.mock is hoisted, so we use vi.hoisted to create the mock object
// before the factory runs.
const mockPrisma = vi.hoisted(() => ({
  apiKey: {
    findMany: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock("../../db.server", () => ({ default: mockPrisma }));

import {
  generateApiKey,
  authenticateApiKey,
  ALL_PERMISSIONS,
  type ApiKeyPermission,
} from "../api-key-auth.server";

describe("generateApiKey", () => {
  it("produces a key with rpm_ prefix", async () => {
    const { fullKey } = await generateApiKey();
    expect(fullKey.startsWith("rpm_")).toBe(true);
  });

  it("produces a key with rpm_ prefix + 40 hex characters (44 total)", async () => {
    const { fullKey } = await generateApiKey();
    expect(fullKey).toHaveLength(44); // "rpm_" (4) + 40 hex chars
    expect(fullKey).toMatch(/^rpm_[0-9a-f]{40}$/);
  });

  it("keyPrefix is the first 8 characters of the full key", async () => {
    const { fullKey, keyPrefix } = await generateApiKey();
    expect(keyPrefix).toBe(fullKey.substring(0, 8));
    expect(keyPrefix).toHaveLength(8);
  });

  it("keyHash is a valid bcrypt hash", async () => {
    const { fullKey, keyHash } = await generateApiKey();
    // bcrypt hashes start with $2a$ or $2b$
    expect(keyHash).toMatch(/^\$2[ab]\$/);
    // Verify the hash matches the full key
    const isValid = await bcrypt.compare(fullKey, keyHash);
    expect(isValid).toBe(true);
  });

  it("generates unique keys on successive calls", async () => {
    const key1 = await generateApiKey();
    const key2 = await generateApiKey();
    expect(key1.fullKey).not.toBe(key2.fullKey);
    expect(key1.keyHash).not.toBe(key2.keyHash);
  });
});

describe("authenticateApiKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeRequest(headers: Record<string, string> = {}): Request {
    return new Request("https://app.example.com/api/returns", { headers });
  }

  it("returns UNAUTHORIZED when X-API-Key header is missing", async () => {
    const req = makeRequest();
    const result = await authenticateApiKey(req, "read_returns");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = await result.response.json();
      expect(body.error.code).toBe("UNAUTHORIZED");
      expect(body.error.message).toContain("Missing X-API-Key");
    }
  });

  it("returns UNAUTHORIZED when no candidates match the prefix", async () => {
    mockPrisma.apiKey.findMany.mockResolvedValue([]);

    const req = makeRequest({ "X-API-Key": "rpm_abcd1234deadbeef0000000000000000000000000000" });
    const result = await authenticateApiKey(req, "read_returns");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = await result.response.json();
      expect(body.error.code).toBe("UNAUTHORIZED");
      expect(body.error.message).toContain("Invalid API key");
    }
  });

  it("returns UNAUTHORIZED when bcrypt compare fails for all candidates", async () => {
    // The candidate has a hash that won't match the provided key
    const wrongHash = await bcrypt.hash("rpm_somethingelse12345678901234567890", 4);
    mockPrisma.apiKey.findMany.mockResolvedValue([
      {
        id: "key-1",
        keyPrefix: "rpm_abcd",
        keyHash: wrongHash,
        permissions: JSON.stringify(["read_returns"]),
        shopId: "shop-1",
        shop: { shopDomain: "test.myshopify.com" },
      },
    ]);

    const req = makeRequest({ "X-API-Key": "rpm_abcd1234deadbeef0000000000000000000000000000" });
    const result = await authenticateApiKey(req, "read_returns");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = await result.response.json();
      expect(body.error.code).toBe("UNAUTHORIZED");
    }
  });

  it("returns FORBIDDEN when key is valid but lacks required permission", async () => {
    const fullKey = "rpm_abcd1234deadbeef0000000000000000000000000000";
    const keyHash = await bcrypt.hash(fullKey, 4);

    mockPrisma.apiKey.findMany.mockResolvedValue([
      {
        id: "key-1",
        keyPrefix: "rpm_abcd",
        keyHash,
        permissions: JSON.stringify(["read_returns"]),
        shopId: "shop-1",
        shop: { shopDomain: "test.myshopify.com" },
      },
    ]);

    const req = makeRequest({ "X-API-Key": fullKey });
    const result = await authenticateApiKey(req, "manage_webhooks");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      const body = await result.response.json();
      expect(body.error.code).toBe("FORBIDDEN");
      expect(body.error.message).toContain("manage_webhooks");
    }
  });

  it("returns ok with shop context when key and permission are valid", async () => {
    const fullKey = "rpm_abcd1234deadbeef0000000000000000000000000000";
    const keyHash = await bcrypt.hash(fullKey, 4);

    mockPrisma.apiKey.findMany.mockResolvedValue([
      {
        id: "key-42",
        keyPrefix: "rpm_abcd",
        keyHash,
        permissions: JSON.stringify(["read_returns", "write_returns"]),
        shopId: "shop-99",
        shop: { shopDomain: "awesome-store.myshopify.com" },
      },
    ]);

    const req = makeRequest({ "X-API-Key": fullKey });
    const result = await authenticateApiKey(req, "read_returns");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.shopId).toBe("shop-99");
      expect(result.shopDomain).toBe("awesome-store.myshopify.com");
      expect(result.keyId).toBe("key-42");
    }
  });

  it("fires lastUsedAt update on successful auth", async () => {
    const fullKey = "rpm_abcd1234deadbeef0000000000000000000000000000";
    const keyHash = await bcrypt.hash(fullKey, 4);

    mockPrisma.apiKey.findMany.mockResolvedValue([
      {
        id: "key-1",
        keyPrefix: "rpm_abcd",
        keyHash,
        permissions: JSON.stringify(["read_returns"]),
        shopId: "shop-1",
        shop: { shopDomain: "test.myshopify.com" },
      },
    ]);

    const req = makeRequest({ "X-API-Key": fullKey });
    await authenticateApiKey(req, "read_returns");

    expect(mockPrisma.apiKey.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "key-1" },
        data: expect.objectContaining({ lastUsedAt: expect.any(Date) }),
      }),
    );
  });

  it("handles malformed permissions JSON gracefully (no crash, returns FORBIDDEN)", async () => {
    const fullKey = "rpm_abcd1234deadbeef0000000000000000000000000000";
    const keyHash = await bcrypt.hash(fullKey, 4);

    mockPrisma.apiKey.findMany.mockResolvedValue([
      {
        id: "key-1",
        keyPrefix: "rpm_abcd",
        keyHash,
        permissions: "not-valid-json",
        shopId: "shop-1",
        shop: { shopDomain: "test.myshopify.com" },
      },
    ]);

    const req = makeRequest({ "X-API-Key": fullKey });
    const result = await authenticateApiKey(req, "read_returns");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
    }
  });
});

describe("ALL_PERMISSIONS", () => {
  it("contains the expected permissions", () => {
    expect(ALL_PERMISSIONS).toContain("read_returns");
    expect(ALL_PERMISSIONS).toContain("write_returns");
    expect(ALL_PERMISSIONS).toContain("read_settings");
    expect(ALL_PERMISSIONS).toContain("manage_webhooks");
  });

  it("has exactly 4 permissions", () => {
    expect(ALL_PERMISSIONS).toHaveLength(4);
  });
});
