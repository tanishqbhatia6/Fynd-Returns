import { describe, it, expect, vi } from "vitest";
import jwt from "jsonwebtoken";
import {
  createPortalToken,
  verifyPortalToken,
  hashLookupValue,
  cleanupExpiredSessions,
} from "../portal-auth.server";

describe("createPortalToken", () => {
  it("creates a valid JWT string with three dot-separated parts", () => {
    const token = createPortalToken({ userId: "u1", role: "customer" });
    expect(typeof token).toBe("string");
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
  });

  it("embeds the provided payload fields in the token", () => {
    const token = createPortalToken({ orderId: "order-42" });
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(decoded.orderId).toBe("order-42");
  });

  it("includes iat and exp claims", () => {
    const token = createPortalToken({ foo: "bar" });
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(decoded.iat).toEqual(expect.any(Number));
    expect(decoded.exp).toEqual(expect.any(Number));
    // exp should be ~1 hour after iat
    expect((decoded.exp as number) - (decoded.iat as number)).toBe(3600);
  });
});

describe("verifyPortalToken", () => {
  it("returns payload for a valid token", () => {
    const token = createPortalToken({ userId: "u2" });
    const payload = verifyPortalToken(token);
    expect(payload).not.toBeNull();
    expect(payload!.userId).toBe("u2");
  });

  it("returns null for an expired token", () => {
    // Create a token that expired 10 seconds ago
    const secret = process.env.PORTAL_JWT_SECRET!;
    const expiredToken = jwt.sign(
      { userId: "expired-user", iat: Math.floor(Date.now() / 1000) - 7200 },
      secret,
      { expiresIn: "1s" },
    );
    // Small delay not needed: iat is 2h ago, expiresIn 1s => already expired
    const result = verifyPortalToken(expiredToken);
    expect(result).toBeNull();
  });

  it("returns null for a tampered token", () => {
    const token = createPortalToken({ userId: "u3" });
    // Flip a character in the signature portion
    const parts = token.split(".");
    const sig = parts[2];
    const tampered = parts[0] + "." + parts[1] + "." + (sig[0] === "A" ? "B" : "A") + sig.slice(1);
    expect(verifyPortalToken(tampered)).toBeNull();
  });

  it("returns null for a completely malformed string", () => {
    expect(verifyPortalToken("not-a-jwt")).toBeNull();
    expect(verifyPortalToken("")).toBeNull();
    expect(verifyPortalToken("abc.def")).toBeNull();
  });

  it("returns null for a token signed with a different secret", () => {
    const wrongToken = jwt.sign(
      { userId: "wrong" },
      "totally-different-secret-that-is-long-enough",
      {
        expiresIn: "1h",
      },
    );
    expect(verifyPortalToken(wrongToken)).toBeNull();
  });
});

describe("hashLookupValue", () => {
  it("normalizes input to lowercase and trimmed before hashing", () => {
    const hash1 = hashLookupValue("  Hello@Example.COM  ");
    const hash2 = hashLookupValue("hello@example.com");
    expect(hash1).toBe(hash2);
  });

  it("produces consistent hash for the same input", () => {
    const a = hashLookupValue("test@test.com");
    const b = hashLookupValue("test@test.com");
    expect(a).toBe(b);
  });

  it("produces different hash for different input", () => {
    const a = hashLookupValue("alice@example.com");
    const b = hashLookupValue("bob@example.com");
    expect(a).not.toBe(b);
  });

  it("returns a 64-character hex string (sha256)", () => {
    const hash = hashLookupValue("anything");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("cleanupExpiredSessions", () => {
  it("deletes sessions older than maxAgeDays and returns count", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 3 });
    const prisma = { lookupSession: { deleteMany } };

    const count = await cleanupExpiredSessions(prisma, 7);
    expect(count).toBe(3);
    expect(deleteMany).toHaveBeenCalledOnce();

    const callArg = deleteMany.mock.calls[0][0];
    expect(callArg.where.expiresAt).toBeDefined();
    expect(callArg.where.expiresAt.lt).toBeInstanceOf(Date);
  });

  it("uses default maxAgeDays of 7 when not specified", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = { lookupSession: { deleteMany } };

    const now = Date.now();
    await cleanupExpiredSessions(prisma);

    const cutoff = deleteMany.mock.calls[0][0].where.expiresAt.lt as Date;
    // Cutoff should be approximately 7 days ago
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(Math.abs(now - sevenDaysMs - cutoff.getTime())).toBeLessThan(1000);
  });
});
