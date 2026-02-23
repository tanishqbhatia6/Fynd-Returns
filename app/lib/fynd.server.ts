import { decrypt } from "./encryption.server";
import { getFyndBaseUrl } from "./fynd-config.server";
import { createFyndPlatformClient, createFyndApplicationClient, FyndPlatformClientFDK, FyndStorefrontClientFDK, getFyndDomain } from "./fynd-fdk.server";

export type FyndLogFn = (step: string, message: string, detail?: string) => void;

export type FyndSettings = {
  fyndEnvironment?: string | null;
  fyndCustomBaseUrl?: string | null;
  fyndCompanyId?: string | null;
  fyndApplicationId?: string | null;
  fyndCredentials?: string | null;
};

export type ShipmentsListingSearchType =
  | "external_order_id"
  | "order_id"
  | "shipment_id"
  | "awb"
  | "channel_order_id"
  | "customer_phone"
  | "customer_email";

export type ShipmentsListingParams = {
  searchValue?: string;
  searchType?: ShipmentsListingSearchType;
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

// --- Platform API (OAuth client_credentials) ---

export async function fetchFyndPlatformToken(
  baseUrl: string,
  companyId: string,
  clientId: string,
  clientSecret: string,
  log?: FyndLogFn
): Promise<string> {
  const url = `${baseUrl}/service/panel/authentication/v1.0/company/${companyId}/oauth/token`;
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  log?.("fynd-platform-oauth", "Fetching token", `url=${url}`);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${basicAuth}`,
      },
      body: JSON.stringify({ grant_type: "client_credentials" }),
    });
  } catch (netErr) {
    const m = netErr instanceof Error ? netErr.message : String(netErr);
    if (m.includes("fetch") || m.includes("network") || m.includes("ECONNREFUSED") || m.includes("ETIMEDOUT") || m.includes("ENOTFOUND")) {
      throw new Error("Network error: Could not reach Fynd OAuth. Check base URL and internet connection.");
    }
    throw netErr;
  }
  const body = await res.text();
  log?.("fynd-platform-oauth", "Response", `status=${res.status}`);
  if (!res.ok) {
    const hint = res.status === 401 ? " Check Company ID, Client ID & Secret." : res.status >= 500 ? " Fynd server error. Try again later." : "";
    throw new Error(`Fynd Platform OAuth error ${res.status}: ${(body || "Unknown error").slice(0, 200)}${hint}`);
  }
  const data = JSON.parse(body) as { access_token?: string };
  if (!data.access_token) throw new Error("No access_token in OAuth response");
  return data.access_token;
}

/**
 * Test Platform connection using raw OAuth + fetch (same flow as CURL).
 * Bypasses FDK to avoid 403 when FDK uses different auth/signing.
 */
export async function testPlatformConnectionRaw(
  settings: {
    fyndEnvironment?: string | null;
    fyndCustomBaseUrl?: string | null;
    fyndCompanyId?: string | null;
    fyndApplicationId?: string | null;
    fyndCredentials?: string | null;
  },
  log?: FyndLogFn
): Promise<{ ok: true; warning?: string } | { ok: false; error: string }> {
  const baseUrl = getFyndBaseUrl(settings);
  const companyId = settings?.fyndCompanyId?.trim();
  const applicationId = settings?.fyndApplicationId?.trim();
  if (!companyId || !applicationId) {
    return { ok: false, error: "Company ID and Application ID are required." };
  }
  const parsed = parseStoredCredentials(settings.fyndCredentials, log);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const platform = parsed.credentials.platform;
  if (!platform) {
    return { ok: false, error: "Platform credentials (Client ID & Secret) are required." };
  }

  try {
    const token = await fetchFyndPlatformToken(baseUrl, companyId, platform.clientId, platform.clientSecret, log);
    const path = `/service/platform/order/v1.0/company/${companyId}/application/${applicationId}/orders/shipments/reasons/return`;
    const url = `${baseUrl}${path}`;
    log?.("fynd-test-raw", "Request", `GET ${path}`);
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
      },
    });
    const text = await res.text();
    log?.("fynd-test-raw", "Response", `status=${res.status}`);
    if (res.ok) {
      return { ok: true };
    }
    if (res.status === 404) {
      return { ok: true, warning: "Credentials valid. Return reasons endpoint not available in this Fynd environment—using admin-configured reasons." };
    }
    const hint =
      res.status === 401
        ? " Check Company ID, Client ID & Secret."
        : res.status === 403
          ? " Your OAuth app needs company/orders/read and company/orders/write scopes in Fynd Partners."
          : res.status >= 500
            ? " Fynd server error. Try again later."
            : "";
    return { ok: false, error: `Fynd API ${res.status}: ${(text || "Unknown error").slice(0, 150)}${hint}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

export class FyndPlatformClient {
  constructor(
    private baseUrl: string,
    private companyId: string,
    private applicationId: string,
    private accessToken: string,
    private log?: FyndLogFn
  ) {}

  private get basePath() {
    return `/service/platform/order/v1.0/company/${this.companyId}/application/${this.applicationId}`;
  }

  private async request(method: string, path: string, body?: unknown) {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.accessToken}`,
    };
    this.log?.("fynd-platform", "Request", `${method} ${path}`);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch (netErr) {
      const m = netErr instanceof Error ? netErr.message : String(netErr);
      if (m.includes("fetch") || m.includes("network") || m.includes("ECONNREFUSED") || m.includes("ETIMEDOUT") || m.includes("ENOTFOUND")) {
        throw new Error("Network error: Could not reach Fynd API. Check base URL, firewall, and internet connection.");
      }
      throw netErr;
    }
    const text = await res.text();
    if (!res.ok) {
      const hint =
        res.status === 401
          ? " Invalid or expired credentials. Check Company ID, Client ID & Secret in Settings → Integrations."
          : res.status === 403
            ? " Fynd returned 403 Forbidden—your app may lack required scopes (company/orders/read, company/orders/write). Grant these in Fynd Platform and re-save credentials."
            : res.status >= 500
              ? " Fynd server error. Try again later."
              : "";
      throw new Error(`Fynd Platform API error ${res.status}: ${(text || "Unknown error").slice(0, 300)}${hint}`);
    }
    return text ? (JSON.parse(text) as unknown) : null;
  }

  async getReturnReasons() {
    return this.request("GET", `${this.basePath}/orders/returns/reasons`);
  }

  /** Get shipments for an order (orderId = Fynd order/shipment ID) */
  async getShipments(orderId: string): Promise<unknown> {
    return this.request("GET", `${this.basePath}/orders/${encodeURIComponent(orderId)}/shipments`);
  }

  /** Search shipments by external_order_id (Shopify order name). Uses portal order-manage API. */
  async searchShipmentsByExternalOrderId(
    externalOrderId: string,
    params?: Partial<ShipmentsListingParams>
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
    const res = await this.request("GET", path);
    const body = res as { items?: unknown[]; shipments?: unknown[]; data?: { items?: unknown[] }; order?: { id?: string }; results?: unknown[] };
    const items = body?.items ?? body?.shipments ?? body?.data?.items ?? body?.results ?? [];
    const first = Array.isArray(items) ? items[0] : null;
    const firstObj = first && typeof first === "object" ? first as Record<string, unknown> : null;
    const { orderId, shipmentId } = this.parseInternalIdsFromShipment(firstObj);
    return {
      ...body,
      orderId: orderId ?? undefined,
      shipmentId: shipmentId ?? undefined,
    };
  }

  /** Prefer internal numeric IDs; platform order API rejects external IDs (e.g. FYMP...). */
  private parseInternalIdsFromShipment(obj: Record<string, unknown> | null): { orderId: string | null; shipmentId: string | null } {
    if (!obj) return { orderId: null, shipmentId: null };
    const str = (v: unknown) => (v != null && typeof v === "string" ? v.trim() : null);
    const raw = [
      str(obj.id),
      str(obj.shipment_id ?? obj.shipmentId ?? obj.channel_shipment_id),
      str(obj.order_id ?? obj.orderId ?? obj.bag_id ?? obj.bagId ?? obj.channel_bag_id),
    ].filter((x): x is string => !!x);
    const internal = raw.find((s) => /^\d+$/.test(s));
    const anyNonExternal = raw.find((s) => !/^FY[A-Z0-9]{10,}/i.test(s));
    const chosen = internal ?? anyNonExternal ?? null;
    if (!chosen) return { orderId: null, shipmentId: null };
    const orderId = str(obj.order_id ?? obj.orderId ?? obj.bag_id ?? obj.channel_bag_id) ?? chosen;
    const shipmentId = str(obj.id ?? obj.shipment_id ?? obj.shipmentId ?? obj.channel_shipment_id) ?? chosen;
    const use = (a: string) => (/^\d+$/.test(a) ? a : chosen);
    return { orderId: use(orderId), shipmentId: use(shipmentId) };
  }

  /** Update shipment status (e.g. return_initiated to create return on Fynd) */
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
    return this.request("PUT", `${this.basePath}/orders/${encodeURIComponent(orderId)}/shipments/status`, payload);
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
}

// --- Storefront API (Basic auth) ---

export class FyndStorefrontClient {
  constructor(
    private baseUrl: string,
    private applicationId: string,
    private applicationToken: string,
    private log?: FyndLogFn
  ) {}

  private get basicAuth() {
    return Buffer.from(`${this.applicationId}:${this.applicationToken}`).toString("base64");
  }

  private async request(method: string, path: string) {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Basic ${this.basicAuth}`,
    };
    this.log?.("fynd-storefront", "Request", `GET ${path}`);
    let res: Response;
    try {
      res = await fetch(url, { method, headers });
    } catch (netErr) {
      const m = netErr instanceof Error ? netErr.message : String(netErr);
      if (m.includes("fetch") || m.includes("network") || m.includes("ECONNREFUSED") || m.includes("ETIMEDOUT") || m.includes("ENOTFOUND")) {
        throw new Error("Network error: Could not reach Fynd API. Check base URL and internet connection.");
      }
      throw netErr;
    }
    const body = await res.text();
    if (!res.ok) {
      const hint =
        res.status === 401
          ? " Invalid Application Token. Check credentials in Fynd Platform."
          : res.status === 403
            ? " Access denied. Check Application Token and permissions."
            : res.status >= 500
              ? " Fynd server error. Try again later."
              : "";
      throw new Error(`Fynd Storefront API error ${res.status}: ${(body || "Unknown error").slice(0, 300)}${hint}`);
    }
    return body ? (JSON.parse(body) as unknown) : null;
  }

  async getLanguages() {
    return this.request("GET", "/service/application/configuration/v1.0/languages");
  }

  async getBagReasons() {
    return this.request("GET", "/service/application/order/v1.0/bag/reasons");
  }

  async testConnection() {
    await this.getLanguages();
  }
}

// --- Credential types and factory ---

export type FyndCredentials = {
  apiType?: "platform" | "storefront";
  accessToken?: string;
  token?: string;
  clientId?: string;
  clientSecret?: string;
  applicationToken?: string;
  /** New shape: both Platform and Storefront can be present */
  platform?: { clientId: string; clientSecret: string };
  storefront?: { applicationToken: string };
};

export type NormalizedFyndCreds = {
  platform?: { clientId: string; clientSecret: string };
  storefront?: { applicationToken: string };
};

function normalizeCredentials(credentials: FyndCredentials): NormalizedFyndCreds {
  const out: NormalizedFyndCreds = {};
  const p = credentials.platform as { clientId?: string; clientSecret?: string; client_id?: string; client_secret?: string } | undefined;
  const cId = p?.clientId ?? p?.client_id ?? credentials.clientId ?? (credentials as { client_id?: string }).client_id;
  const cSec = p?.clientSecret ?? p?.client_secret ?? credentials.clientSecret ?? (credentials as { client_secret?: string }).client_secret;
  if (cId && cSec) {
    out.platform = { clientId: String(cId).trim(), clientSecret: String(cSec).trim() };
  }
  const tok = credentials.storefront?.applicationToken ?? credentials.applicationToken ?? (credentials as { application_token?: string }).application_token;
  if (tok) {
    out.storefront = { applicationToken: String(tok).trim() };
  }
  return out;
}

function parseStoredCredentials(
  raw: string | null | undefined,
  log?: FyndLogFn
): { ok: true; credentials: NormalizedFyndCreds } | { ok: false; error: string } {
  if (!raw || String(raw).trim() === "") {
    return { ok: false, error: "Fynd credentials are not set. Enter Client ID & Secret (Platform) and/or Application Token (Storefront) in Settings → Integrations." };
  }
  let parsed: FyndCredentials = {};
  try {
    const s = String(raw).trim();
    if (s.startsWith("{")) {
      parsed = JSON.parse(s) as FyndCredentials;
    } else if (s.includes(":")) {
      try {
        parsed = JSON.parse(decrypt(s)) as FyndCredentials;
      } catch (decErr) {
        log?.("fynd-client", "Decrypt failed", decErr instanceof Error ? decErr.message : String(decErr));
        return { ok: false, error: "Could not read stored credentials (wrong ENCRYPTION_KEY or corrupted). Re-save credentials in Settings → Integrations." };
      }
    } else {
      parsed = JSON.parse(s || "{}") as FyndCredentials;
    }
  } catch (parseErr) {
    log?.("fynd-client", "Parse failed", parseErr instanceof Error ? parseErr.message : String(parseErr));
    return { ok: false, error: "Stored Fynd credentials are invalid. Re-save them in Settings → Integrations." };
  }
  const credentials = normalizeCredentials(parsed);
  return { ok: true, credentials };
}

/** Parse stored credentials for merging (e.g. in settings save). Returns null if empty or invalid. */
export function getNormalizedCredentialsFromRaw(raw: string | null | undefined): NormalizedFyndCreds | null {
  const result = parseStoredCredentials(raw);
  return result.ok ? result.credentials : null;
}

/** Result when we need a Platform client but got Storefront or null */
export type FyndClientResult =
  | { ok: true; client: FyndPlatformClient | FyndPlatformClientFDK | FyndStorefrontClient | FyndStorefrontClientFDK }
  | { ok: false; error: string };

/**
 * Create Fynd client by requirement: use Platform when requirePlatform, Storefront when requireStorefront,
 * otherwise prefer Platform then Storefront. Supports storing both credential sets and picks the right one per operation.
 */
export async function createFyndClientOrError(
  settings: FyndSettings & { fyndApiType?: string | null },
  options?: { requirePlatform?: boolean; requireStorefront?: boolean; log?: FyndLogFn }
): Promise<FyndClientResult> {
  const log = options?.log;
  const requirePlatform = options?.requirePlatform ?? false;
  const requireStorefront = options?.requireStorefront ?? false;

  if (!settings?.fyndApplicationId) {
    return { ok: false, error: "Fynd Application ID is missing. Set it in Settings → Integrations." };
  }
  const baseUrl = getFyndBaseUrl(settings);
  log?.("fynd-client", "Base URL", baseUrl);

  const parsed = parseStoredCredentials(settings.fyndCredentials, log);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const credentials = parsed.credentials;

  if (requirePlatform) {
    if (!credentials.platform) {
      return {
        ok: false,
        error:
          "Creating returns and refreshing details require Platform API (Company ID + Client ID & Secret). " +
          "Add them in Settings → Integrations (Platform section) and Save. If already configured, try re-entering Client ID & Secret and Save again.",
      };
    }
    if (!settings?.fyndCompanyId) {
      return { ok: false, error: "Fynd Company ID is missing. Set it in Settings → Integrations (Platform API)." };
    }
    try {
      const fdk = createFyndPlatformClient({
        companyId: settings.fyndCompanyId,
        applicationId: settings.fyndApplicationId,
        apiKey: credentials.platform.clientId,
        apiSecret: credentials.platform.clientSecret,
        domain: getFyndDomain(settings),
        log,
      });
      const client = new FyndPlatformClientFDK(
        fdk,
        settings.fyndCompanyId,
        settings.fyndApplicationId,
        log
      );
      return { ok: true, client };
    } catch (tokenErr) {
      const msg = tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
      log?.("fynd-client", "FDK init failed", msg);
      return { ok: false, error: `Fynd login failed: ${msg}. Check Company ID, Client ID & Secret and environment (UAT/Prod) in Settings → Integrations.` };
    }
  }

  if (requireStorefront) {
    if (!credentials.storefront) {
      return { ok: false, error: "Storefront API requires an Application Token. Add Storefront credentials in Settings → Integrations." };
    }
    try {
      const appClient = createFyndApplicationClient({
        applicationId: settings.fyndApplicationId,
        applicationToken: credentials.storefront.applicationToken,
        domain: getFyndDomain(settings),
        log,
      });
      const client = new FyndStorefrontClientFDK(appClient, log);
      return { ok: true, client };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, error: `Fynd Storefront setup failed: ${msg}` };
    }
  }

  // Prefer Platform, then Storefront (for generic/createFyndClient usage)
  if (credentials.platform && settings?.fyndCompanyId) {
    try {
      const fdk = createFyndPlatformClient({
        companyId: settings.fyndCompanyId,
        applicationId: settings.fyndApplicationId,
        apiKey: credentials.platform.clientId,
        apiSecret: credentials.platform.clientSecret,
        domain: getFyndDomain(settings),
        log,
      });
      const client = new FyndPlatformClientFDK(
        fdk,
        settings.fyndCompanyId,
        settings.fyndApplicationId,
        log
      );
      return { ok: true, client };
    } catch {
      // fall through to Storefront if FDK fails
    }
  }
  if (credentials.storefront) {
    try {
      const appClient = createFyndApplicationClient({
        applicationId: settings.fyndApplicationId,
        applicationToken: credentials.storefront.applicationToken,
        domain: getFyndDomain(settings),
        log,
      });
      const client = new FyndStorefrontClientFDK(appClient, log);
      return { ok: true, client };
    } catch {
      // fall through to error
    }
  }

  return { ok: false, error: "Fynd credentials are not set. Enter Client ID & Secret (Platform) and/or Application Token (Storefront) in Settings → Integrations." };
}

export async function createFyndClient(
  settings: FyndSettings,
  log?: FyndLogFn
): Promise<FyndPlatformClient | FyndPlatformClientFDK | FyndStorefrontClient | FyndStorefrontClientFDK | null> {
  const result = await createFyndClientOrError(settings as FyndSettings & { fyndApiType?: string | null }, { requirePlatform: false, log });
  return result.ok ? result.client : null;
}
