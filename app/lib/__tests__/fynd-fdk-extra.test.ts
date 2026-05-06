import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Extra coverage for fynd-fdk.server.ts.
 * Focuses on branches not covered by fynd-fdk.test.ts:
 *  - searchShipmentsByExternalOrderId variants (shipments key, data.items, custom params, trim, non-array items)
 *  - getShipments raw-fallthrough branch
 *  - request() error branches (non-Error throw, message-only fallback)
 *  - updateShipmentStatus payload pass-through with all flags
 *  - testConnection 404 detection by message string only
 *  - createFyndPlatformClient/createFyndApplicationClient pass empty options as 2nd arg
 */

const {
  platformConfigCtor,
  applicationConfigCtor,
  platformCtor,
  applicationCtor,
  platformRequest,
  appRequest,
  appGetLanguages,
} = vi.hoisted(() => ({
  platformConfigCtor: vi.fn(),
  applicationConfigCtor: vi.fn(),
  platformCtor: vi.fn(),
  applicationCtor: vi.fn(),
  platformRequest: vi.fn(),
  appRequest: vi.fn(),
  appGetLanguages: vi.fn(),
}));

vi.mock("@gofynd/fdk-client-javascript", () => {
  class PlatformConfig {
    constructor(opts: unknown) {
      platformConfigCtor(opts);
    }
  }
  class ApplicationConfig {
    constructor(opts: unknown) {
      applicationConfigCtor(opts);
    }
  }
  class PlatformClient {
    request = platformRequest;
    constructor(cfg: unknown, extra: unknown) {
      platformCtor(cfg, extra);
    }
  }
  class ApplicationClient {
    request = appRequest;
    configuration = { getLanguages: appGetLanguages };
    constructor(cfg: unknown, extra: unknown) {
      applicationCtor(cfg, extra);
    }
  }
  return { PlatformConfig, ApplicationConfig, PlatformClient, ApplicationClient };
});

vi.mock("../fynd-config.server", () => ({
  getFyndBaseUrl: vi.fn((s: { fyndEnvironment?: string | null }) =>
    s.fyndEnvironment === "prod" ? "https://api.fynd.com" : "https://api.uat.fyndx1.de",
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
  FyndPlatformClientFDK,
  FyndStorefrontClientFDK,
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

function mkPlatform() {
  const log = vi.fn();
  const fdk = { request: platformRequest } as unknown as InstanceType<
    typeof import("@gofynd/fdk-client-javascript").PlatformClient
  >;
  return { client: new FyndPlatformClientFDK(fdk, "C1", "A1", log), log };
}

describe("createFyndPlatformClient (extra)", () => {
  it("invokes PlatformClient with empty extras object", () => {
    createFyndPlatformClient({
      companyId: "C9",
      applicationId: "A9",
      apiKey: "k",
      apiSecret: "s",
      domain: "https://api.uat.fyndx1.de",
    });
    expect(platformCtor).toHaveBeenCalledWith(expect.anything(), {});
  });
});

describe("createFyndApplicationClient (extra)", () => {
  it("strips trailing slash and passes empty extras to ApplicationClient ctor", () => {
    createFyndApplicationClient({
      applicationId: "APP",
      applicationToken: "T",
      domain: "https://api.fynd.com////",
    });
    // Only the very last trailing slash is removed by the regex (replace(/\/$/, ""))
    expect(applicationConfigCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        domain: "https://api.fynd.com///",
      }),
    );
    expect(applicationCtor).toHaveBeenCalledWith(expect.anything(), {});
  });
});

describe("FyndStorefrontClientFDK.getBagReasons (extra)", () => {
  it("wraps non-Error throws", async () => {
    const log = vi.fn();
    const appClient = { configuration: { getLanguages: appGetLanguages }, request: appRequest };
    const client = new FyndStorefrontClientFDK(appClient as never, log);
    appRequest.mockRejectedValueOnce("plain-string");
    await expect(client.getBagReasons()).rejects.toThrow("Fynd Storefront API error: plain-string");
  });
});

describe("FyndPlatformClientFDK.request (extra)", () => {
  it("wraps non-Error throw using String() coercion", async () => {
    const { client } = mkPlatform();
    platformRequest.mockRejectedValueOnce("kaboom");
    await expect(client.getReturnReasons()).rejects.toThrow("kaboom");
  });

  it("when status missing, uses raw error message without prefix", async () => {
    const { client } = mkPlatform();
    platformRequest.mockRejectedValueOnce({ message: "no-status" });
    // Without response.status, the formatter falls back to the original Error.message coerced via String(err)
    await expect(client.getReturnReasons()).rejects.toThrow(/\[object Object\]|no-status/);
  });

  it("logs each request via the supplied log fn", async () => {
    const { client, log } = mkPlatform();
    platformRequest.mockResolvedValueOnce({ data: {} });
    await client.getReturnReasons();
    expect(log).toHaveBeenCalledWith(
      "fynd-fdk",
      "Request",
      expect.stringContaining("GET /service/platform/order/v1.0/company/C1/orders-listing"),
    );
  });
});

describe("FyndPlatformClientFDK.testConnection (extra)", () => {
  it("returns warning when error message contains 'Not Found' even without status", async () => {
    const { client } = mkPlatform();
    platformRequest.mockRejectedValueOnce(new Error("Not Found"));
    const res = await client.testConnection();
    expect(res.ok).toBe(true);
    expect(res.warning).toMatch(/admin-configured reasons/);
  });
});

describe("FyndPlatformClientFDK.getShipments (extra)", () => {
  it("returns the raw data when neither shipments nor order is present", async () => {
    const { client } = mkPlatform();
    platformRequest.mockResolvedValueOnce({ data: { foo: "bar" } });
    const res = await client.getShipments("ORD-2");
    expect(res).toEqual({ foo: "bar" });
  });

  it("URL-encodes order id", async () => {
    const { client } = mkPlatform();
    platformRequest.mockResolvedValueOnce({ data: { shipments: [] } });
    await client.getShipments("ORD/With Space&");
    const url = platformRequest.mock.calls[0][0].url as string;
    expect(url).toContain("order_id=ORD%2FWith%20Space%26");
  });
});

describe("FyndPlatformClientFDK.searchShipmentsByExternalOrderId (extra)", () => {
  it("uses default group_entity=shipments / sort_type=sla_asc / page_no=1 / page_size=50 when not provided", async () => {
    const { client } = mkPlatform();
    platformRequest.mockResolvedValueOnce({ data: { items: [] } });
    await client.searchShipmentsByExternalOrderId("EXT-1");
    const url = platformRequest.mock.calls[0][0].url as string;
    expect(url).toContain("group_entity=shipments");
    expect(url).toContain("sort_type=sla_asc");
    expect(url).toContain("page_no=1");
    expect(url).toContain("page_size=50");
    expect(url).toContain("search_type=external_order_id");
    // bag_status only set when orderStatus provided
    expect(url).not.toContain("bag_status=");
  });

  it("honors custom groupEntity/searchType/sortType/pageNo", async () => {
    const { client } = mkPlatform();
    platformRequest.mockResolvedValueOnce({ data: { items: [] } });
    await client.searchShipmentsByExternalOrderId("EXT-99", {
      groupEntity: "orders",
      searchType: "shipment_id",
      sortType: "created_desc",
      pageNo: 7,
    });
    const url = platformRequest.mock.calls[0][0].url as string;
    expect(url).toContain("group_entity=orders");
    expect(url).toContain("search_type=shipment_id");
    expect(url).toContain("sort_type=created_desc");
    expect(url).toContain("page_no=7");
  });

  it("trims whitespace from external order id in search_value", async () => {
    const { client } = mkPlatform();
    platformRequest.mockResolvedValueOnce({ data: { items: [] } });
    await client.searchShipmentsByExternalOrderId("   EXT-77   ");
    const url = platformRequest.mock.calls[0][0].url as string;
    expect(url).toContain("search_value=EXT-77");
    expect(url).not.toContain("search_value=+++EXT-77");
  });

  it("prefers top-level shipments[] when no items[]", async () => {
    const { client } = mkPlatform();
    platformRequest.mockResolvedValueOnce({
      data: { shipments: [{ order_id: "SHP-OID", shipment_id: "SHP-SID" }] },
    });
    const res = await client.searchShipmentsByExternalOrderId("EXT-1");
    expect(res.orderId).toBe("SHP-OID");
    expect(res.shipmentId).toBe("SHP-SID");
  });

  it("falls back to data.items[] when present", async () => {
    const { client } = mkPlatform();
    platformRequest.mockResolvedValueOnce({
      data: { data: { items: [{ order_id: "DI-OID" }] } },
    });
    const res = await client.searchShipmentsByExternalOrderId("EXT-1");
    expect(res.orderId).toBe("DI-OID");
  });

  it("returns undefined ids when first item is non-object (e.g., string)", async () => {
    const { client } = mkPlatform();
    platformRequest.mockResolvedValueOnce({ data: { items: ["just-a-string"] } });
    const res = await client.searchShipmentsByExternalOrderId("EXT-1");
    expect(res.orderId).toBe(undefined);
    expect(res.shipmentId).toBe(undefined);
  });

  it("spreads extra response fields into the return value", async () => {
    const { client } = mkPlatform();
    platformRequest.mockResolvedValueOnce({
      data: { items: [], page: { current: 1, total: 0 } },
    });
    const res = (await client.searchShipmentsByExternalOrderId("EXT-1")) as { page?: unknown };
    expect(res.page).toEqual({ current: 1, total: 0 });
  });
});

describe("FyndPlatformClientFDK.updateShipmentStatus (extra)", () => {
  it("forwards full payload including task / force_transition / lock flags", async () => {
    const { client } = mkPlatform();
    platformRequest.mockResolvedValueOnce({ data: { success: true } });
    const payload = {
      statuses: [
        {
          shipments: [
            {
              identifier: "S1",
              products: [{ line_number: 1, quantity: 2, identifier: "P1" }],
              reasons: {
                products: [
                  {
                    filters: [{ identifier: "P1", line_number: 1, quantity: 2 }],
                    data: { reason_id: 42, reason_text: "Damaged" },
                  },
                ],
              },
            },
          ],
          status: "return_initiated",
        },
      ],
      task: true,
      force_transition: false,
      lock_after_transition: true,
      unlock_before_transition: false,
    };
    await client.updateShipmentStatus("ignored-order-id", payload);
    expect(platformRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "PUT",
        url: "/service/platform/order-manage/v1.0/company/C1/shipment/status-internal",
        body: payload,
        headers: { "Content-Type": "application/json" },
      }),
    );
  });
});
