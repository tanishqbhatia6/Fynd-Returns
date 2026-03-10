/**
 * Fynd FDK (Platform + Application/Storefront SDK) integration.
 * Uses @gofynd/fdk-client-javascript for Platform and ApplicationClient.
 */
import { PlatformClient, ApplicationClient, PlatformConfig, ApplicationConfig } from "@gofynd/fdk-client-javascript";
import { getFyndBaseUrl } from "./fynd-config.server";
import { parseShipmentInternalIds } from "./fynd.server";

type PlatformClientType = InstanceType<typeof PlatformClient>;
type ApplicationClientType = InstanceType<typeof ApplicationClient>;

export type FyndLogFn = (step: string, message: string, detail?: string) => void;

export type ShipmentsListingParamsFDK = {
  searchValue?: string;
  searchType?: string;
  pageNo?: number;
  pageSize?: number;
  groupEntity?: "shipments" | "orders";
  fulfillmentType?: string;
  parentViewSlug?: string;
  childViewSlug?: string;
  sortType?: string;
  orderStatus?: string;
  locationCode?: string;
};

export type FyndFDKPlatformConfig = {
  companyId: string;
  applicationId: string;
  apiKey: string;
  apiSecret: string;
  domain: string;
  log?: FyndLogFn;
};

export type FyndFDKApplicationConfig = {
  applicationId: string;
  applicationToken: string;
  domain: string;
  log?: FyndLogFn;
};

/** Create Platform SDK client (apiKey/apiSecret = Client ID/Client Secret) */
export function createFyndPlatformClient(config: FyndFDKPlatformConfig): PlatformClientType {
  const domain = config.domain.replace(/\/$/, "");
  const platformConfig = new PlatformConfig({
    companyId: config.companyId,
    domain,
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    useAutoRenewTimer: false,
  });
  return new PlatformClient(platformConfig, {});
}

/** Create Application (Storefront) SDK client */
export function createFyndApplicationClient(config: FyndFDKApplicationConfig): ApplicationClientType {
  const domain = config.domain.replace(/\/$/, "");
  const appConfig = new ApplicationConfig({
    applicationID: config.applicationId,
    applicationToken: config.applicationToken,
    domain,
  });
  return new ApplicationClient(appConfig, {});
}

/** FDK-backed Storefront client that matches FyndStorefrontClient interface */
export class FyndStorefrontClientFDK {
  constructor(
    private appClient: ApplicationClientType,
    private log?: FyndLogFn
  ) { }

  async getLanguages(): Promise<unknown> {
    this.log?.("fynd-fdk-storefront", "Request", "GET /languages");
    try {
      const res = await this.appClient.configuration.getLanguages();
      return res;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Fynd Storefront API error: ${msg}`);
    }
  }

  async getBagReasons(): Promise<unknown> {
    this.log?.("fynd-fdk-storefront", "Request", "GET /bag/reasons");
    try {
      const res = await this.appClient.request({
        method: "GET",
        url: "/service/application/order/v1.0/bag/reasons",
        query: undefined,
        body: undefined,
        headers: {},
      });
      return (res as { data?: unknown }).data;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Fynd Storefront API error: ${msg}`);
    }
  }
}

/** Get FDK domain from settings */
export function getFyndDomain(settings: {
  fyndEnvironment?: string | null;
  fyndCustomBaseUrl?: string | null;
}): string {
  return getFyndBaseUrl(settings);
}

/** FDK-backed Platform client that matches FyndPlatformClient interface for returns/shipments */
export class FyndPlatformClientFDK {
  constructor(
    private fdk: PlatformClientType,
    private companyId: string,
    private applicationId: string,
    private log?: FyndLogFn
  ) { }

  private async request(
    method: string,
    path: string,
    body?: unknown
  ): Promise<unknown> {
    this.log?.("fynd-fdk", "Request", `${method} ${path}`);
    try {
      const res = await this.fdk.request({
        method,
        url: path,
        query: undefined,
        body: body !== undefined ? body : undefined,
        headers: { "Content-Type": "application/json" },
      });
      const data = (res as { data?: unknown }).data;
      return data;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const status = (err as { response?: { status?: number } })?.response?.status;
      const desc = (err as { response?: { data?: { message?: string; description?: string } } })?.response?.data;
      const apiMsg = desc?.message ?? desc?.description ?? msg;
      let fullMsg = status ? `Fynd Platform API error ${status}: ${apiMsg}` : msg;
      if (status === 403) {
        fullMsg += " Fynd returned 403 Forbidden—your app may lack required scopes. In Fynd Platform, ensure the extension has company/orders/read and company/orders/write. Re-save credentials in Settings → Integrations.";
      } else if (status === 401) {
        fullMsg += " Verify Company ID, Client ID and Secret in Settings → Integrations.";
      }
      throw new Error(fullMsg);
    }
  }

  /**
   * Platform Order API has no company-level return reasons.
   * Bag reasons require shipment_id, bag_id, state (GET .../shipments/{id}/bags/{id}/state/{state}/reasons).
   * Validate connection via orders-listing; callers use admin-configured reasons.
   */
  async getReturnReasons(): Promise<unknown> {
    await this.request("GET", `/service/platform/order/v1.0/company/${this.companyId}/orders-listing?page_no=1&page_size=1`);
    return null;
  }

  async testConnection(): Promise<{ ok: true; warning?: string }> {
    try {
      await this.getReturnReasons();
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("404") || msg.includes("Not Found")) {
        return { ok: true, warning: "Credentials valid. Return reasons endpoint not available in this Fynd environment—using admin-configured reasons." };
      }
      throw err;
    }
  }

  /** Platform Order API: GET order-details returns order + shipments */
  async getShipments(orderId: string): Promise<unknown> {
    const res = await this.request("GET", `/service/platform/order/v1.0/company/${this.companyId}/order-details?order_id=${encodeURIComponent(orderId)}`) as { order?: unknown; shipments?: unknown[] };
    return res?.shipments ?? res?.order ?? res;
  }

  /** Platform Order API: GET shipments-listing (docs.fynd.com/partners/commerce/sdk/latest/platform/company/order) */
  async searchShipmentsByExternalOrderId(
    externalOrderId: string,
    params?: Partial<ShipmentsListingParamsFDK>
  ): Promise<{ items?: unknown[]; shipments?: unknown[]; data?: { items?: unknown[] }; orderId?: string; shipmentId?: string }> {
    const searchParams = new URLSearchParams({
      group_entity: params?.groupEntity ?? "shipments",
      page_no: String(params?.pageNo ?? 1),
      page_size: String(params?.pageSize ?? 50),
      search_value: externalOrderId.trim(),
      search_type: params?.searchType ?? "external_order_id",
      sort_type: params?.sortType ?? "sla_asc",
    });
    if (params?.orderStatus) searchParams.set("bag_status", params.orderStatus);
    const path = `/service/platform/order/v1.0/company/${this.companyId}/shipments-listing?${searchParams.toString()}`;
    const res = await this.request("GET", path) as { items?: unknown[]; shipments?: unknown[]; data?: { items?: unknown[] }; results?: unknown[] };
    const items = res?.items ?? res?.shipments ?? res?.data?.items ?? res?.results ?? [];
    const first = Array.isArray(items) ? items[0] : null;
    const firstObj = first && typeof first === "object" ? first as Record<string, unknown> : null;
    const { orderId, shipmentId } = parseShipmentInternalIds(firstObj);
    return {
      ...res,
      orderId: orderId ?? undefined,
      shipmentId: shipmentId ?? undefined,
    };
  }

  /** Platform Order API: PUT shipment/status-internal (orderId kept for backward compat, not used in path) */
  async updateShipmentStatus(
    _orderId: string,
    payload: {
      statuses: Array<{
        shipments: Array<{
          identifier: string;
          products?: Array<{ line_number: number; quantity: number; identifier: string }>;
          reasons?: { products?: Array<{ filters: Array<{ identifier: string; line_number: number; quantity: number }>; data: { reason_id?: number; reason_text?: string } }> };
        }>;
        status: string;
      }>;
      task?: boolean;
      force_transition?: boolean;
      lock_after_transition?: boolean;
      unlock_before_transition?: boolean;
    }
  ): Promise<unknown> {
    const path = `/service/platform/order-manage/v1.0/company/${this.companyId}/shipment/status-internal`;
    return this.request("PUT", path, payload);
  }
}
