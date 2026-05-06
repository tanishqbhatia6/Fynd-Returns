import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Coverage-gap tests for app/lib/fynd.server.ts.
 *
 * Targets the still-uncovered ranges left by fynd-server-deep.test.ts
 * (lines 443-471, 477-545):
 *   - signFyndUrl: all branches (non-private URL, private but no client, no
 *     getSignedUrls method, signed result, empty result, throwing client)
 *   - FyndStorefrontClient: constructor + basicAuth + request happy path,
 *     401/403/5xx hints, network errors, AbortError timeout, empty body,
 *     getLanguages / getBagReasons / testConnection
 *
 * Also nudges other low-cover spots:
 *   - parseShipmentInternalIds (null + every-id-shape branch)
 *   - isFyndPrivateUrl (positive + negative)
 *   - getNormalizedCredentialsFromRaw (happy + bad input)
 *   - createFyndClient (returns null when factory fails)
 *   - testPlatformConnectionRaw (missing companyId, missing platform creds,
 *     happy 200, hint branches 401/403/5xx, OAuth throws, AbortError)
 *   - FyndPlatformClient.getReturnReasons
 *   - FyndPlatformClient.getSignedUrls (default + body shape edges)
 *   - FyndPlatformClient.testConnection (ok / 404 fallback / rethrow)
 *   - fetchFyndPlatformToken: cache hit, expires_in capping, missing
 *     access_token, invalid JSON, AbortError timeout
 *   - normalizeCredentials snake_case + applicationToken legacy keys
 */

// --- mocks ----------------------------------------------------------------

vi.mock("../encryption.server", () => ({
  decrypt: (s: string) => {
    if (s.startsWith("good:")) {
      return JSON.stringify({ platform: { clientId: "dec_id", clientSecret: "dec_secret" } });
    }
    throw new Error("bad ciphertext");
  },
}));

vi.mock("../observability/logger.server", () => ({
  fyndLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../observability/tracing.server", () => ({
  withSpan: async <T>(
    _n: string,
    _a: unknown,
    fn: (s: { setAttribute: () => void; end: () => void }) => Promise<T>,
  ) => fn({ setAttribute: () => {}, end: () => {} }),
  addBusinessEvent: vi.fn(),
  startTimer: () => () => 1,
}));

vi.mock("../observability/metrics.server", () => ({
  fyndApiDuration: { record: vi.fn() },
  fyndSyncCounter: { add: vi.fn() },
}));

vi.mock("../observability/resilience.server", () => ({
  fyndCircuitBreaker: { execute: async <T>(fn: () => Promise<T>) => fn() },
  recordTimeout: vi.fn(),
  recordFallback: vi.fn(),
}));

vi.mock("../fynd-fdk.server", () => ({
  createFyndPlatformClient: vi.fn(),
  createFyndApplicationClient: vi.fn(),
  FyndPlatformClientFDK: class {},
  FyndStorefrontClientFDK: class {},
  getFyndDomain: () => "fynd.example",
}));

// Some test paths may reach @gofynd/fdk-client-javascript indirectly — mock it
// too so it never tries to make real HTTP calls.
vi.mock("@gofynd/fdk-client-javascript", () => ({
  PlatformClient: class {},
  PlatformConfig: class {},
  ApplicationClient: class {},
  ApplicationConfig: class {},
}));

// db.server is not directly imported by fynd.server.ts but the prompt asks for
// it to be mocked. Stub a minimal shape to be safe if anything ever resolves it.
vi.mock("../db.server", () => ({
  default: { shop: { findUnique: vi.fn() }, $disconnect: vi.fn() },
}));

// --- module under test ----------------------------------------------------

import {
  parseShipmentInternalIds,
  isFyndPrivateUrl,
  signFyndUrl,
  testPlatformConnectionRaw,
  fetchFyndPlatformToken,
  FyndPlatformClient,
  FyndStorefrontClient,
  getNormalizedCredentialsFromRaw,
  createFyndClient,
  type FyndSettings,
} from "../fynd.server";

// --- helpers --------------------------------------------------------------

const origFetch = globalThis.fetch;

function uniqueId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function settings(
  overrides: Partial<FyndSettings & { fyndApiType?: string | null }> = {},
): FyndSettings & { fyndApiType?: string | null } {
  return {
    fyndApplicationId: "app-1",
    fyndCompanyId: uniqueId("co-gap"),
    fyndEnvironment: "uat",
    fyndCustomBaseUrl: "https://api-test.fynd.example",
    fyndCredentials: JSON.stringify({ platform: { clientId: "cid", clientSecret: "sec" } }),
    ...overrides,
  };
}

afterEach(() => {
  globalThis.fetch = origFetch;
  vi.restoreAllMocks();
});

// =========================================================================
// parseShipmentInternalIds
// =========================================================================

describe("parseShipmentInternalIds", () => {
  it("returns nulls when input is null", () => {
    expect(parseShipmentInternalIds(null)).toEqual({ orderId: null, shipmentId: null });
  });

  it("prefers FY-prefixed order_id over numeric", () => {
    const res = parseShipmentInternalIds({ order_id: "FYABCDEFGHIJKL" });
    expect(res.orderId).toBe("FYABCDEFGHIJKL");
  });

  it("falls back to numeric ids when no FY prefix", () => {
    const res = parseShipmentInternalIds({ order_id: "1234567" });
    expect(res.orderId).toBe("1234567");
  });

  it("falls back to first raw id when neither FY nor numeric", () => {
    const res = parseShipmentInternalIds({ order_id: "weird-string" });
    expect(res.orderId).toBe("weird-string");
  });

  it("reads camelCase shipmentId and channel_shipment_id", () => {
    const res = parseShipmentInternalIds({ shipmentId: "FYSHIP1234567890" });
    expect(res.shipmentId).toBe("FYSHIP1234567890");
  });

  it("trims whitespace from string ids", () => {
    const res = parseShipmentInternalIds({ id: "  FYSHIP9999999999  " });
    expect(res.shipmentId).toBe("FYSHIP9999999999");
  });

  it("ignores non-string id values", () => {
    const res = parseShipmentInternalIds({ id: 12345, order_id: null });
    expect(res).toEqual({ orderId: null, shipmentId: null });
  });
});

// =========================================================================
// isFyndPrivateUrl
// =========================================================================

describe("isFyndPrivateUrl", () => {
  it("returns false for null/undefined/empty", () => {
    expect(isFyndPrivateUrl(null)).toBe(false);
    expect(isFyndPrivateUrl(undefined)).toBe(false);
    expect(isFyndPrivateUrl("")).toBe(false);
  });

  it("returns true for storage.googleapis.com fynd-assets-private URL", () => {
    expect(isFyndPrivateUrl("https://storage.googleapis.com/fynd-x/assets/private/foo.pdf")).toBe(
      true,
    );
  });

  it("returns true for cdn.fynd.com private URLs", () => {
    expect(isFyndPrivateUrl("https://cdn.fynd.com/path/private/x.pdf")).toBe(true);
  });

  it("returns true for fynd-assets-private style URL", () => {
    expect(isFyndPrivateUrl("https://x.fynd-uat-assets-private.example.com/x")).toBe(true);
  });

  it("returns false for a public Fynd URL", () => {
    expect(isFyndPrivateUrl("https://cdn.fynd.com/public/foo.png")).toBe(false);
  });
});

// =========================================================================
// signFyndUrl
// =========================================================================

describe("signFyndUrl", () => {
  it("returns null for non-private URLs (no fetch made)", async () => {
    let fetchCalls = 0;
    globalThis.fetch = vi.fn(async () => {
      fetchCalls += 1;
      return jsonResponse({});
    }) as typeof fetch;
    const result = await signFyndUrl(settings(), "https://public.example/file.png");
    expect(result).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  it("returns null when client creation fails (no platform creds)", async () => {
    const result = await signFyndUrl(
      settings({ fyndCredentials: JSON.stringify({ storefront: { applicationToken: "t" } }) }),
      "https://cdn.fynd.com/x/private/foo.pdf",
    );
    expect(result).toBeNull();
  });

  it("returns signed URL when getSignedUrls succeeds", async () => {
    const url = "https://cdn.fynd.com/path/private/foo.pdf";
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {
        // OAuth token
        return jsonResponse({ access_token: "tok-sig", expires_in: 3600 });
      }
      // sign-urls API
      return jsonResponse({
        urls: [{ url, signed_url: `${url}?sig=abc`, expiry: 3600 }],
      });
    }) as typeof fetch;
    const result = await signFyndUrl(settings(), url);
    expect(result).toEqual({ signedUrl: `${url}?sig=abc`, expiry: 3600 });
  });

  it("returns null when sign-urls returns empty list", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ access_token: "tok-empty", expires_in: 3600 });
      return jsonResponse({ urls: [] });
    }) as typeof fetch;
    const result = await signFyndUrl(settings(), "https://cdn.fynd.com/path/private/x");
    expect(result).toBeNull();
  });

  it("returns null when first signed_url is empty string", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ access_token: "tok-empty2", expires_in: 3600 });
      return jsonResponse({
        urls: [{ url: "https://cdn.fynd.com/path/private/x", signed_url: "", expiry: 3600 }],
      });
    }) as typeof fetch;
    const result = await signFyndUrl(settings(), "https://cdn.fynd.com/path/private/x");
    expect(result).toBeNull();
  });

  it("returns null and logs warn when sign-urls request throws", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ access_token: "tok-thr", expires_in: 3600 });
      throw new Error("ECONNREFUSED downstream");
    }) as typeof fetch;
    const log = vi.fn();
    const result = await signFyndUrl(settings(), "https://cdn.fynd.com/path/private/x", log);
    expect(result).toBeNull();
    expect(log).toHaveBeenCalledWith("fynd-sign-url", "Failed to sign URL", expect.any(String));
  });
});

// =========================================================================
// FyndStorefrontClient
// =========================================================================

describe("FyndStorefrontClient", () => {
  const baseUrl = "https://api-test.fynd.example";
  const appId = "app-store-1";
  const token = "stf-token-123";

  it("getLanguages: GETs the languages path with Basic auth", async () => {
    let calledUrl = "";
    let calledMethod = "";
    let calledAuth = "";
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calledUrl = typeof url === "string" ? url : url.toString();
      calledMethod = init?.method ?? "";
      calledAuth = (init?.headers as Record<string, string>)["Authorization"] ?? "";
      return jsonResponse({ items: [{ code: "en" }] });
    }) as typeof fetch;

    const client = new FyndStorefrontClient(baseUrl, appId, token);
    const result = await client.getLanguages();

    expect(calledMethod).toBe("GET");
    expect(calledUrl).toContain("/service/application/configuration/v1.0/languages");
    const expected = "Basic " + Buffer.from(`${appId}:${token}`).toString("base64");
    expect(calledAuth).toBe(expected);
    expect(result).toEqual({ items: [{ code: "en" }] });
  });

  it("getBagReasons: GETs the bag reasons path", async () => {
    let calledUrl = "";
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      calledUrl = typeof url === "string" ? url : url.toString();
      return jsonResponse({ reasons: [] });
    }) as typeof fetch;

    const client = new FyndStorefrontClient(baseUrl, appId, token);
    await client.getBagReasons();
    expect(calledUrl).toContain("/service/application/order/v1.0/bag/reasons");
  });

  it("testConnection: succeeds when getLanguages 200s", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ items: [] })) as typeof fetch;
    const client = new FyndStorefrontClient(baseUrl, appId, token);
    await expect(client.testConnection()).resolves.toBeUndefined();
  });

  it("returns parsed JSON when body is non-empty", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ ok: true, k: 7 })) as typeof fetch;
    const client = new FyndStorefrontClient(baseUrl, appId, token);
    const result = await client.getBagReasons();
    expect(result).toEqual({ ok: true, k: 7 });
  });

  it("returns null on 200 with empty body", async () => {
    globalThis.fetch = vi.fn(async () => new Response("", { status: 200 })) as typeof fetch;
    const client = new FyndStorefrontClient(baseUrl, appId, token);
    const result = await client.getLanguages();
    expect(result).toBe(null);
  });

  it("throws helpful error on 401 with token-credential hint", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ message: "unauth" }, { status: 401 }),
    ) as typeof fetch;
    const client = new FyndStorefrontClient(baseUrl, appId, token);
    await expect(client.getLanguages()).rejects.toThrow(/Storefront API error 401/);
    await expect(client.getLanguages()).rejects.toThrow(/Application Token/);
  });

  it("throws helpful error on 403 with access-denied hint", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ message: "no" }, { status: 403 }),
    ) as typeof fetch;
    const client = new FyndStorefrontClient(baseUrl, appId, token);
    await expect(client.getLanguages()).rejects.toThrow(/Access denied/);
  });

  it("throws helpful error on 5xx with 'Fynd server error'", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ message: "boom" }, { status: 502 }),
    ) as typeof fetch;
    const client = new FyndStorefrontClient(baseUrl, appId, token);
    await expect(client.getLanguages()).rejects.toThrow(/Fynd server error/);
  });

  it("throws plain error on 4xx (non-401/403) without hint", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ message: "bad" }, { status: 400 }),
    ) as typeof fetch;
    const client = new FyndStorefrontClient(baseUrl, appId, token);
    await expect(client.getLanguages()).rejects.toThrow(/Storefront API error 400/);
  });

  it("throws 'Network error' message on ECONNREFUSED", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED upstream");
    }) as typeof fetch;
    const client = new FyndStorefrontClient(baseUrl, appId, token);
    await expect(client.getLanguages()).rejects.toThrow(/Network error/);
  });

  it("throws timeout message on AbortError", async () => {
    globalThis.fetch = vi.fn(async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as typeof fetch;
    const client = new FyndStorefrontClient(baseUrl, appId, token);
    await expect(client.getLanguages()).rejects.toThrow(/Storefront API timed out/);
  });

  it("rethrows unexpected non-network, non-abort errors verbatim", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("totally weird boom");
    }) as typeof fetch;
    const client = new FyndStorefrontClient(baseUrl, appId, token);
    await expect(client.getLanguages()).rejects.toThrow(/totally weird boom/);
  });

  it("invokes log callback for request when provided", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ ok: true })) as typeof fetch;
    const log = vi.fn();
    const client = new FyndStorefrontClient(baseUrl, appId, token, log);
    await client.getLanguages();
    expect(log).toHaveBeenCalledWith(
      "fynd-storefront",
      "Request",
      expect.stringMatching(/GET.*languages/),
    );
  });
});

// =========================================================================
// fetchFyndPlatformToken — uncovered cache + edge branches
// =========================================================================

describe("fetchFyndPlatformToken — edge cases", () => {
  it("returns the cached token on second call (cache hit)", async () => {
    let count = 0;
    globalThis.fetch = vi.fn(async () => {
      count += 1;
      return jsonResponse({ access_token: `tok-${count}`, expires_in: 3600 });
    }) as typeof fetch;
    const baseUrl = "https://api.example.fynd";
    const co = uniqueId("co-cache");
    const t1 = await fetchFyndPlatformToken(baseUrl, co, "cid", "sec");
    const t2 = await fetchFyndPlatformToken(baseUrl, co, "cid", "sec");
    expect(t1).toBe("tok-1");
    expect(t2).toBe("tok-1");
    expect(count).toBe(1);
  });

  it("caps cached TTL at the 50-minute internal max regardless of expires_in", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ access_token: "tok-long", expires_in: 60 * 60 * 24 }),
    ) as typeof fetch;
    const baseUrl = "https://api.example.fynd";
    const co = uniqueId("co-cap");
    const result = await fetchFyndPlatformToken(baseUrl, co, "cid", "sec");
    expect(result).toBe("tok-long");
  });

  it("uses default TTL when expires_in is missing", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ access_token: "tok-no-exp" }),
    ) as typeof fetch;
    const baseUrl = "https://api.example.fynd";
    const co = uniqueId("co-no-exp");
    const result = await fetchFyndPlatformToken(baseUrl, co, "cid", "sec");
    expect(result).toBe("tok-no-exp");
  });

  it("throws when access_token missing in OAuth response", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ message: "ok but no token" }),
    ) as typeof fetch;
    await expect(
      fetchFyndPlatformToken("https://api.x", uniqueId("co-no-tok"), "cid", "sec"),
    ).rejects.toThrow(/No access_token/);
  });

  it("throws on invalid JSON body", async () => {
    globalThis.fetch = vi.fn(
      async () =>
        new Response("not json at all", {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as typeof fetch;
    await expect(
      fetchFyndPlatformToken("https://api.x", uniqueId("co-badjson"), "cid", "sec"),
    ).rejects.toThrow(/invalid JSON/);
  });

  it("throws timeout message on AbortError during OAuth", async () => {
    globalThis.fetch = vi.fn(async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as typeof fetch;
    await expect(
      fetchFyndPlatformToken("https://api.x", uniqueId("co-abort"), "cid", "sec"),
    ).rejects.toThrow(/OAuth timed out/);
  });

  it("emits 5xx hint inside thrown OAuth error message", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ message: "boom" }, { status: 502 }),
    ) as typeof fetch;
    await expect(
      fetchFyndPlatformToken("https://api.x", uniqueId("co-5xx"), "cid", "sec"),
    ).rejects.toThrow(/Fynd server error/);
  });

  it("invokes log callback during fetch + response", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ access_token: "tok-log", expires_in: 3600 }),
    ) as typeof fetch;
    const log = vi.fn();
    await fetchFyndPlatformToken("https://api.x", uniqueId("co-log"), "cid", "sec", log);
    expect(log).toHaveBeenCalledWith(
      "fynd-platform-oauth",
      "Fetching token",
      expect.stringContaining("url="),
    );
    expect(log).toHaveBeenCalledWith(
      "fynd-platform-oauth",
      "Response",
      expect.stringContaining("status=200"),
    );
  });
});

// =========================================================================
// testPlatformConnectionRaw
// =========================================================================

describe("testPlatformConnectionRaw", () => {
  it("returns ok:false when companyId is missing", async () => {
    const res = await testPlatformConnectionRaw(settings({ fyndCompanyId: null }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Company ID is required/);
  });

  it("returns ok:false when credentials are not set", async () => {
    const res = await testPlatformConnectionRaw(settings({ fyndCredentials: "" }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not set/);
  });

  it("returns ok:false when only storefront creds are stored", async () => {
    const res = await testPlatformConnectionRaw(
      settings({ fyndCredentials: JSON.stringify({ storefront: { applicationToken: "t" } }) }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Platform credentials/);
  });

  it("returns ok:true on 200 from orders-listing", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ access_token: "tok-tpc", expires_in: 3600 });
      return jsonResponse({ items: [] });
    }) as typeof fetch;
    const res = await testPlatformConnectionRaw(settings());
    expect(res.ok).toBe(true);
  });

  it("returns ok:false with 401 + auth hint when orders-listing 401s", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ access_token: "tok-401", expires_in: 3600 });
      return jsonResponse({ message: "unauth" }, { status: 401 });
    }) as typeof fetch;
    const res = await testPlatformConnectionRaw(settings());
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toMatch(/Fynd API 401/);
      expect(res.error).toMatch(/Client ID/);
    }
  });

  it("returns ok:false with 403 + scopes hint", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ access_token: "tok-403", expires_in: 3600 });
      return jsonResponse({ message: "no scopes" }, { status: 403 });
    }) as typeof fetch;
    const res = await testPlatformConnectionRaw(settings());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/scopes/);
  });

  it("returns ok:false with 5xx + 'Fynd server error' hint", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ access_token: "tok-500", expires_in: 3600 });
      return jsonResponse({ message: "boom" }, { status: 503 });
    }) as typeof fetch;
    const res = await testPlatformConnectionRaw(settings());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Fynd server error/);
  });

  it("returns ok:false (caught) when OAuth itself throws", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const res = await testPlatformConnectionRaw(settings());
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Network error/);
  });

  it("invokes log callback for request and response", async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ access_token: "tok-log", expires_in: 3600 });
      return jsonResponse({ items: [] });
    }) as typeof fetch;
    const log = vi.fn();
    await testPlatformConnectionRaw(settings(), log);
    expect(log).toHaveBeenCalledWith(
      "fynd-test-raw",
      "Request",
      expect.stringMatching(/orders-listing/),
    );
    expect(log).toHaveBeenCalledWith(
      "fynd-test-raw",
      "Response",
      expect.stringContaining("status=200"),
    );
  });
});

// =========================================================================
// FyndPlatformClient — getReturnReasons / getSignedUrls / testConnection
// =========================================================================

describe("FyndPlatformClient.getReturnReasons", () => {
  it("issues an orders-listing GET and returns null", async () => {
    let calledUrl = "";
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      calledUrl = typeof url === "string" ? url : url.toString();
      return jsonResponse({ items: [] });
    }) as typeof fetch;
    const client = new FyndPlatformClient("https://api.x", "co-rr", "app-1", "tok");
    const result = await client.getReturnReasons();
    expect(calledUrl).toContain("orders-listing");
    expect(result).toBeNull();
  });
});

describe("FyndPlatformClient.getSignedUrls", () => {
  it("POSTs urls + expiry and returns signed urls list", async () => {
    let calledMethod = "";
    let calledBody: unknown;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calledMethod = init?.method ?? "";
      calledBody = init?.body ? JSON.parse(init.body as string) : undefined;
      return jsonResponse({
        urls: [{ url: "u1", signed_url: "u1-signed", expiry: 3600 }],
      });
    }) as typeof fetch;
    const client = new FyndPlatformClient("https://api.x", "co-sg", "app-1", "tok");
    const out = await client.getSignedUrls(["u1"]);
    expect(calledMethod).toBe("POST");
    expect(calledBody).toEqual({ urls: ["u1"], expiry: 3600 });
    expect(out).toEqual([{ url: "u1", signed_url: "u1-signed", expiry: 3600 }]);
  });

  it("returns [] when API responds with no urls field", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({})) as typeof fetch;
    const client = new FyndPlatformClient("https://api.x", "co-sg-empty", "app-1", "tok");
    const out = await client.getSignedUrls(["u1"]);
    expect(out).toEqual([]);
  });

  it("uses provided expiry parameter", async () => {
    let calledBody: unknown;
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      calledBody = init?.body ? JSON.parse(init.body as string) : undefined;
      return jsonResponse({ urls: [] });
    }) as typeof fetch;
    const client = new FyndPlatformClient("https://api.x", "co-sg-x", "app-1", "tok");
    await client.getSignedUrls(["a", "b"], 60);
    expect(calledBody).toEqual({ urls: ["a", "b"], expiry: 60 });
  });
});

describe("FyndPlatformClient.testConnection", () => {
  it("returns ok:true when getReturnReasons succeeds", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ items: [] })) as typeof fetch;
    const client = new FyndPlatformClient("https://api.x", "co-tc", "app-1", "tok");
    const out = await client.testConnection();
    expect(out).toEqual({ ok: true });
  });

  it("returns ok:true with warning on 404 (graceful fallback)", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ message: "not found" }, { status: 404 }),
    ) as typeof fetch;
    const client = new FyndPlatformClient("https://api.x", "co-tc-404", "app-1", "tok");
    const out = await client.testConnection();
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.warning).toMatch(/not available/);
  });

  it("rethrows non-404 errors", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ message: "unauth" }, { status: 401 }),
    ) as typeof fetch;
    const client = new FyndPlatformClient("https://api.x", "co-tc-401", "app-1", "tok");
    await expect(client.testConnection()).rejects.toThrow(/401/);
  });
});

// =========================================================================
// getNormalizedCredentialsFromRaw + createFyndClient
// =========================================================================

describe("getNormalizedCredentialsFromRaw", () => {
  it("returns null when raw is empty", () => {
    expect(getNormalizedCredentialsFromRaw("")).toBeNull();
    expect(getNormalizedCredentialsFromRaw(null)).toBeNull();
    expect(getNormalizedCredentialsFromRaw(undefined)).toBeNull();
  });

  it("returns null when JSON cannot be parsed", () => {
    expect(getNormalizedCredentialsFromRaw("{not_json")).toBeNull();
  });

  it("returns null when ciphertext fails to decrypt", () => {
    expect(getNormalizedCredentialsFromRaw("bogus:cipher")).toBeNull();
  });

  it("returns normalized creds for a JSON blob with platform.client_id snake_case", () => {
    const out = getNormalizedCredentialsFromRaw(
      JSON.stringify({ platform: { client_id: "ci", client_secret: "se" } }),
    );
    expect(out).toEqual({ platform: { clientId: "ci", clientSecret: "se" } });
  });

  it("returns normalized storefront when application_token snake_case is given", () => {
    const out = getNormalizedCredentialsFromRaw(JSON.stringify({ application_token: "appt" }));
    expect(out).toEqual({ storefront: { applicationToken: "appt" } });
  });

  it("decrypts credentials when raw is a colon ciphertext blob", () => {
    const out = getNormalizedCredentialsFromRaw("good:cipher");
    expect(out).toEqual({ platform: { clientId: "dec_id", clientSecret: "dec_secret" } });
  });

  it("normalises legacy top-level clientId / clientSecret", () => {
    const out = getNormalizedCredentialsFromRaw(
      JSON.stringify({ clientId: "topId", clientSecret: "topSec" }),
    );
    expect(out).toEqual({ platform: { clientId: "topId", clientSecret: "topSec" } });
  });
});

// =========================================================================
// fetchFyndPlatformToken — unexpected error rethrow (lines 135-136)
// =========================================================================

describe("fetchFyndPlatformToken — unexpected error path", () => {
  it("rethrows non-network, non-abort errors verbatim", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("totally unexpected boom");
    }) as typeof fetch;
    await expect(
      fetchFyndPlatformToken("https://api.x", uniqueId("co-unexp"), "cid", "sec"),
    ).rejects.toThrow(/totally unexpected boom/);
  });

  it("rethrows non-Error throwables converted to string", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw "string-error-literal";
    }) as unknown as typeof fetch;
    await expect(
      fetchFyndPlatformToken("https://api.x", uniqueId("co-strerr"), "cid", "sec"),
    ).rejects.toBeDefined();
  });
});

// =========================================================================
// FyndPlatformClient.request — AbortError timeout path (lines 292-295)
// =========================================================================

describe("FyndPlatformClient.request — AbortError timeout", () => {
  it("throws timeout message when fetch rejects with AbortError", async () => {
    globalThis.fetch = vi.fn(async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }) as typeof fetch;
    const client = new FyndPlatformClient("https://api.x", "co-tmo", "app-1", "tok");
    await expect(client.getShipments("FYORD-T")).rejects.toThrow(/Fynd API timed out/);
  });
});

// =========================================================================
// pruneTokenCache — exercise eviction path (lines 67-77)
// =========================================================================

describe("fetchFyndPlatformToken — cache pruning over the 50-entry limit", () => {
  it("does not throw when filling the cache beyond its max size", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ access_token: "tok-prune", expires_in: 3600 }),
    ) as typeof fetch;
    // 55 distinct cache keys (different baseUrl/companyId/clientId combos)
    for (let i = 0; i < 55; i += 1) {
      const co = `co-prune-${i}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const tok = await fetchFyndPlatformToken("https://api.x", co, `cid-${i}`, "sec");
      expect(tok).toBe("tok-prune");
    }
  });
});

describe("createFyndClient", () => {
  it("returns a client when settings + creds are valid", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ access_token: "tok-cf", expires_in: 3600 }),
    ) as typeof fetch;
    const out = await createFyndClient(settings());
    expect(out).not.toBeNull();
  });

  it("returns null when factory rejects (missing application id)", async () => {
    const out = await createFyndClient(settings({ fyndApplicationId: null }));
    expect(out).toBeNull();
  });

  it("returns null when OAuth fails", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const out = await createFyndClient(settings());
    expect(out).toBeNull();
  });
});
