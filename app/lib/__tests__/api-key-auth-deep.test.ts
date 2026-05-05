/**
 * Deep tests for api-key-auth.server.ts. Locks in:
 *   - generateApiKey output shape (prefix, length, hex charset, bcrypt-verifiable hash)
 *   - hashApiKey-equivalent determinism via bcrypt.compare round-trip
 *   - authenticateApiKey state machine: missing header / invalid format /
 *     no candidates / bcrypt mismatch on every candidate / multi-candidate
 *     match-the-second / permission gate (granted vs missing) / malformed
 *     permission JSON / lastUsedAt fire-and-forget / response shape
 *
 * The module imports prisma, observability logger/tracing/security helpers.
 * We mock prisma (the only side-effect we care about for behaviour) and let
 * the real observability code run — it is no-op safe in unit tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";

// Hoisted prisma mock — the module under test imports it as a default export.
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

// --- helpers ----------------------------------------------------------------

const FAST_BCRYPT_ROUNDS = 4; // keep test suite fast — equivalent semantics

function makeRequest(headers: Record<string, string> = {}): Request {
  return new Request("https://app.example.com/api/external/returns", { headers });
}

function buildCandidate(over: Partial<{
  id: string;
  keyPrefix: string;
  keyHash: string;
  permissions: string;
  shopId: string;
  shopDomain: string;
}> = {}) {
  return {
    id: over.id ?? "key-1",
    keyPrefix: over.keyPrefix ?? "rpm_abcd",
    keyHash: over.keyHash ?? "$2a$04$invalidhashplaceholder.................",
    permissions: over.permissions ?? JSON.stringify(["read_returns"]),
    shopId: over.shopId ?? "shop-1",
    shop: { shopDomain: over.shopDomain ?? "test.myshopify.com" },
    isActive: true,
    revokedAt: null,
    lastUsedAt: null,
  };
}

// --- generateApiKey ---------------------------------------------------------

describe("generateApiKey (deep)", () => {
  it("returns an object with fullKey, keyPrefix, keyHash properties", async () => {
    const out = await generateApiKey();
    expect(out).toEqual(
      expect.objectContaining({
        fullKey: expect.any(String),
        keyPrefix: expect.any(String),
        keyHash: expect.any(String),
      }),
    );
  });

  it("fullKey matches /^rpm_[0-9a-f]{40}$/ exactly", async () => {
    const { fullKey } = await generateApiKey();
    expect(fullKey).toMatch(/^rpm_[0-9a-f]{40}$/);
    expect(fullKey).toHaveLength(44);
  });

  it("keyPrefix is exactly the first 8 characters of fullKey", async () => {
    const { fullKey, keyPrefix } = await generateApiKey();
    expect(keyPrefix).toHaveLength(8);
    expect(fullKey.startsWith(keyPrefix)).toBe(true);
    // The prefix is "rpm_" followed by 4 hex chars.
    expect(keyPrefix).toMatch(/^rpm_[0-9a-f]{4}$/);
  });

  it("keyHash is a bcrypt hash that verifies against fullKey", async () => {
    const { fullKey, keyHash } = await generateApiKey();
    expect(keyHash).toMatch(/^\$2[aby]\$/);
    await expect(bcrypt.compare(fullKey, keyHash)).resolves.toBe(true);
  });

  it("keyHash does NOT verify against a different key (negative round-trip)", async () => {
    const { keyHash } = await generateApiKey();
    await expect(bcrypt.compare("rpm_not-the-real-key", keyHash)).resolves.toBe(false);
  });

  it("each call produces unique fullKey + keyHash (high entropy)", async () => {
    const a = await generateApiKey();
    const b = await generateApiKey();
    const c = await generateApiKey();
    expect(new Set([a.fullKey, b.fullKey, c.fullKey]).size).toBe(3);
    expect(new Set([a.keyHash, b.keyHash, c.keyHash]).size).toBe(3);
  });
});

// --- bcrypt.compare determinism ("hashApiKey" verification) -----------------

describe("bcrypt verification (hashApiKey-equivalent)", () => {
  it("a stable hash verifies the same input across many calls", async () => {
    const fullKey = "rpm_deterministic_test_input_0000000000000000";
    const hash = await bcrypt.hash(fullKey, FAST_BCRYPT_ROUNDS);
    for (let i = 0; i < 5; i++) {
      await expect(bcrypt.compare(fullKey, hash)).resolves.toBe(true);
    }
  });

  it("two hashes of the same input differ (salted) but both verify", async () => {
    const fullKey = "rpm_salt_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const h1 = await bcrypt.hash(fullKey, FAST_BCRYPT_ROUNDS);
    const h2 = await bcrypt.hash(fullKey, FAST_BCRYPT_ROUNDS);
    expect(h1).not.toBe(h2);
    await expect(bcrypt.compare(fullKey, h1)).resolves.toBe(true);
    await expect(bcrypt.compare(fullKey, h2)).resolves.toBe(true);
  });
});

// --- authenticateApiKey -----------------------------------------------------

describe("authenticateApiKey: missing header", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 UNAUTHORIZED when X-API-Key is absent", async () => {
    const req = makeRequest();
    const result = await authenticateApiKey(req, "read_returns");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
    const body = await result.response.json();
    expect(body).toEqual({
      error: { code: "UNAUTHORIZED", message: "Missing X-API-Key header" },
    });
  });

  it("does NOT query prisma when header is missing", async () => {
    const req = makeRequest();
    await authenticateApiKey(req, "read_returns");
    expect(mockPrisma.apiKey.findMany).not.toHaveBeenCalled();
  });

  it("treats empty-string X-API-Key as missing (header.get returns '')", async () => {
    // Note: Request normalises empty header values to '', and the source uses
    // a truthiness check, so empty string is treated as missing.
    const req = makeRequest({ "X-API-Key": "" });
    const result = await authenticateApiKey(req, "read_returns");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(401);
      const body = await result.response.json();
      expect(body.error.message).toContain("Missing X-API-Key");
    }
  });
});

describe("authenticateApiKey: prefix lookup", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queries prisma using the first 8 characters as the prefix", async () => {
    mockPrisma.apiKey.findMany.mockResolvedValue([]);
    const fullKey = "rpm_abcd" + "0".repeat(36);
    const req = makeRequest({ "X-API-Key": fullKey });
    await authenticateApiKey(req, "read_returns");

    expect(mockPrisma.apiKey.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          keyPrefix: "rpm_abcd",
          isActive: true,
          revokedAt: null,
        }),
        include: { shop: true },
      }),
    );
  });

  it("returns 401 with code UNAUTHORIZED when no candidates match the prefix", async () => {
    mockPrisma.apiKey.findMany.mockResolvedValue([]);
    const req = makeRequest({ "X-API-Key": "rpm_zzzz" + "f".repeat(36) });
    const result = await authenticateApiKey(req, "read_returns");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
    const body = await result.response.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toBe("Invalid API key");
  });

  it("uses prefix lookup even for short keys (substring is bounded by length)", async () => {
    mockPrisma.apiKey.findMany.mockResolvedValue([]);
    const req = makeRequest({ "X-API-Key": "abc" }); // shorter than 8
    const result = await authenticateApiKey(req, "read_returns");

    expect(mockPrisma.apiKey.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ keyPrefix: "abc" }),
      }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("authenticateApiKey: bcrypt mismatch", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 401 when the only candidate's hash does not match", async () => {
    const wrongHash = await bcrypt.hash("rpm_some_other_key_xxxxxxxxxxxxxxxxxxxxxxxx", FAST_BCRYPT_ROUNDS);
    mockPrisma.apiKey.findMany.mockResolvedValue([
      buildCandidate({ keyHash: wrongHash }),
    ]);

    const req = makeRequest({ "X-API-Key": "rpm_abcd" + "1".repeat(36) });
    const result = await authenticateApiKey(req, "read_returns");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
    const body = await result.response.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toBe("Invalid API key");
  });

  it("returns 401 when ALL candidates fail bcrypt compare", async () => {
    const wrongHash1 = await bcrypt.hash("rpm_other_one", FAST_BCRYPT_ROUNDS);
    const wrongHash2 = await bcrypt.hash("rpm_other_two", FAST_BCRYPT_ROUNDS);
    mockPrisma.apiKey.findMany.mockResolvedValue([
      buildCandidate({ id: "k1", keyHash: wrongHash1 }),
      buildCandidate({ id: "k2", keyHash: wrongHash2 }),
    ]);

    const req = makeRequest({ "X-API-Key": "rpm_abcd" + "9".repeat(36) });
    const result = await authenticateApiKey(req, "read_returns");

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(401);
    expect(mockPrisma.apiKey.update).not.toHaveBeenCalled();
  });

  it("matches the SECOND candidate when the first hash fails", async () => {
    const fullKey = "rpm_abcd" + "a".repeat(36);
    const wrongHash = await bcrypt.hash("rpm_unrelated_key", FAST_BCRYPT_ROUNDS);
    const rightHash = await bcrypt.hash(fullKey, FAST_BCRYPT_ROUNDS);

    mockPrisma.apiKey.findMany.mockResolvedValue([
      buildCandidate({ id: "wrong", keyHash: wrongHash }),
      buildCandidate({
        id: "right",
        keyHash: rightHash,
        permissions: JSON.stringify(["read_returns"]),
        shopId: "shop-correct",
        shopDomain: "right.myshopify.com",
      }),
    ]);

    const req = makeRequest({ "X-API-Key": fullKey });
    const result = await authenticateApiKey(req, "read_returns");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.keyId).toBe("right");
      expect(result.shopId).toBe("shop-correct");
    }
  });
});

describe("authenticateApiKey: permissions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 403 FORBIDDEN when granted permissions don't include the required one", async () => {
    const fullKey = "rpm_abcd" + "b".repeat(36);
    const keyHash = await bcrypt.hash(fullKey, FAST_BCRYPT_ROUNDS);
    mockPrisma.apiKey.findMany.mockResolvedValue([
      buildCandidate({
        keyHash,
        permissions: JSON.stringify(["read_returns"]),
      }),
    ]);

    const req = makeRequest({ "X-API-Key": fullKey });
    const result = await authenticateApiKey(req, "manage_webhooks");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
    const body = await result.response.json();
    expect(body.error.code).toBe("FORBIDDEN");
    expect(body.error.message).toContain("manage_webhooks");
  });

  it("does NOT update lastUsedAt on FORBIDDEN", async () => {
    const fullKey = "rpm_abcd" + "c".repeat(36);
    const keyHash = await bcrypt.hash(fullKey, FAST_BCRYPT_ROUNDS);
    mockPrisma.apiKey.findMany.mockResolvedValue([
      buildCandidate({ keyHash, permissions: JSON.stringify(["read_settings"]) }),
    ]);

    const req = makeRequest({ "X-API-Key": fullKey });
    await authenticateApiKey(req, "write_returns");
    expect(mockPrisma.apiKey.update).not.toHaveBeenCalled();
  });

  it("grants access for each permission in ALL_PERMISSIONS when the key holds it", async () => {
    for (const perm of ALL_PERMISSIONS as ApiKeyPermission[]) {
      const fullKey = "rpm_abcd" + "d".repeat(36);
      const keyHash = await bcrypt.hash(fullKey, FAST_BCRYPT_ROUNDS);
      mockPrisma.apiKey.findMany.mockResolvedValueOnce([
        buildCandidate({
          keyHash,
          permissions: JSON.stringify([perm]),
          id: `key-${perm}`,
        }),
      ]);

      const req = makeRequest({ "X-API-Key": fullKey });
      const result = await authenticateApiKey(req, perm);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.keyId).toBe(`key-${perm}`);
    }
  });

  it("treats malformed permissions JSON as no permissions granted (FORBIDDEN)", async () => {
    const fullKey = "rpm_abcd" + "e".repeat(36);
    const keyHash = await bcrypt.hash(fullKey, FAST_BCRYPT_ROUNDS);
    mockPrisma.apiKey.findMany.mockResolvedValue([
      buildCandidate({ keyHash, permissions: "{not-json" }),
    ]);

    const req = makeRequest({ "X-API-Key": fullKey });
    const result = await authenticateApiKey(req, "read_returns");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.response.status).toBe(403);
      const body = await result.response.json();
      expect(body.error.code).toBe("FORBIDDEN");
    }
  });

  it("treats permissions JSON that's an empty array as no permissions (FORBIDDEN)", async () => {
    const fullKey = "rpm_abcd" + "f".repeat(36);
    const keyHash = await bcrypt.hash(fullKey, FAST_BCRYPT_ROUNDS);
    mockPrisma.apiKey.findMany.mockResolvedValue([
      buildCandidate({ keyHash, permissions: JSON.stringify([]) }),
    ]);

    const req = makeRequest({ "X-API-Key": fullKey });
    const result = await authenticateApiKey(req, "read_returns");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(403);
  });
});

describe("authenticateApiKey: success path", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns ok with shopId, shopDomain, keyId on a valid + permitted key", async () => {
    const fullKey = "rpm_abcd" + "5".repeat(36);
    const keyHash = await bcrypt.hash(fullKey, FAST_BCRYPT_ROUNDS);
    mockPrisma.apiKey.findMany.mockResolvedValue([
      buildCandidate({
        id: "key-success",
        keyHash,
        permissions: JSON.stringify(["read_returns", "write_returns"]),
        shopId: "shop-success",
        shopDomain: "success.myshopify.com",
      }),
    ]);

    const req = makeRequest({ "X-API-Key": fullKey });
    const result = await authenticateApiKey(req, "write_returns");

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result).toEqual({
        ok: true,
        shopId: "shop-success",
        shopDomain: "success.myshopify.com",
        keyId: "key-success",
      });
    }
  });

  it("fires lastUsedAt update with a Date on success (fire-and-forget)", async () => {
    const fullKey = "rpm_abcd" + "6".repeat(36);
    const keyHash = await bcrypt.hash(fullKey, FAST_BCRYPT_ROUNDS);
    mockPrisma.apiKey.findMany.mockResolvedValue([
      buildCandidate({ id: "key-touch", keyHash }),
    ]);

    const req = makeRequest({ "X-API-Key": fullKey });
    await authenticateApiKey(req, "read_returns");

    expect(mockPrisma.apiKey.update).toHaveBeenCalledWith({
      where: { id: "key-touch" },
      data: { lastUsedAt: expect.any(Date) },
    });
  });

  it("does not throw when the lastUsedAt update rejects (catch swallows)", async () => {
    const fullKey = "rpm_abcd" + "7".repeat(36);
    const keyHash = await bcrypt.hash(fullKey, FAST_BCRYPT_ROUNDS);
    mockPrisma.apiKey.findMany.mockResolvedValue([
      buildCandidate({ keyHash }),
    ]);
    mockPrisma.apiKey.update.mockRejectedValueOnce(new Error("db down"));

    const req = makeRequest({ "X-API-Key": fullKey });
    const result = await authenticateApiKey(req, "read_returns");
    expect(result.ok).toBe(true);
  });
});

// --- ALL_PERMISSIONS sanity --------------------------------------------------

describe("ALL_PERMISSIONS", () => {
  it("is the canonical permission set", () => {
    expect(ALL_PERMISSIONS).toEqual([
      "read_returns",
      "write_returns",
      "read_settings",
      "manage_webhooks",
    ]);
  });
});
