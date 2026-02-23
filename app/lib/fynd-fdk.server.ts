/**
 * Fynd FDK (Platform + Application/Storefront SDK) integration.
 * Uses @gofynd/fdk-client-javascript for Platform and ApplicationClient.
 */
import { PlatformClient, ApplicationClient } from "@gofynd/fdk-client-javascript";
import { getFyndBaseUrl } from "./fynd-config.server";

export type FyndLogFn = (step: string, message: string, detail?: string) => void;

export type ShipmentsListingParamsFDK = {
  searchValue?: string;
  searchType?: string;
  startDate?: string;
  endDate?: string;
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
export function createFyndPlatformClient(config: FyndFDKPlatformConfig): PlatformClient {
  const domain = config.domain.replace(/\/$/, "");
  const platformConfig = {
    companyId: config.companyId,
    domain,
    apiKey: config.apiKey,
    apiSecret: config.apiSecret,
    useAutoRenewTimer: false,
    logLevel: "ERROR" as const,
  };
  return new PlatformClient(platformConfig);
}

/** Create Application (Storefront) SDK client */
export function createFyndApplicationClient(config: FyndFDKApplicationConfig): ApplicationClient {
  const domain = config.domain.replace(/\/$/, "");
  return new ApplicationClient({
    applicationID: config.applicationId,
    applicationToken: config.applicationToken,
    domain,
    logLevel: "ERROR",
  });
}

/** FDK-backed Storefront client that matches FyndStorefrontClient interface */
export class FyndStorefrontClientFDK {
  constructor(
    private appClient: ApplicationClient,
    private log?: FyndLogFn
  ) {}

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
    private fdk: PlatformClient,
    private companyId: string,
    private applicationId: string,
    private log?: FyndLogFn
  ) {}

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

  /** Use FDK native method: application().order.getPlatformShipmentReasons (path: orders/shipments/reasons/{action}) */
  async getReturnReasons(): Promise<unknown> {
    this.log?.("fynd-fdk", "Request", "FDK order.getPlatformShipmentReasons");
    try {
      const res = await this.fdk.application(this.applicationId).order.getPlatformShipmentReasons({ action: "return" });
      return res;
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

  async getShipments(orderId: string): Promise<unknown> {
    const path = `/service/platform/order/v1.0/company/${this.companyId}/application/${this.applicationId}/orders/${encodeURIComponent(orderId)}/shipments`;
    return this.request("GET", path);
  }

  async searchShipmentsByExternalOrderId(
    externalOrderId: string,
    params?: Partial<ShipmentsListingParamsFDK>
  ): Promise<{ items?: unknown[]; shipments?: unknown[]; data?: { items?: unknown[] }; orderId?: string; shipmentId?: string }> {
    const now = new Date();
    const endDate = params?.endDate ?? now.toISOString();
    const startDate = params?.startDate ?? (() => {
      const d = new Date(now);
      d.setMonth(d.getMonth() - 1);
      return d.toISOString();
    })();
    const searchParams = new URLSearchParams({
      group_entity: params?.groupEntity ?? "shipments",
      page_no: String(params?.pageNo ?? 1),
      page_size: String(params?.pageSize ?? 2),
      start_date: startDate,
      end_date: endDate,
      search_value: externalOrderId.trim(),
      search_type: params?.searchType ?? "external_order_id",
      fulfillment_type: params?.fulfillmentType ?? "FULFILLMENT",
      parent_view_slug: params?.parentViewSlug ?? "all",
      child_view_slug: params?.childViewSlug ?? "all",
      sort_type: params?.sortType ?? "sla_asc",
    });
    if (params?.orderStatus) searchParams.set("order_status", params.orderStatus);
    if (params?.locationCode) searchParams.set("location_code", params.locationCode);
    if (this.applicationId) searchParams.set("application_id", this.applicationId);
    const path = `/service/portal/order-manage/v1.0/company/${this.companyId}/shipments-listing?${searchParams.toString()}`;
    const res = await this.request("GET", path) as { items?: unknown[]; shipments?: unknown[]; data?: { items?: unknown[] }; results?: unknown[] };
    const items = res?.items ?? res?.shipments ?? res?.data?.items ?? res?.results ?? [];
    const first = Array.isArray(items) ? items[0] : null;
    const firstObj = first && typeof first === "object" ? first as Record<string, unknown> : null;
    const { orderId, shipmentId } = this.parseInternalIds(firstObj);
    return {
      ...res,
      orderId: orderId ?? undefined,
      shipmentId: shipmentId ?? undefined,
    };
  }

  private parseInternalIds(obj: Record<string, unknown> | null): { orderId: string | null; shipmentId: string | null } {
    if (!obj) return { orderId: null, shipmentId: null };
    const str = (v: unknown) => (v != null && typeof v === "string" ? v.trim() : null);
    const orderRaw = [
      str(obj.order_id ?? obj.orderId ?? obj.bag_id ?? obj.bagId ?? obj.channel_bag_id ?? obj.channel_order_id),
    ].filter((x): x is string => !!x);
    const shipmentRaw = [
      str(obj.id ?? obj.shipment_id ?? obj.shipmentId ?? obj.channel_shipment_id),
    ].filter((x): x is string => !!x);
    const fyOrderId = orderRaw.find((s) => /^FY[A-Z0-9]{10,}/i.test(s));
    const numericOrderId = orderRaw.find((s) => /^\d+$/.test(s));
    const orderId = fyOrderId ?? numericOrderId ?? orderRaw[0] ?? null;
    const shipmentId = shipmentRaw.find((s) => /^FY[A-Z0-9]{10,}/i.test(s))
      ?? shipmentRaw.find((s) => /^\d+$/.test(s))
      ?? shipmentRaw[0]
      ?? null;
    return { orderId, shipmentId };
  }

  async updateShipmentStatus(
    orderId: string,
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
    const path = `/service/platform/order/v1.0/company/${this.companyId}/application/${this.applicationId}/orders/${encodeURIComponent(orderId)}/shipments/status`;
    return this.request("PUT", path, payload);
  }
}
