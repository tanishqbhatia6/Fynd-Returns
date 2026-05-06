import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Extra coverage for createFyndClientOrError.
 *
 * Complements fynd-client-factory.test.ts by drilling into:
 *  - Missing applicationId / companyId / client credential edge cases
 *  - The "FDK fallback" (raw-OAuth) path used for return ops
 *  - Cached OAuth token reuse (no second fetch)
 *  - requirePlatform=false branch acceptance
 *
 * We stub `globalThis.fetch` rather than the FDK module because
 * createFyndClientOrError calls fetchFyndPlatformToken directly via fetch.
 */

const origFetch = globalThis.fetch;

function tokenResponse(
  body: Record<string, unknown> = { access_token: "tok-extra", expires_in: 3600 },
  status = 200,
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function makeFetchStub(impl?: (url: string) => Response | Promise<Response>) {
  return vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === "string" ? url : url.toString();
    if (impl) return impl(u);
    return tokenResponse();
  }) as typeof fetch;
}

describe("createFyndClientOrError extra — missing applicationId", () => {
  beforeEach(() => {
    globalThis.fetch = makeFetchStub();
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("rejects when fyndApplicationId is undefined", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError({
      fyndCompanyId: "co-x",
      fyndCredentials: JSON.stringify({ platform: { clientId: "cid", clientSecret: "sec" } }),
    } as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Application ID is missing/);
  });

  it("rejects when fyndApplicationId is empty string", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError({
      fyndApplicationId: "",
      fyndCompanyId: "co-x",
      fyndCredentials: JSON.stringify({ platform: { clientId: "cid", clientSecret: "sec" } }),
    } as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Application ID is missing/);
  });

  it("rejects when fyndApplicationId is null", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError({
      fyndApplicationId: null,
      fyndCompanyId: "co-x",
      fyndCredentials: JSON.stringify({ platform: { clientId: "cid", clientSecret: "sec" } }),
    } as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Application ID is missing/);
  });

  it("missing applicationId is checked before credentials are parsed", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    // Garbage credentials would fail parse, but appId check fires first
    const res = await createFyndClientOrError({
      fyndApplicationId: undefined,
      fyndCredentials: "{this-is-broken",
    } as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Application ID is missing/);
  });
});

describe("createFyndClientOrError extra — missing companyId", () => {
  beforeEach(() => {
    globalThis.fetch = makeFetchStub();
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("rejects requirePlatform when companyId undefined and platform creds present", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError(
      {
        fyndApplicationId: "app-x",
        fyndCredentials: JSON.stringify({ platform: { clientId: "cid", clientSecret: "sec" } }),
      } as never,
      { requirePlatform: true },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Company ID is missing/);
  });

  it("rejects requirePlatform when companyId is empty string", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError(
      {
        fyndApplicationId: "app-x",
        fyndCompanyId: "",
        fyndCredentials: JSON.stringify({ platform: { clientId: "cid", clientSecret: "sec" } }),
      } as never,
      { requirePlatform: true },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Company ID is missing/);
  });

  it("requirePlatform=false with no companyId falls through to error (no platform-only success)", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError(
      {
        fyndApplicationId: "app-x",
        fyndCredentials: JSON.stringify({ platform: { clientId: "cid", clientSecret: "sec" } }),
        // companyId intentionally omitted
      } as never,
      { requirePlatform: false },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Platform credentials are required/);
  });
});

describe("createFyndClientOrError extra — missing client credentials", () => {
  beforeEach(() => {
    globalThis.fetch = makeFetchStub();
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("rejects when credentials JSON has empty object", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError(
      {
        fyndApplicationId: "app-x",
        fyndCompanyId: "co-x",
        fyndCredentials: "{}",
      } as never,
      { requirePlatform: true },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Platform API/);
  });

  it("rejects when only clientId is provided (no secret)", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError(
      {
        fyndApplicationId: "app-x",
        fyndCompanyId: "co-x",
        fyndCredentials: JSON.stringify({ platform: { clientId: "cid" } }),
      } as never,
      { requirePlatform: true },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Platform API/);
  });

  it("rejects when only clientSecret is provided (no id)", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError(
      {
        fyndApplicationId: "app-x",
        fyndCompanyId: "co-x",
        fyndCredentials: JSON.stringify({ platform: { clientSecret: "sec" } }),
      } as never,
      { requirePlatform: true },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Platform API/);
  });

  it("rejects when fyndCredentials is null", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError(
      {
        fyndApplicationId: "app-x",
        fyndCompanyId: "co-x",
        fyndCredentials: null,
      } as never,
      { requirePlatform: true },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not set/);
  });

  it("rejects when fyndCredentials is whitespace only", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError(
      {
        fyndApplicationId: "app-x",
        fyndCompanyId: "co-x",
        fyndCredentials: "   ",
      } as never,
      { requirePlatform: true },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not set/);
  });

  it("accepts snake_case client_id/client_secret in credentials JSON", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError(
      {
        fyndApplicationId: "app-snake",
        fyndCompanyId: "co-snake",
        fyndEnvironment: "uat",
        fyndCredentials: JSON.stringify({
          platform: { client_id: "cid-snake", client_secret: "sec-snake" },
        }),
      } as never,
      { requirePlatform: true },
    );
    expect(res.ok).toBe(true);
  });

  it("accepts top-level clientId/clientSecret legacy shape", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError(
      {
        fyndApplicationId: "app-legacy",
        fyndCompanyId: "co-legacy",
        fyndEnvironment: "uat",
        fyndCredentials: JSON.stringify({ clientId: "cid-legacy", clientSecret: "sec-legacy" }),
      } as never,
      { requirePlatform: true },
    );
    expect(res.ok).toBe(true);
  });
});

describe("createFyndClientOrError extra — FDK fallback (raw-OAuth) path", () => {
  beforeEach(() => {
    globalThis.fetch = makeFetchStub();
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("uses raw OAuth (not FDK) — token request hits /service/panel/authentication", async () => {
    const seen: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      seen.push(u);
      return tokenResponse();
    }) as typeof fetch;
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError(
      {
        fyndApplicationId: "app-fdk-fb",
        fyndCompanyId: "co-fdk-fb-uniq",
        fyndEnvironment: "uat",
        fyndCredentials: JSON.stringify({
          platform: { clientId: "cid-fdk", clientSecret: "sec-fdk" },
        }),
      } as never,
      { requirePlatform: true },
    );
    expect(res.ok).toBe(true);
    expect(seen.some((u) => u.includes("/service/panel/authentication/v1.0/company"))).toBe(true);
    // Confirms client is the raw FyndPlatformClient (has getSignedUrls), not FDK shape
    if (res.ok) expect("getSignedUrls" in res.client).toBe(true);
  });

  it("returns Fynd login failed error when OAuth returns 401", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("invalid_client", { status: 401 }),
    ) as typeof fetch;
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError(
      {
        fyndApplicationId: "app-fail-401",
        fyndCompanyId: "co-fail-401-uniq",
        fyndEnvironment: "uat",
        fyndCredentials: JSON.stringify({
          platform: { clientId: "cid-401", clientSecret: "sec-401" },
        }),
      } as never,
      { requirePlatform: true },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Fynd login failed/);
  });

  it("returns Fynd login failed error when OAuth body has no access_token", async () => {
    globalThis.fetch = vi.fn(async () => tokenResponse({ token_type: "Bearer" })) as typeof fetch;
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError(
      {
        fyndApplicationId: "app-no-tok",
        fyndCompanyId: "co-no-tok-uniq",
        fyndEnvironment: "uat",
        fyndCredentials: JSON.stringify({
          platform: { clientId: "cid-nt", clientSecret: "sec-nt" },
        }),
      } as never,
      { requirePlatform: true },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Fynd login failed/);
  });

  it("constructs client with companyId, applicationId and base URL from settings", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError(
      {
        fyndApplicationId: "app-shape",
        fyndCompanyId: "co-shape-uniq",
        fyndEnvironment: "prod",
        fyndCredentials: JSON.stringify({
          platform: { clientId: "cid-shape", clientSecret: "sec-shape" },
        }),
      } as never,
      { requirePlatform: true },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect("getShipments" in res.client).toBe(true);
      expect("updateShipmentStatus" in res.client).toBe(true);
    }
  });
});

describe("createFyndClientOrError extra — cached token reuse", () => {
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("second call with same baseUrl/companyId/clientId reuses cached token (single fetch)", async () => {
    const fetchSpy = vi.fn(async () =>
      tokenResponse({ access_token: "cached-tok", expires_in: 3600 }),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    const { createFyndClientOrError } = await import("../fynd.server");
    const settings = {
      fyndApplicationId: "app-cache",
      fyndCompanyId: "co-cache-key-A",
      fyndEnvironment: "uat",
      fyndCredentials: JSON.stringify({
        platform: { clientId: "cid-cache-A", clientSecret: "sec-cache" },
      }),
    } as never;

    const r1 = await createFyndClientOrError(settings, { requirePlatform: true });
    const r2 = await createFyndClientOrError(settings, { requirePlatform: true });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    // Only one OAuth network call — second call hit the in-process token cache
    expect((fetchSpy as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });

  it("different companyId -> separate cache entry, two fetches", async () => {
    const fetchSpy = vi.fn(async () =>
      tokenResponse({ access_token: "tok-x", expires_in: 3600 }),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    const { createFyndClientOrError } = await import("../fynd.server");
    await createFyndClientOrError(
      {
        fyndApplicationId: "app",
        fyndCompanyId: "co-cache-key-B1",
        fyndEnvironment: "uat",
        fyndCredentials: JSON.stringify({ platform: { clientId: "cid-B", clientSecret: "sec" } }),
      } as never,
      { requirePlatform: true },
    );
    await createFyndClientOrError(
      {
        fyndApplicationId: "app",
        fyndCompanyId: "co-cache-key-B2",
        fyndEnvironment: "uat",
        fyndCredentials: JSON.stringify({ platform: { clientId: "cid-B", clientSecret: "sec" } }),
      } as never,
      { requirePlatform: true },
    );
    expect((fetchSpy as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(2);
  });

  it("different clientId -> separate cache entry, two fetches", async () => {
    const fetchSpy = vi.fn(async () =>
      tokenResponse({ access_token: "tok-y", expires_in: 3600 }),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    const { createFyndClientOrError } = await import("../fynd.server");
    const baseSettings = {
      fyndApplicationId: "app",
      fyndCompanyId: "co-cache-clientid",
      fyndEnvironment: "uat",
    } as const;
    await createFyndClientOrError(
      {
        ...baseSettings,
        fyndCredentials: JSON.stringify({ platform: { clientId: "cid-CA", clientSecret: "sec" } }),
      } as never,
      { requirePlatform: true },
    );
    await createFyndClientOrError(
      {
        ...baseSettings,
        fyndCredentials: JSON.stringify({ platform: { clientId: "cid-CB", clientSecret: "sec" } }),
      } as never,
      { requirePlatform: true },
    );
    expect((fetchSpy as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(2);
  });

  it("cached token reuse also applies on requirePlatform=false branch", async () => {
    const fetchSpy = vi.fn(async () =>
      tokenResponse({ access_token: "tok-rp-false", expires_in: 3600 }),
    ) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    const { createFyndClientOrError } = await import("../fynd.server");
    const settings = {
      fyndApplicationId: "app-rp",
      fyndCompanyId: "co-cache-rp-false",
      fyndEnvironment: "uat",
      fyndCredentials: JSON.stringify({ platform: { clientId: "cid-rp", clientSecret: "sec" } }),
    } as never;
    const r1 = await createFyndClientOrError(settings, { requirePlatform: false });
    const r2 = await createFyndClientOrError(settings, { requirePlatform: false });
    expect(r1.ok && r2.ok).toBe(true);
    expect((fetchSpy as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(1);
  });
});

describe("createFyndClientOrError extra — requirePlatform=false acceptance", () => {
  beforeEach(() => {
    globalThis.fetch = makeFetchStub();
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("succeeds when platform creds + companyId provided and requirePlatform omitted defaults to true", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError({
      fyndApplicationId: "app-default",
      fyndCompanyId: "co-default-uniq",
      fyndEnvironment: "uat",
      fyndCredentials: JSON.stringify({ platform: { clientId: "cid-d", clientSecret: "sec-d" } }),
    } as never);
    expect(res.ok).toBe(true);
  });

  it("requirePlatform=false yields a Platform client (Storefront not used)", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError(
      {
        fyndApplicationId: "app-rpf",
        fyndCompanyId: "co-rpf-uniq",
        fyndEnvironment: "uat",
        fyndCredentials: JSON.stringify({
          platform: { clientId: "cid-rpf", clientSecret: "sec-rpf" },
        }),
      } as never,
      { requirePlatform: false },
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Platform client signature
      expect("getShipments" in res.client).toBe(true);
      // Storefront-only methods absent
      expect("getLanguages" in res.client).toBe(false);
    }
  });

  it("requirePlatform=false with only storefront creds returns 'Platform credentials are required' error", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError(
      {
        fyndApplicationId: "app-sf-only",
        fyndCompanyId: "co-sf-only",
        fyndCredentials: JSON.stringify({ storefront: { applicationToken: "appTok" } }),
      } as never,
      { requirePlatform: false },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Platform credentials are required/);
  });

  it("requirePlatform=false propagates OAuth failure as Fynd login failed", async () => {
    globalThis.fetch = vi.fn(
      async () => new Response("server down", { status: 500 }),
    ) as typeof fetch;
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError(
      {
        fyndApplicationId: "app-rpf-500",
        fyndCompanyId: "co-rpf-500-uniq",
        fyndEnvironment: "uat",
        fyndCredentials: JSON.stringify({
          platform: { clientId: "cid-500", clientSecret: "sec-500" },
        }),
      } as never,
      { requirePlatform: false },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Fynd login failed/);
  });
});
