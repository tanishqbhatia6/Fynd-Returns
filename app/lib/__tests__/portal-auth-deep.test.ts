/**
 * Deep tests for portal-auth.server.ts: round-trip JWT issuance/verification,
 * tampered/expired tokens, CSRF shop-binding, lookup-value hashing, and the
 * cleanup helper. Portal session security depends on these helpers — every
 * branch matters because a regression silently weakens cross-shop isolation.
 */
import { describe, it, expect, vi } from "vitest";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import {
  createPortalToken,
  verifyPortalToken,
  createPortalCsrfToken,
  verifyPortalCsrfToken,
  hashLookupValue,
  cleanupExpiredSessions,
} from "../portal-auth.server";

// In test mode SECRET resolves at module-eval time. We mirror the same logic
// here so jwt.sign/verify in tests stays in lockstep with the module.
const SECRET =
  process.env.PORTAL_JWT_SECRET && process.env.PORTAL_JWT_SECRET.length >= 32
    ? process.env.PORTAL_JWT_SECRET
    : "dev-secret-change-in-production-unsafe";

describe("createPortalToken / verifyPortalToken round-trip", () => {
  it("round-trips a payload with arbitrary keys", () => {
    const token = createPortalToken({
      userId: "user_123",
      shopDomain: "store.myshopify.com",
      role: "customer",
    });
    const decoded = verifyPortalToken(token);
    expect(decoded).not.toBeNull();
    expect(decoded!.userId).toBe("user_123");
    expect(decoded!.shopDomain).toBe("store.myshopify.com");
    expect(decoded!.role).toBe("customer");
  });

  it("preserves nested objects/arrays in payload", () => {
    const payload = {
      orderIds: ["o1", "o2", "o3"],
      meta: { lang: "en", flags: { promo: true } },
    };
    const token = createPortalToken(payload);
    const decoded = verifyPortalToken(token);
    expect(decoded!.orderIds).toEqual(["o1", "o2", "o3"]);
    expect((decoded!.meta as { lang: string }).lang).toBe("en");
  });

  it("overrides any caller-supplied iat with the current time", () => {
    const fakeOldIat = 1; // epoch
    const token = createPortalToken({ iat: fakeOldIat, foo: "bar" });
    const decoded = jwt.decode(token) as Record<string, unknown>;
    // The function spreads payload then re-sets iat to now.
    expect(decoded.iat).toEqual(expect.any(Number));
    expect((decoded.iat as number) > 1_000_000_000).toBe(true);
  });

  it("issues an exp roughly 1h (TOKEN_TTL) after iat", () => {
    const token = createPortalToken({ x: 1 });
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect((decoded.exp as number) - (decoded.iat as number)).toBe(3600);
  });
});

describe("verifyPortalToken — failure modes", () => {
  it("returns null for an expired token", () => {
    const expired = jwt.sign({ userId: "u", iat: Math.floor(Date.now() / 1000) - 7200 }, SECRET, {
      expiresIn: "1s",
    });
    expect(verifyPortalToken(expired)).toBeNull();
  });

  it("returns null when the signature is tampered", () => {
    const token = createPortalToken({ userId: "u" });
    const parts = token.split(".");
    const sig = parts[2];
    const tampered = `${parts[0]}.${parts[1]}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
    expect(verifyPortalToken(tampered)).toBeNull();
  });

  it("returns null when the payload is tampered (signature no longer matches)", () => {
    const token = createPortalToken({ userId: "alice" });
    const parts = token.split(".");
    // Decode payload, swap user, re-encode without re-signing.
    const payloadJson = Buffer.from(parts[1], "base64url").toString("utf8");
    const payload = JSON.parse(payloadJson);
    payload.userId = "mallory";
    const newPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const tampered = `${parts[0]}.${newPayload}.${parts[2]}`;
    expect(verifyPortalToken(tampered)).toBeNull();
  });

  it("returns null for a token signed with the wrong secret", () => {
    const foreign = jwt.sign(
      { userId: "wrong" },
      "totally-different-secret-but-also-long-enough-1234",
      { expiresIn: "1h" },
    );
    expect(verifyPortalToken(foreign)).toBeNull();
  });

  it("returns null for malformed/empty input", () => {
    expect(verifyPortalToken("")).toBeNull();
    expect(verifyPortalToken("not.a.jwt")).toBeNull();
    expect(verifyPortalToken("only-one-part")).toBeNull();
    expect(verifyPortalToken("two.parts")).toBeNull();
  });

  it("returns null for an alg=none token (does not honour unsigned tokens)", () => {
    // Construct an alg=none token by hand; jwt.verify must reject it.
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ userId: "evil" })).toString("base64url");
    const noneToken = `${header}.${payload}.`;
    expect(verifyPortalToken(noneToken)).toBeNull();
  });
});

describe("createPortalCsrfToken / verifyPortalCsrfToken round-trip", () => {
  it("creates a token that verifies for the bound shop", () => {
    const token = createPortalCsrfToken("acme.myshopify.com");
    expect(verifyPortalCsrfToken(token, "acme.myshopify.com")).toBe(true);
  });

  it("embeds csrf=true and shopDomain claims", () => {
    const token = createPortalCsrfToken("foo.myshopify.com");
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(decoded.csrf).toBe(true);
    expect(decoded.shopDomain).toBe("foo.myshopify.com");
    expect(decoded.exp).toEqual(expect.any(Number));
  });

  it("issues an exp roughly 30m (CSRF_TTL) after iat", () => {
    const token = createPortalCsrfToken("a.myshopify.com");
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect((decoded.exp as number) - (decoded.iat as number)).toBe(30 * 60);
  });
});

describe("verifyPortalCsrfToken — failure modes", () => {
  it("rejects a token bound to a different shop (cross-shop replay)", () => {
    const token = createPortalCsrfToken("victim.myshopify.com");
    expect(verifyPortalCsrfToken(token, "attacker.myshopify.com")).toBe(false);
  });

  it("rejects null/undefined/empty tokens", () => {
    expect(verifyPortalCsrfToken(null, "any.myshopify.com")).toBe(false);
    expect(verifyPortalCsrfToken(undefined, "any.myshopify.com")).toBe(false);
    expect(verifyPortalCsrfToken("", "any.myshopify.com")).toBe(false);
  });

  it("rejects a regular portal token (missing csrf=true claim)", () => {
    // A normal session token does not carry csrf:true, so even if it has the
    // shopDomain it must not be accepted as a CSRF token.
    const session = createPortalToken({ shopDomain: "shop.myshopify.com", userId: "u" });
    expect(verifyPortalCsrfToken(session, "shop.myshopify.com")).toBe(false);
  });

  it("rejects a token with csrf set to a non-true truthy value", () => {
    const tok = jwt.sign({ csrf: "yes", shopDomain: "shop.myshopify.com" }, SECRET, {
      expiresIn: "30m",
    });
    expect(verifyPortalCsrfToken(tok, "shop.myshopify.com")).toBe(false);
  });

  it("rejects an expired CSRF token", () => {
    const expired = jwt.sign(
      { csrf: true, shopDomain: "shop.myshopify.com", iat: Math.floor(Date.now() / 1000) - 7200 },
      SECRET,
      { expiresIn: "1s" },
    );
    expect(verifyPortalCsrfToken(expired, "shop.myshopify.com")).toBe(false);
  });

  it("rejects a CSRF token tampered after issue", () => {
    const token = createPortalCsrfToken("shop.myshopify.com");
    const parts = token.split(".");
    const tampered = `${parts[0]}.${parts[1]}.${parts[2].slice(0, -1)}${parts[2].slice(-1) === "A" ? "B" : "A"}`;
    expect(verifyPortalCsrfToken(tampered, "shop.myshopify.com")).toBe(false);
  });

  it("rejects a CSRF token signed with a foreign secret", () => {
    const foreign = jwt.sign(
      { csrf: true, shopDomain: "shop.myshopify.com" },
      "another-very-long-secret-not-ours-12345678",
      { expiresIn: "30m" },
    );
    expect(verifyPortalCsrfToken(foreign, "shop.myshopify.com")).toBe(false);
  });

  it("does case-sensitive comparison on shopDomain", () => {
    const token = createPortalCsrfToken("shop.myshopify.com");
    expect(verifyPortalCsrfToken(token, "Shop.myshopify.com")).toBe(false);
  });
});

describe("hashLookupValue", () => {
  it("normalises case and surrounding whitespace", () => {
    expect(hashLookupValue("  Hello@Example.COM  ")).toBe(hashLookupValue("hello@example.com"));
  });

  it("does not collapse internal whitespace (intentionally only trim)", () => {
    expect(hashLookupValue("foo bar")).not.toBe(hashLookupValue("foobar"));
  });

  it("returns a 64-char lowercase hex sha256 digest", () => {
    const h = hashLookupValue("anything");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches a manually-computed sha256 of the normalised value", () => {
    const expected = crypto.createHash("sha256").update("alice@example.com").digest("hex");
    expect(hashLookupValue("  ALICE@example.com ")).toBe(expected);
  });

  it("differentiates distinct inputs", () => {
    expect(hashLookupValue("a@b.com")).not.toBe(hashLookupValue("c@d.com"));
  });

  it("coerces non-string input via String() before hashing", () => {
    // Tests the `String(value)` guard — passing a number must not throw and
    // must agree with the string form.
    const numeric = hashLookupValue(12345 as unknown as string);
    const stringified = hashLookupValue("12345");
    expect(numeric).toBe(stringified);
  });
});

describe("cleanupExpiredSessions", () => {
  it("returns the deletion count from prisma", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 5 });
    const prisma = { lookupSession: { deleteMany } };
    expect(await cleanupExpiredSessions(prisma, 3)).toBe(5);
    expect(deleteMany).toHaveBeenCalledOnce();
  });

  it("uses a cutoff = now − maxAgeDays days", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = { lookupSession: { deleteMany } };
    const before = Date.now();
    await cleanupExpiredSessions(prisma, 14);
    const after = Date.now();

    const cutoff = (deleteMany.mock.calls[0][0] as { where: { expiresAt: { lt: Date } } }).where
      .expiresAt.lt;
    expect(cutoff).toBeInstanceOf(Date);
    const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
    expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - fourteenDaysMs - 1000);
    expect(cutoff.getTime()).toBeLessThanOrEqual(after - fourteenDaysMs + 1000);
  });

  it("defaults to 7 days when maxAgeDays is omitted", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = { lookupSession: { deleteMany } };
    const now = Date.now();
    await cleanupExpiredSessions(prisma);
    const cutoff = (deleteMany.mock.calls[0][0] as { where: { expiresAt: { lt: Date } } }).where
      .expiresAt.lt;
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(now - sevenDaysMs - cutoff.getTime())).toBeLessThan(1500);
  });

  it("propagates errors from prisma.deleteMany", async () => {
    const deleteMany = vi.fn().mockRejectedValue(new Error("db down"));
    const prisma = { lookupSession: { deleteMany } };
    await expect(cleanupExpiredSessions(prisma, 1)).rejects.toThrow("db down");
  });

  it("queries on expiresAt with a `lt` operator only", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = { lookupSession: { deleteMany } };
    await cleanupExpiredSessions(prisma, 1);
    const where = (deleteMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(Object.keys(where)).toEqual(["expiresAt"]);
    expect(Object.keys(where.expiresAt as Record<string, unknown>)).toEqual(["lt"]);
  });
});
