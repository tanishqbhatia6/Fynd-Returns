import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Deep coverage tests for app/lib/fynd.server.ts.
 *
 * Targets the lower-coverage paths:
 *   - createFyndClientOrError: branching/error/happy paths
 *   - FyndPlatformClient.getShipments
 *   - FyndPlatformClient.updateShipmentStatus
 *   - FyndPlatformClient.searchShipmentsByExternalOrderId
 *
 * Mocks:
 *   - global fetch (used by fetchFyndPlatformToken + FyndPlatformClient.request)
 *   - observability layer + resilience (so circuit breaker / metrics no-op)
 *   - fdk-client modules through `../fynd-fdk.server`
 *   - encryption.server (decrypt)
 */

// --- mocks ----------------------------------------------------------------

vi.mock("../encryption.server", () => ({
  decrypt: (s: string) => {
    if (s.startsWith("enc:")) {
      return JSON.stringify({ platform: { clientId: "dec_id", clientSecret: "dec_secret" } });
    }
    throw new Error("bad ciphertext");
  },
}));

vi.mock("../observability/logger.server", () => ({
  fyndLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../observability/tracing.server", () => ({
  withSpan: async <T,>(_n: string, _a: unknown, fn: (s: { setAttribute: () => void; end: () => void }) => Promise<T>) =>
    fn({ setAttribute: () => {}, end: () => {} }),
  addBusinessEvent: vi.fn(),
  startTimer: () => () => 1,
}));

vi.mock("../observability/metrics.server", () => ({
  fyndApiDuration: { record: vi.fn() },
  fyndSyncCounter: { add: vi.fn() },
}));

vi.mock("../observability/resilience.server", () => ({
  fyndCircuitBreaker: { execute: async <T,>(fn: () => Promise<T>) => fn() },
  recordTimeout: vi.fn(),
  recordFallback: vi.fn(),
}));

// Mock the fdk-client passthroughs — fynd.server only imports the names; we
// don't need real implementations because createFyndClientOrError builds raw
// FyndPlatformClient instances in the platform branch.
vi.mock("../fynd-fdk.server", () => ({
  createFyndPlatformClient: vi.fn(),
  createFyndApplicationClient: vi.fn(),
  FyndPlatformClientFDK: class {},
  FyndStorefrontClientFDK: class {},
  getFyndDomain: () => "fynd.example",
}));

// --- module under test ----------------------------------------------------

import {
  createFyndClientOrError,
  FyndPlatformClient,
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

function settings(overrides: Partial<FyndSettings & { fyndApiType?: string | null }> = {}): FyndSettings & { fyndApiType?: string | null } {
  return {
    fyndApplicationId: "app-1",
    fyndCompanyId: uniqueId("co"),
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
// createFyndClientOrError
// =========================================================================

describe("createFyndClientOrError — early-error paths", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ access_token: "tok-default", expires_in: 3600 })
    ) as typeof fetch;
  });

  it("rejects when requireStorefront=true (storefront not supported)", async () => {
    const res = await createFyndClientOrError(settings(), { requireStorefront: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Storefront API is not used/);
  });

  it("rejects when fyndApplicationId is missing", async () => {
    const res = await createFyndClientOrError(settings({ fyndApplicationId: null }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Application ID is missing/);
  });

  it("rejects when credentials are empty string", async () => {
    const res = await createFyndClientOrError(settings({ fyndCredentials: "" }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/credentials are not set/);
  });

  it("rejects when credentials are whitespace only", async () => {
    const res = await createFyndClientOrError(settings({ fyndCredentials: "    " }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/not set/);
  });

  it("rejects when credentials are unparseable JSON", async () => {
    const res = await createFyndClientOrError(settings({ fyndCredentials: "{not_json" }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/invalid/i);
  });

  it("rejects when ciphertext (colon) decrypt fails", async () => {
    const res = await createFyndClientOrError(settings({ fyndCredentials: "bad:ciphertext" }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Could not read stored credentials/);
  });

  it("rejects on requirePlatform when only storefront creds are present", async () => {
    const res = await createFyndClientOrError(
      settings({
        fyndCredentials: JSON.stringify({ storefront: { applicationToken: "tok" } }),
      }),
      { requirePlatform: true },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Platform API/);
  });

  it("rejects on requirePlatform when companyId is missing", async () => {
    const res = await createFyndClientOrError(
      settings({ fyndCompanyId: null }),
      { requirePlatform: true },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Company ID is missing/);
  });

  it("rejects on requirePlatform=false when no platform creds available", async () => {
    const res = await createFyndClientOrError(
      settings({
        fyndCredentials: JSON.stringify({ storefront: { applicationToken: "tok" } }),
      }),
      { requirePlatform: false },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Platform credentials are required/);
  });
});

describe("createFyndClientOrError — happy paths", () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ access_token: "tok-happy", expires_in: 3600 })
    ) as typeof fetch;
  });

  it("returns a FyndPlatformClient when platform creds + companyId present", async () => {
    const res = await createFyndClientOrError(settings(), { requirePlatform: true });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Platform client exposes the methods we test below
      expect("getShipments" in res.client).toBe(true);
      expect("updateShipmentStatus" in res.client).toBe(true);
      expect("searchShipmentsByExternalOrderId" in res.client).toBe(true);
    }
  });

  it("succeeds via requirePlatform=false branch when platform creds + companyId present", async () => {
    const res = await createFyndClientOrError(settings(), { requirePlatform: false });
    expect(res.ok).toBe(true);
    if (res.ok) expect("getShipments" in res.client).toBe(true);
  });

  it("supports decrypted credentials (encrypted blob with ':')", async () => {
    const res = await createFyndClientOrError(
      settings({ fyndCredentials: "enc:abc123" }),
      { requirePlatform: true },
    );
    expect(res.ok).toBe(true);
  });

  it("invokes log callback when provided", async () => {
    const log = vi.fn();
    const res = await createFyndClientOrError(settings(), { requirePlatform: true, log });
    expect(res.ok).toBe(true);
    expect(log).toHaveBeenCalled();
  });
});

describe("createFyndClientOrError — OAuth failure path", () => {
  it("returns ok:false with 'Fynd login failed' on network error from token fetch", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED upstream Fynd");
    }) as typeof fetch;
    const res = await createFyndClientOrError(
      settings({ fyndCompanyId: uniqueId("co-fail") }),
      { requirePlatform: true },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Fynd login failed/);
  });

  it("returns ok:false on 401 token response (requirePlatform=true)", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ message: "unauth" }, { status: 401 })
    ) as typeof fetch;
    const res = await createFyndClientOrError(
      settings({ fyndCompanyId: uniqueId("co-401") }),
      { requirePlatform: true },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Fynd login failed.*401/);
  });

  it("returns ok:false on 401 token response (requirePlatform=false)", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ message: "unauth" }, { status: 401 })
    ) as typeof fetch;
    const res = await createFyndClientOrError(
      settings({ fyndCompanyId: uniqueId("co-401b") }),
      { requirePlatform: false },
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/Fynd login failed/);
  });
});

// =========================================================================
// FyndPlatformClient
// =========================================================================

describe("FyndPlatformClient.getShipments", () => {
  const baseUrl = "https://api-test.fynd.example";
  const companyId = "co-123";
  const appId = "app-1";
  const token = "tok-abc";

  it("calls order-details with correct order_id and returns shipments[]", async () => {
    let calledUrl = "";
    let calledMethod = "";
    let calledAuth = "";
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calledUrl = typeof url === "string" ? url : url.toString();
      calledMethod = init?.method ?? "";
      calledAuth = (init?.headers as Record<string, string>)["Authorization"] ?? "";
      return jsonResponse({ shipments: [{ id: "FYSHIP1234567890" }, { id: "FYSHIP9876543210" }] });
    }) as typeof fetch;

    const client = new FyndPlatformClient(baseUrl, companyId, appId, token);
    const result = await client.getShipments("FYORD0000000001");

    expect(calledMethod).toBe("GET");
    expect(calledAuth).toBe(`Bearer ${token}`);
    expect(calledUrl).toContain(`${baseUrl}/service/platform/order/v1.0/company/${companyId}/order-details`);
    expect(calledUrl).toContain("order_id=FYORD0000000001");
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);
  });

  it("URL-encodes the order_id parameter", async () => {
    let calledUrl = "";
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      calledUrl = typeof url === "string" ? url : url.toString();
      return jsonResponse({ shipments: [] });
    }) as typeof fetch;

    const client = new FyndPlatformClient(baseUrl, companyId, appId, token);
    await client.getShipments("FY ORDER+with/special&");
    expect(calledUrl).toContain("order_id=FY%20ORDER%2Bwith%2Fspecial%26");
  });

  it("falls back to body.order when shipments is missing", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ order: { id: "FYORD-XYZ", status: "placed" } })
    ) as typeof fetch;
    const client = new FyndPlatformClient(baseUrl, companyId, appId, token);
    const result = await client.getShipments("FYORD-XYZ");
    expect(result).toEqual({ id: "FYORD-XYZ", status: "placed" });
  });

  it("returns the raw response when neither shipments nor order present", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ unexpected: "shape" })
    ) as typeof fetch;
    const client = new FyndPlatformClient(baseUrl, companyId, appId, token);
    const result = await client.getShipments("FYORD-1");
    expect(result).toEqual({ unexpected: "shape" });
  });

  it("throws helpful error on 401 from platform request", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ message: "Unauthorized" }, { status: 401 })
    ) as typeof fetch;
    const client = new FyndPlatformClient(baseUrl, companyId, appId, token);
    await expect(client.getShipments("FYORD-401"))
      .rejects.toThrow(/401/);
    await expect(client.getShipments("FYORD-401"))
      .rejects.toThrow(/Invalid or expired credentials/);
  });

  it("throws helpful error on 403 with required scopes hint", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ message: "Forbidden" }, { status: 403 })
    ) as typeof fetch;
    const client = new FyndPlatformClient(baseUrl, companyId, appId, token);
    await expect(client.getShipments("FYORD-403"))
      .rejects.toThrow(/403/);
    await expect(client.getShipments("FYORD-403"))
      .rejects.toThrow(/scopes/);
  });

  it("throws helpful error on 5xx with 'Fynd server error'", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ message: "boom" }, { status: 503 })
    ) as typeof fetch;
    const client = new FyndPlatformClient(baseUrl, companyId, appId, token);
    await expect(client.getShipments("FYORD-503"))
      .rejects.toThrow(/Fynd server error/);
  });

  it("throws network-error message when fetch rejects with ECONNREFUSED", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const client = new FyndPlatformClient(baseUrl, companyId, appId, token);
    await expect(client.getShipments("FYORD-NET"))
      .rejects.toThrow(/Network error/);
  });

  it("rethrows unexpected (non-network, non-abort) errors verbatim", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("totally unexpected boom");
    }) as typeof fetch;
    const client = new FyndPlatformClient(baseUrl, companyId, appId, token);
    await expect(client.getShipments("FYORD-X")).rejects.toThrow(/totally unexpected boom/);
  });

  it("returns null when response body is empty (200, no content)", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("", { status: 200, headers: { "Content-Type": "application/json" } })
    ) as typeof fetch;
    const client = new FyndPlatformClient(baseUrl, companyId, appId, token);
    // request() returns null which then flows through getShipments fallback chain
    const result = await client.getShipments("FYORD-EMPTY");
    expect(result).toBe(null);
  });
});

describe("FyndPlatformClient.updateShipmentStatus", () => {
  const baseUrl = "https://api-test.fynd.example";
  const companyId = "co-456";
  const appId = "app-1";
  const token = "tok-upd";

  it("PUTs to status-internal with the supplied JSON payload", async () => {
    let calledUrl = "";
    let calledMethod = "";
    let calledBody: unknown;
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calledUrl = typeof url === "string" ? url : url.toString();
      calledMethod = init?.method ?? "";
      calledBody = init?.body ? JSON.parse(init.body as string) : undefined;
      return jsonResponse({ success: true });
    }) as typeof fetch;

    const client = new FyndPlatformClient(baseUrl, companyId, appId, token);
    const payload = {
      statuses: [
        {
          shipments: [
            {
              identifier: "FYSHIP1",
              products: [{ line_number: 1, quantity: 1, identifier: "FYBAG1" }],
              reasons: {
                products: [
                  {
                    filters: [{ identifier: "FYBAG1", line_number: 1, quantity: 1 }],
                    data: { reason_id: 7, reason_text: "damaged" },
                  },
                ],
              },
            },
          ],
          status: "return_initiated",
        },
      ],
      task: false,
      force_transition: true,
      lock_after_transition: false,
      unlock_before_transition: true,
    };

    const result = await client.updateShipmentStatus("FYORD-1", payload);

    expect(calledMethod).toBe("PUT");
    expect(calledUrl).toBe(
      `${baseUrl}/service/platform/order-manage/v1.0/company/${companyId}/shipment/status-internal`,
    );
    expect(calledBody).toEqual(payload);
    expect(result).toEqual({ success: true });
  });

  it("sends Authorization: Bearer <token> header", async () => {
    let receivedAuth = "";
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      receivedAuth = (init?.headers as Record<string, string>)["Authorization"] ?? "";
      return jsonResponse({ ok: true });
    }) as typeof fetch;

    const client = new FyndPlatformClient(baseUrl, companyId, appId, "my-tok-xyz");
    await client.updateShipmentStatus("FYORD-1", {
      statuses: [{ shipments: [{ identifier: "S1" }], status: "return_initiated" }],
    });
    expect(receivedAuth).toBe("Bearer my-tok-xyz");
  });

  it("propagates 4xx/5xx errors with helpful messages", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ message: "bad request" }, { status: 400 })
    ) as typeof fetch;
    const client = new FyndPlatformClient(baseUrl, companyId, appId, token);
    await expect(
      client.updateShipmentStatus("FYORD-1", {
        statuses: [{ shipments: [{ identifier: "S1" }], status: "return_initiated" }],
      }),
    ).rejects.toThrow(/Fynd Platform API error 400/);
  });

  it("propagates 403 with scopes hint", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ message: "no scopes" }, { status: 403 })
    ) as typeof fetch;
    const client = new FyndPlatformClient(baseUrl, companyId, appId, token);
    await expect(
      client.updateShipmentStatus("FYORD-1", {
        statuses: [{ shipments: [{ identifier: "S1" }], status: "return_initiated" }],
      }),
    ).rejects.toThrow(/scopes/);
  });

  it("returns null when the API replies 200 with empty body", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response("", { status: 200 })
    ) as typeof fetch;
    const client = new FyndPlatformClient(baseUrl, companyId, appId, token);
    const result = await client.updateShipmentStatus("FYORD-1", {
      statuses: [{ shipments: [{ identifier: "S1" }], status: "return_initiated" }],
    });
    expect(result).toBe(null);
  });

  it("invokes the log callback for request and response", async () => {
    globalThis.fetch = vi.fn(async () => jsonResponse({ ok: true })) as typeof fetch;
    const log = vi.fn();
    const client = new FyndPlatformClient(baseUrl, companyId, appId, token, log);
    await client.updateShipmentStatus("FYORD-1", {
      statuses: [{ shipments: [{ identifier: "S1" }], status: "return_initiated" }],
    });
    // The request() helper invokes log("fynd-platform", "Request", ...) at minimum
    expect(log).toHaveBeenCalledWith(
      "fynd-platform",
      "Request",
      expect.stringMatching(/PUT.*shipment\/status-internal/),
    );
  });
});

describe("FyndPlatformClient.searchShipmentsByExternalOrderId", () => {
  const baseUrl = "https://api-test.fynd.example";
  const companyId = "co-789";
  const appId = "app-1";
  const token = "tok-search";

  it("builds the default query string and trims search value", async () => {
    let calledUrl = "";
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      calledUrl = typeof url === "string" ? url : url.toString();
      return jsonResponse({ items: [] });
    }) as typeof fetch;

    const client = new FyndPlatformClient(baseUrl, companyId, appId, token);
    await client.searchShipmentsByExternalOrderId("  EXT-123  ");

    const u = new URL(calledUrl);
    expect(u.pathname).toBe(`/service/platform/order/v1.0/company/${companyId}/shipments-listing`);
    expect(u.searchParams.get("group_entity")).toBe("shipments");
    expect(u.searchParams.get("page_no")).toBe("1");
    expect(u.searchParams.get("page_size")).toBe("50");
    expect(u.searchParams.get("search_value")).toBe("EXT-123");
    expect(u.searchParams.get("search_type")).toBe("external_order_id");
    expect(u.searchParams.get("sort_type")).toBe("sla_asc");
    expect(u.searchParams.get("bag_status")).toBe(null);
    expect(u.searchParams.get("fulfillment_type")).toBe(null);
  });

  it("honours custom params (groupEntity, pageNo, pageSize, searchType, sortType)", async () => {
    let calledUrl = "";
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      calledUrl = typeof url === "string" ? url : url.toString();
      return jsonResponse({ items: [] });
    }) as typeof fetch;

    const client = new FyndPlatformClient(baseUrl, companyId, appId, token);
    await client.searchShipmentsByExternalOrderId("EXT-555", {
      groupEntity: "orders",
      pageNo: 3,
      pageSize: 20,
      searchType: "shipment_id",
      sortType: "created_desc",
    });

    const u = new URL(calledUrl);
    expect(u.searchParams.get("group_entity")).toBe("orders");
    expect(u.searchParams.get("page_no")).toBe("3");
    expect(u.searchParams.get("page_size")).toBe("20");
    expect(u.searchParams.get("search_type")).toBe("shipment_id");
    expect(u.searchParams.get("sort_type")).toBe("created_desc");
  });

  it("appends bag_status when orderStatus is given and fulfillment_type when provided", async () => {
    let calledUrl = "";
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      calledUrl = typeof url === "string" ? url : url.toString();
      return jsonResponse({ items: [] });
    }) as typeof fetch;

    const client = new FyndPlatformClient(baseUrl, companyId, appId, token);
    await client.searchShipmentsByExternalOrderId("EXT-1", {
      orderStatus: "delivered",
      fulfillmentType: "non-mto",
    });

    const u = new URL(calledUrl);
    expect(u.searchParams.get("bag_status")).toBe("delivered");
    expect(u.searchParams.get("fulfillment_type")).toBe("non-mto");
  });

  it("extracts orderId/shipmentId from items[0] (FY-prefixed) and returns body fields", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        items: [{ id: "FYSHIP9876543210", order_id: "FY1234567890ABC", extra: "kept" }],
        page: { current: 1 },
      })
    ) as typeof fetch;

    const client = new FyndPlatformClient(baseUrl, companyId, appId, token);
    const res = await client.searchShipmentsByExternalOrderId("EXT-FY");

    expect(res.orderId).toBe("FY1234567890ABC");
    expect(res.shipmentId).toBe("FYSHIP9876543210");
    expect(res.items).toBeDefined();
    expect((res as Record<string, unknown>).page).toEqual({ current: 1 });
  });

  it("falls back to body.shipments when no items[]", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        shipments: [{ shipment_id: "FYSHIP4444444444", bag_id: "FYBAG3333333333" }],
      })
    ) as typeof fetch;

    const client = new FyndPlatformClient(baseUrl, companyId, appId, token);
    const res = await client.searchShipmentsByExternalOrderId("EXT-S");
    expect(res.shipmentId).toBe("FYSHIP4444444444");
    expect(res.orderId).toBe("FYBAG3333333333");
  });

  it("falls back to body.data.items when neither items[] nor shipments[] present", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        data: { items: [{ id: "FYSHIP1111111111", order_id: "1234567" }] },
      })
    ) as typeof fetch;

    const client = new FyndPlatformClient(baseUrl, companyId, appId, token);
    const res = await client.searchShipmentsByExternalOrderId("EXT-D");
    expect(res.shipmentId).toBe("FYSHIP1111111111");
    expect(res.orderId).toBe("1234567");
  });

  it("returns undefined ids when items list is empty", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ items: [] })
    ) as typeof fetch;

    const client = new FyndPlatformClient(baseUrl, companyId, appId, token);
    const res = await client.searchShipmentsByExternalOrderId("EXT-EMPTY");
    expect(res.orderId).toBeUndefined();
    expect(res.shipmentId).toBeUndefined();
  });

  it("returns undefined ids when first item is non-object (defensive)", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ items: ["not an object"] })
    ) as typeof fetch;

    const client = new FyndPlatformClient(baseUrl, companyId, appId, token);
    const res = await client.searchShipmentsByExternalOrderId("EXT-WEIRD");
    expect(res.orderId).toBeUndefined();
    expect(res.shipmentId).toBeUndefined();
  });

  it("propagates a 401 from shipments-listing as a thrown error", async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({ message: "unauth" }, { status: 401 })
    ) as typeof fetch;

    const client = new FyndPlatformClient(baseUrl, companyId, appId, token);
    await expect(client.searchShipmentsByExternalOrderId("EXT-401"))
      .rejects.toThrow(/401/);
  });

  it("propagates network errors as 'Network error'", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("ENOTFOUND host");
    }) as typeof fetch;
    const client = new FyndPlatformClient(baseUrl, companyId, appId, token);
    await expect(client.searchShipmentsByExternalOrderId("EXT-NET"))
      .rejects.toThrow(/Network error/);
  });

  it("uses GET method and Bearer token", async () => {
    let method = "";
    let auth = "";
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      method = init?.method ?? "";
      auth = (init?.headers as Record<string, string>)["Authorization"] ?? "";
      return jsonResponse({ items: [] });
    }) as typeof fetch;

    const client = new FyndPlatformClient(baseUrl, companyId, appId, "tk");
    await client.searchShipmentsByExternalOrderId("EXT-1");
    expect(method).toBe("GET");
    expect(auth).toBe("Bearer tk");
  });
});
