import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Tests for createFyndClientOrError and createFyndClient dispatching.
 *
 * These functions orchestrate: baseUrl lookup, credential parsing,
 * OAuth token fetch, and client construction. We mock fetchFyndPlatformToken
 * so we don't hit the network, and exercise every early-return branch.
 */

const { fetchTokenMock } = vi.hoisted(() => ({
  fetchTokenMock: vi.fn(),
}));

// Intercept the token fetch inside fynd.server by mocking its undici-ish path.
// Simpler: replace the function after import via spyOn-style rewrite. But
// since fetchFyndPlatformToken is an exported function used *within* the same
// module, we need to stub `fetch` globally. Here we stub global fetch to
// return a token or reject.
const origFetch = globalThis.fetch;

beforeEach(() => {
  fetchTokenMock.mockReset();
});

describe("createFyndClientOrError", () => {
  beforeEach(async () => {
    // Stub global fetch — fetchFyndPlatformToken uses it directly
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      const u = typeof url === "string" ? url : url.toString();
      if (u.includes("/service/panel/authentication/v1.0/company") || u.includes("/token")) {
        return new Response(JSON.stringify({ access_token: "tok-123", token_type: "Bearer", expires_in: 3600 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("errors when requireStorefront=true", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError(
      { fyndApplicationId: "app-1", fyndCredentials: "{}" } as never,
      { requireStorefront: true },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not used/);
  });

  it("errors when fyndApplicationId missing", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError({ fyndCredentials: "{}" } as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Application ID is missing/);
  });

  it("errors when credentials are empty", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError({
      fyndApplicationId: "app-1",
      fyndCredentials: "",
    } as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not set/);
  });

  it("errors when credentials are unparseable JSON", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError({
      fyndApplicationId: "app-1",
      fyndCredentials: "{not json",
    } as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/invalid/i);
  });

  it("errors on requirePlatform when platform creds missing", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError({
      fyndApplicationId: "app-1",
      fyndCredentials: JSON.stringify({ storefront: { applicationToken: "tok" } }),
    } as never, { requirePlatform: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Platform API/);
  });

  it("errors on requirePlatform when fyndCompanyId missing", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError({
      fyndApplicationId: "app-1",
      fyndCredentials: JSON.stringify({ platform: { clientId: "cid", clientSecret: "sec" } }),
    } as never, { requirePlatform: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Company ID is missing/);
  });

  it("succeeds with platform creds + companyId + valid OAuth response", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError({
      fyndApplicationId: "app-1",
      fyndCompanyId: "co-1",
      fyndEnvironment: "uat",
      fyndCredentials: JSON.stringify({ platform: { clientId: "cid", clientSecret: "sec" } }),
    } as never, { requirePlatform: true });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Platform client has getShipments method
      expect("getShipments" in res.client).toBe(true);
    }
  });

  it("errors when token fetch fails (network-level)", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const { createFyndClientOrError } = await import("../fynd.server");
    // Use a unique companyId so fynd.server's internal tokenCache doesn't hit
    const res = await createFyndClientOrError({
      fyndApplicationId: "app-NET",
      fyndCompanyId: "co-network-fail-uniq",
      fyndEnvironment: "uat",
      fyndCredentials: JSON.stringify({ platform: { clientId: "cid-net", clientSecret: "sec-net" } }),
    } as never, { requirePlatform: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Fynd login failed/);
  });

  it("succeeds via requirePlatform=false branch when only platform creds available", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError({
      fyndApplicationId: "app-1",
      fyndCompanyId: "co-1",
      fyndEnvironment: "uat",
      fyndCredentials: JSON.stringify({ platform: { clientId: "cid", clientSecret: "sec" } }),
    } as never, { requirePlatform: false });
    expect(res.ok).toBe(true);
  });

  it("errors when requirePlatform=false and platform creds are missing", async () => {
    const { createFyndClientOrError } = await import("../fynd.server");
    const res = await createFyndClientOrError({
      fyndApplicationId: "app-1",
      fyndCredentials: JSON.stringify({ storefront: { applicationToken: "tok" } }),
    } as never, { requirePlatform: false });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Platform credentials are required/);
  });
});

describe("createFyndClient (legacy wrapper)", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () => {
      return new Response(JSON.stringify({ access_token: "tok-123", expires_in: 3600 }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("returns the client on success", async () => {
    const { createFyndClient } = await import("../fynd.server");
    const client = await createFyndClient({
      fyndApplicationId: "app-1",
      fyndCompanyId: "co-1",
      fyndEnvironment: "uat",
      fyndCredentials: JSON.stringify({ platform: { clientId: "cid", clientSecret: "sec" } }),
    } as never);
    expect(client).toBeTruthy();
  });

  it("returns null on failure (missing application id)", async () => {
    const { createFyndClient } = await import("../fynd.server");
    const client = await createFyndClient({ fyndCredentials: "{}" } as never);
    expect(client).toBe(null);
  });
});

