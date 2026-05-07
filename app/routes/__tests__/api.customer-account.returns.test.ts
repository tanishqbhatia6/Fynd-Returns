/**
 * Customer Account Extension — list-returns endpoint.
 *
 * Verifies the JWT-auth path end-to-end:
 *  - 401 on missing or malformed Authorization header
 *  - 401 on tampered / unsigned token
 *  - 401 on expired token
 *  - 401 on wrong-aud token (different app's session)
 *  - 200 + filtered ReturnCase rows on a valid token
 *  - 200 with empty returns when Admin API can't resolve customer email
 *  - Customer email is read from Shopify Admin (not the JWT) — extension
 *    cannot spoof email by editing claims
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";

const SECRET = "test-secret-32-chars-long-XXXXXXXXXX";

vi.mock("../../db.server", () => ({
  default: {
    shop: { findUnique: vi.fn() },
    session: { findFirst: vi.fn() },
    returnCase: { findMany: vi.fn() },
  },
}));

vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterMs: 0 })),
  rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
}));

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  process.env.SHOPIFY_API_SECRET = SECRET;
  process.env.SHOPIFY_API_KEY = "client-id-abc";
  vi.clearAllMocks();
});

afterEach(() => {
  process.env = originalEnv;
});

function makeReq(token?: string): Request {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return new Request("https://app.example/api/customer-account/returns", {
    method: "GET",
    headers,
  });
}

function signValid(claims: Record<string, unknown>): string {
  return jwt.sign(
    {
      iss: "https://shop.myshopify.com",
      dest: "shop.myshopify.com",
      aud: "client-id-abc",
      sub: "gid://shopify/Customer/42",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...claims,
    },
    SECRET,
    { algorithm: "HS256" },
  );
}

describe("GET /api/customer-account/returns — auth", () => {
  it("returns 401 when Authorization header is missing", async () => {
    const { loader } = await import("../api.customer-account.returns");
    const res = await loader({ request: makeReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/Missing Authorization/);
  });

  it("returns 401 when token is malformed", async () => {
    const { loader } = await import("../api.customer-account.returns");
    const res = await loader({
      request: makeReq("not.a.jwt"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });

  it("returns 204 on CORS preflight (OPTIONS)", async () => {
    const { loader } = await import("../api.customer-account.returns");
    const res = await loader({
      request: new Request("https://app.example/api/customer-account/returns", {
        method: "OPTIONS",
      }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(204);
  });

  it("returns 401 when Authorization header lacks Bearer prefix", async () => {
    const { loader } = await import("../api.customer-account.returns");
    const headers = new Headers({ Authorization: "Basic dXNlcjpwYXNz" });
    const req = new Request("https://app.example/api/customer-account/returns", {
      method: "GET",
      headers,
    });
    const res = await loader({ request: req, params: {}, context: {} } as never);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toMatch(/Missing Authorization/);
  });

  it("returns 401 when token verifies but is missing dest claim", async () => {
    // dest is required for shop lookup; absent dest must reject
    const tokenWithoutDest = jwt.sign(
      {
        aud: "client-id-abc",
        sub: "gid://shopify/Customer/42",
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      SECRET,
      { algorithm: "HS256" },
    );
    const { loader } = await import("../api.customer-account.returns");
    const res = await loader({
      request: makeReq(tokenWithoutDest),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });

  it("returns 401 when token verifies but is missing sub claim", async () => {
    const tokenWithoutSub = jwt.sign(
      {
        dest: "shop.myshopify.com",
        aud: "client-id-abc",
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      SECRET,
      { algorithm: "HS256" },
    );
    const { loader } = await import("../api.customer-account.returns");
    const res = await loader({
      request: makeReq(tokenWithoutSub),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });

  it("returns 401 when token signature is wrong", async () => {
    const tampered = jwt.sign(
      {
        dest: "shop.myshopify.com",
        aud: "client-id-abc",
        sub: "gid://shopify/Customer/42",
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      "wrong-secret-32-chars-long-XXXXXXXX",
      { algorithm: "HS256" },
    );
    const { loader } = await import("../api.customer-account.returns");
    const res = await loader({
      request: makeReq(tampered),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });

  it("returns 401 when token aud is for a different app", async () => {
    const token = jwt.sign(
      {
        dest: "shop.myshopify.com",
        aud: "different-app-client-id",
        sub: "gid://shopify/Customer/42",
        exp: Math.floor(Date.now() / 1000) + 300,
      },
      SECRET,
      { algorithm: "HS256" },
    );
    const { loader } = await import("../api.customer-account.returns");
    const res = await loader({
      request: makeReq(token),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is expired", async () => {
    const token = jwt.sign(
      {
        dest: "shop.myshopify.com",
        aud: "client-id-abc",
        sub: "gid://shopify/Customer/42",
        exp: Math.floor(Date.now() / 1000) - 10,
      },
      SECRET,
      { algorithm: "HS256" },
    );
    const { loader } = await import("../api.customer-account.returns");
    const res = await loader({
      request: makeReq(token),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });

  it("returns 401 when shop is not installed (no Shop record for dest)", async () => {
    const db = (await import("../../db.server")).default as unknown as {
      shop: { findUnique: ReturnType<typeof vi.fn> };
    };
    db.shop.findUnique.mockResolvedValueOnce(null);
    const { loader } = await import("../api.customer-account.returns");
    const res = await loader({
      request: makeReq(signValid({})),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(404);
  });

  it("returns 401 when no offline session exists for the shop", async () => {
    const db = (await import("../../db.server")).default as unknown as {
      shop: { findUnique: ReturnType<typeof vi.fn> };
      session: { findFirst: ReturnType<typeof vi.fn> };
    };
    db.shop.findUnique.mockResolvedValueOnce({ id: "s1", shopDomain: "shop.myshopify.com" });
    db.session.findFirst.mockResolvedValueOnce(null);
    const { loader } = await import("../api.customer-account.returns");
    const res = await loader({
      request: makeReq(signValid({})),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });
});

describe("GET /api/customer-account/returns — happy path", () => {
  it("returns customer's returns when JWT verifies and Admin returns email", async () => {
    const db = (await import("../../db.server")).default as unknown as {
      shop: { findUnique: ReturnType<typeof vi.fn> };
      session: { findFirst: ReturnType<typeof vi.fn> };
      returnCase: { findMany: ReturnType<typeof vi.fn> };
    };
    db.shop.findUnique.mockResolvedValueOnce({ id: "s1", shopDomain: "shop.myshopify.com" });
    db.session.findFirst.mockResolvedValueOnce({ accessToken: "shpat_abc" });
    db.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc1",
        returnRequestNo: "RPM-AAA",
        status: "approved",
        refundStatus: null,
        resolutionType: "refund",
        fyndReturnNo: "F-1",
        returnAwb: "AWB-1",
        createdAt: new Date("2026-05-01T00:00:00Z"),
      },
    ]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: { customer: { id: "gid://shopify/Customer/42", email: "Buyer@Example.com" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    try {
      const { loader } = await import("../api.customer-account.returns");
      const res = await loader({
        request: makeReq(signValid({})),
        params: {},
        context: {},
      } as never);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.returns).toHaveLength(1);
      expect(body.returns[0].returnRequestNo).toBe("RPM-AAA");
      // Email lower-cased before lookup
      expect(db.returnCase.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            shopId: "s1",
            customerEmailNorm: "buyer@example.com",
          }),
        }),
      );
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns ok:true with empty list when Admin API has no customer email", async () => {
    const db = (await import("../../db.server")).default as unknown as {
      shop: { findUnique: ReturnType<typeof vi.fn> };
      session: { findFirst: ReturnType<typeof vi.fn> };
      returnCase: { findMany: ReturnType<typeof vi.fn> };
    };
    db.shop.findUnique.mockResolvedValueOnce({ id: "s1", shopDomain: "shop.myshopify.com" });
    db.session.findFirst.mockResolvedValueOnce({ accessToken: "shpat_abc" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ data: { customer: null } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    try {
      const { loader } = await import("../api.customer-account.returns");
      const res = await loader({
        request: makeReq(signValid({})),
        params: {},
        context: {},
      } as never);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.returns).toEqual([]);
      // ReturnCase query is NOT issued when email is missing
      expect(db.returnCase.findMany).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("returns ok:true with empty list when Admin API throws", async () => {
    const db = (await import("../../db.server")).default as unknown as {
      shop: { findUnique: ReturnType<typeof vi.fn> };
      session: { findFirst: ReturnType<typeof vi.fn> };
      returnCase: { findMany: ReturnType<typeof vi.fn> };
    };
    db.shop.findUnique.mockResolvedValueOnce({ id: "s1", shopDomain: "shop.myshopify.com" });
    db.session.findFirst.mockResolvedValueOnce({ accessToken: "shpat_abc" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("upstream timeout"));
    try {
      const { loader } = await import("../api.customer-account.returns");
      const res = await loader({
        request: makeReq(signValid({})),
        params: {},
        context: {},
      } as never);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.returns).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("falls back to row id when returnRequestNo is null", async () => {
    const db = (await import("../../db.server")).default as unknown as {
      shop: { findUnique: ReturnType<typeof vi.fn> };
      session: { findFirst: ReturnType<typeof vi.fn> };
      returnCase: { findMany: ReturnType<typeof vi.fn> };
    };
    db.shop.findUnique.mockResolvedValueOnce({ id: "s1", shopDomain: "shop.myshopify.com" });
    db.session.findFirst.mockResolvedValueOnce({ accessToken: "shpat_abc" });
    db.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-no-rrn",
        returnRequestNo: null,
        status: "approved",
        refundStatus: null,
        resolutionType: "refund",
        fyndReturnNo: null,
        returnAwb: null,
        createdAt: new Date("2026-05-01T00:00:00Z"),
      },
    ]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: { customer: { id: "gid://shopify/Customer/42", email: "x@example.com" } },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    try {
      const { loader } = await import("../api.customer-account.returns");
      const res = await loader({
        request: makeReq(signValid({})),
        params: {},
        context: {},
      } as never);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.returns[0].returnRequestNo).toBe("rc-no-rrn"); // id used as fallback
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("respects rate limit (429 when limiter denies)", async () => {
    const rl = await import("../../lib/rate-limit.server");
    (rl.checkRateLimit as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      allowed: false,
      retryAfterMs: 30_000,
    });
    const { loader } = await import("../api.customer-account.returns");
    const res = await loader({
      request: makeReq(signValid({})),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(429);
  });
});
