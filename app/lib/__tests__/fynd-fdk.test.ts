import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * fynd-fdk.server.ts tests.
 *
 * Mock @gofynd/fdk-client-javascript so we can validate:
 *  - createFyndPlatformClient / createFyndApplicationClient wire configs correctly
 *  - FyndStorefrontClientFDK maps SDK responses through correctly
 *  - FyndPlatformClientFDK.request formats error messages for 401/403
 *  - getShipments / searchShipmentsByExternalOrderId / updateShipmentStatus paths
 */

const { platformConfigCtor, applicationConfigCtor, platformCtor, applicationCtor, platformRequest, appRequest, appGetLanguages } = vi.hoisted(() => {
  const platformConfigCtor = vi.fn();
  const applicationConfigCtor = vi.fn();
  const platformRequest = vi.fn();
  const appRequest = vi.fn();
  const appGetLanguages = vi.fn();

  class FakePlatformConfig {
    constructor(opts: unknown) { platformConfigCtor(opts); }
  }
  class FakeApplicationConfig {
    constructor(opts: unknown) { applicationConfigCtor(opts); }
  }
  class FakePlatformClient {
    request = platformRequest;
    configuration = { getLanguages: appGetLanguages };
    constructor(cfg: unknown, extra: unknown) { platformCtorFn(cfg, extra); }
  }
  class FakeApplicationClient {
    request = appRequest;
    configuration = { getLanguages: appGetLanguages };
    constructor(cfg: unknown, extra: unknown) { applicationCtorFn(cfg, extra); }
  }
  const platformCtorFn = vi.fn();
  const applicationCtorFn = vi.fn();

  return {
    platformConfigCtor,
    applicationConfigCtor,
    platformCtor: platformCtorFn,
    applicationCtor: applicationCtorFn,
    platformRequest,
    appRequest,
    appGetLanguages,
    // Expose the classes via the mock factory below
    _classes: {
      PlatformConfig: FakePlatformConfig,
      ApplicationConfig: FakeApplicationConfig,
      PlatformClient: FakePlatformClient,
      ApplicationClient: FakeApplicationClient,
    },
  };
});

vi.mock("@gofynd/fdk-client-javascript", async () => {
  // Reconstruct classes here referencing hoisted mocks
  class PlatformConfig {
    constructor(opts: unknown) { platformConfigCtor(opts); }
  }
  class ApplicationConfig {
    constructor(opts: unknown) { applicationConfigCtor(opts); }
  }
  class PlatformClient {
    request = platformRequest;
    constructor(cfg: unknown, extra: unknown) { platformCtor(cfg, extra); }
  }
  class ApplicationClient {
    request = appRequest;
    configuration = { getLanguages: appGetLanguages };
    constructor(cfg: unknown, extra: unknown) { applicationCtor(cfg, extra); }
  }
  return { PlatformConfig, ApplicationConfig, PlatformClient, ApplicationClient };
});

vi.mock("../fynd-config.server", () => ({
  getFyndBaseUrl: vi.fn((s: { fyndEnvironment?: string | null }) =>
    s.fyndEnvironment === "prod" ? "https://api.fynd.com" : "https://api.uat.fyndx1.de"
  ),
}));

vi.mock("../fynd.server", () => ({
  parseShipmentInternalIds: vi.fn((obj: Record<string, unknown> | null) => ({
    orderId: obj?.order_id ?? null,
    shipmentId: obj?.shipment_id ?? null,
  })),
}));

import {
  createFyndPlatformClient,
  createFyndApplicationClient,
  FyndStorefrontClientFDK,
  FyndPlatformClientFDK,
  getFyndDomain,
} from "../fynd-fdk.server";

beforeEach(() => {
  platformConfigCtor.mockClear();
  applicationConfigCtor.mockClear();
  platformCtor.mockClear();
  applicationCtor.mockClear();
  platformRequest.mockReset();
  appRequest.mockReset();
  appGetLanguages.mockReset();
});

describe("createFyndPlatformClient", () => {
  it("passes config fields to PlatformConfig + strips trailing slash from domain", () => {
    createFyndPlatformClient({
      companyId: "C1",
      applicationId: "A1",
      apiKey: "key",
      apiSecret: "secret",
      domain: "https://api.fynd.com/",
    });
    expect(platformConfigCtor).toHaveBeenCalledWith({
      companyId: "C1",
      domain: "https://api.fynd.com",
      apiKey: "key",
      apiSecret: "secret",
      useAutoRenewTimer: false,
    });
    expect(platformCtor).toHaveBeenCalled();
  });

  it("leaves a clean domain untouched", () => {
    createFyndPlatformClient({
      companyId: "C1",
      applicationId: "A1",
      apiKey: "k",
      apiSecret: "s",
      domain: "https://api.uat.fyndx1.de",
    });
    expect(platformConfigCtor).toHaveBeenCalledWith(expect.objectContaining({
      domain: "https://api.uat.fyndx1.de",
    }));
  });
});

describe("createFyndApplicationClient", () => {
  it("passes config fields to ApplicationConfig", () => {
    createFyndApplicationClient({
      applicationId: "A1",
      applicationToken: "tok",
      domain: "https://api.fynd.com/",
    });
    expect(applicationConfigCtor).toHaveBeenCalledWith({
      applicationID: "A1",
      applicationToken: "tok",
      domain: "https://api.fynd.com",
    });
  });
});

describe("getFyndDomain", () => {
  it("delegates to getFyndBaseUrl", () => {
    expect(getFyndDomain({ fyndEnvironment: "prod" })).toBe("https://api.fynd.com");
    expect(getFyndDomain({ fyndEnvironment: "uat" })).toBe("https://api.uat.fyndx1.de");
  });
});

describe("FyndStorefrontClientFDK", () => {
  function mkClient() {
    // appClient needs .configuration.getLanguages and .request
    const log = vi.fn();
    const appClient = {
      configuration: { getLanguages: appGetLanguages },
      request: appRequest,
    };
    return { client: new FyndStorefrontClientFDK(appClient as never, log), log };
  }

  it("getLanguages calls appClient.configuration.getLanguages and returns its result", async () => {
    const { client, log } = mkClient();
    appGetLanguages.mockResolvedValueOnce({ items: ["en"] });
    const res = await client.getLanguages();
    expect(res).toEqual({ items: ["en"] });
    expect(log).toHaveBeenCalledWith("fynd-fdk-storefront", "Request", "GET /languages");
  });

  it("getLanguages wraps Error", async () => {
    const { client } = mkClient();
    appGetLanguages.mockRejectedValueOnce(new Error("net"));
    await expect(client.getLanguages()).rejects.toThrow("Fynd Storefront API error: net");
  });

  it("getLanguages wraps non-Error throws", async () => {
    const { client } = mkClient();
    appGetLanguages.mockRejectedValueOnce("bad");
    await expect(client.getLanguages()).rejects.toThrow("Fynd Storefront API error: bad");
  });

  it("getBagReasons returns the .data field from a low-level request", async () => {
    const { client } = mkClient();
    appRequest.mockResolvedValueOnce({ data: { items: [{ id: 1 }] } });
    const res = await client.getBagReasons();
    expect(res).toEqual({ items: [{ id: 1 }] });
    expect(appRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: "GET",
      url: "/service/application/order/v1.0/bag/reasons",
    }));
  });

  it("getBagReasons wraps errors", async () => {
    const { client } = mkClient();
    appRequest.mockRejectedValueOnce(new Error("boom"));
    await expect(client.getBagReasons()).rejects.toThrow("Fynd Storefront API error: boom");
  });
});

describe("FyndPlatformClientFDK", () => {
  function mkClient() {
    const log = vi.fn();
    const fdk = { request: platformRequest } as unknown as InstanceType<typeof import("@gofynd/fdk-client-javascript").PlatformClient>;
    return { client: new FyndPlatformClientFDK(fdk, "C1", "A1", log), log };
  }

  it("getReturnReasons calls the orders-listing probe endpoint and returns null", async () => {
    const { client } = mkClient();
    platformRequest.mockResolvedValueOnce({ data: { items: [] } });
    const res = await client.getReturnReasons();
    expect(res).toBe(null);
    expect(platformRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: "GET",
      url: "/service/platform/order/v1.0/company/C1/orders-listing?page_no=1&page_size=1",
    }));
  });

  it("testConnection returns ok:true on success", async () => {
    const { client } = mkClient();
    platformRequest.mockResolvedValueOnce({ data: {} });
    await expect(client.testConnection()).resolves.toEqual({ ok: true });
  });

  it("testConnection returns ok:true with warning on 404", async () => {
    const { client } = mkClient();
    platformRequest.mockRejectedValueOnce({ response: { status: 404, data: { message: "Not Found" } } });
    const res = await client.testConnection();
    expect(res.ok).toBe(true);
    expect(res.warning).toMatch(/Return reasons endpoint not available/);
  });

  it("testConnection rethrows other errors", async () => {
    const { client } = mkClient();
    platformRequest.mockRejectedValueOnce({ response: { status: 500, data: { message: "server exploded" } } });
    await expect(client.testConnection()).rejects.toThrow(/500/);
  });

  it("request() annotates 401 errors with hint about credentials", async () => {
    const { client } = mkClient();
    platformRequest.mockRejectedValueOnce({ response: { status: 401, data: { message: "Unauthorized" } } });
    await expect(client.getReturnReasons()).rejects.toThrow(/401.*Company ID, Client ID and Secret/s);
  });

  it("request() annotates 403 errors with scope guidance", async () => {
    const { client } = mkClient();
    platformRequest.mockRejectedValueOnce({ response: { status: 403, data: { message: "Forbidden" } } });
    await expect(client.getReturnReasons()).rejects.toThrow(/403.*company\/orders\/read/s);
  });

  it("request() uses description fallback when message absent", async () => {
    const { client } = mkClient();
    platformRequest.mockRejectedValueOnce({ response: { status: 500, data: { description: "broken" } } });
    await expect(client.getReturnReasons()).rejects.toThrow(/500: broken/);
  });

  it("request() falls back to message when no response.status", async () => {
    const { client } = mkClient();
    platformRequest.mockRejectedValueOnce(new Error("networkdown"));
    await expect(client.getReturnReasons()).rejects.toThrow("networkdown");
  });

  it("getShipments returns .shipments preferentially", async () => {
    const { client } = mkClient();
    platformRequest.mockResolvedValueOnce({ data: { shipments: [{ id: "s1" }], order: { id: "o1" } } });
    const res = await client.getShipments("ORD-1");
    expect(res).toEqual([{ id: "s1" }]);
  });

  it("getShipments falls back to order, then raw response", async () => {
    const { client } = mkClient();
    platformRequest.mockResolvedValueOnce({ data: { order: { id: "o1" } } });
    const res = await client.getShipments("ORD-1");
    expect(res).toEqual({ id: "o1" });
  });

  it("searchShipmentsByExternalOrderId builds query string + parses internal IDs", async () => {
    const { client } = mkClient();
    platformRequest.mockResolvedValueOnce({
      data: { items: [{ order_id: "INT-1", shipment_id: "SH-1" }] },
    });
    const res = await client.searchShipmentsByExternalOrderId("EXT-42", { pageSize: 5, orderStatus: "delivered" });
    expect(res.orderId).toBe("INT-1");
    expect(res.shipmentId).toBe("SH-1");
    const path = platformRequest.mock.calls[0][0].url as string;
    expect(path).toContain("search_value=EXT-42");
    expect(path).toContain("bag_status=delivered");
    expect(path).toContain("page_size=5");
    expect(path).toContain("search_type=external_order_id");
  });

  it("searchShipmentsByExternalOrderId handles empty results safely", async () => {
    const { client } = mkClient();
    platformRequest.mockResolvedValueOnce({ data: { items: [] } });
    const res = await client.searchShipmentsByExternalOrderId("EXT-42");
    expect(res.orderId).toBe(undefined);
    expect(res.shipmentId).toBe(undefined);
  });

  it("searchShipmentsByExternalOrderId preserves alternate list keys (shipments/data.items/results)", async () => {
    const { client } = mkClient();
    platformRequest.mockResolvedValueOnce({ data: { results: [{ order_id: "R-1" }] } });
    const res = await client.searchShipmentsByExternalOrderId("EXT-1");
    expect(res.orderId).toBe("R-1");
  });

  it("updateShipmentStatus issues PUT to status-internal path with payload", async () => {
    const { client } = mkClient();
    platformRequest.mockResolvedValueOnce({ data: { ok: true } });
    await client.updateShipmentStatus("unused-order", {
      statuses: [{ shipments: [{ identifier: "S1" }], status: "return_initiated" }],
    });
    expect(platformRequest).toHaveBeenCalledWith(expect.objectContaining({
      method: "PUT",
      url: "/service/platform/order-manage/v1.0/company/C1/shipment/status-internal",
    }));
  });
});
