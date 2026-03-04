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

/** Extract Fynd internal order/shipment IDs from a shipment object. Prefers FY-prefixed IDs. */
export function parseShipmentInternalIds(obj: Record<string, unknown> | null): { orderId: string | null; shipmentId: string | null } {
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

// --- Platform API (OAuth client_credentials) ---

const TOKEN_CACHE_MAX_SIZE = 50;
const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const TOKEN_CACHE_TTL_MS = 50 * 60 * 1000;

function pruneTokenCache() {
  if (tokenCache.size <= TOKEN_CACHE_MAX_SIZE) return;
  const now = Date.now();
  for (const [key, val] of tokenCache) {
    if (val.expiresAt < now) tokenCache.delete(key);
  }
  if (tokenCache.size <= TOKEN_CACHE_MAX_SIZE) return;
  const entries = [...tokenCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
  const toRemove = entries.slice(0, entries.length - TOKEN_CACHE_MAX_SIZE);
  for (const [key] of toRemove) tokenCache.delete(key);
}

export async function fetchFyndPlatformToken(
  baseUrl: string,
  companyId: string,
  clientId: string,
  clientSecret: string,
  log?: FyndLogFn
): Promise<string> {
  const cacheKey = `${baseUrl}:${companyId}:${clientId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    log?.("fynd-platform-oauth", "Using cached token", `expires in ${Math.round((cached.expiresAt - Date.now()) / 1000)}s`);
    return cached.token;
  }
  const url = `${baseUrl}/service/panel/authentication/v1.0/company/${companyId}/oauth/token`;
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  log?.("fynd-platform-oauth", "Fetching token", `url=${url}`);
  const OAUTH_TIMEOUT_MS = 5_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Basic ${basicAuth}`,
      },
      body: JSON.stringify({ grant_type: "client_credentials" }),
      signal: controller.signal,
    });
  } catch (netErr) {
    clearTimeout(timer);
    if (netErr instanceof Error && netErr.name === "AbortError") {
      throw new Error(`Fynd OAuth timed out after ${OAUTH_TIMEOUT_MS}ms`);
    }
    const m = netErr instanceof Error ? netErr.message : String(netErr);
    if (m.includes("fetch") || m.includes("network") || m.includes("ECONNREFUSED") || m.includes("ETIMEDOUT") || m.includes("ENOTFOUND")) {
      throw new Error("Network error: Could not reach Fynd OAuth. Check base URL and internet connection.");
    }
    throw netErr;
  }
  clearTimeout(timer);
  const body = await res.text();
  log?.("fynd-platform-oauth", "Response", `status=${res.status}`);
  if (!res.ok) {
    const hint = res.status === 401 ? " Check Company ID, Client ID & Secret." : res.status >= 500 ? " Fynd server error. Try again later." : "";
    throw new Error(`Fynd Platform OAuth error ${res.status}: ${(body || "Unknown error").slice(0, 200)}${hint}`);
  }
  const data = JSON.parse(body) as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error("No access_token in OAuth response");
  const ttl = data.expires_in ? Math.min(data.expires_in * 1000, TOKEN_CACHE_TTL_MS) : TOKEN_CACHE_TTL_MS;
  tokenCache.set(cacheKey, { token: data.access_token, expiresAt: Date.now() + ttl });
  pruneTokenCache();
  return data.access_token;
}

/**
 * Test Platform connection using raw OAuth + fetch.
 * Uses Platform Order API: GET orders-listing (docs.fynd.com/partners/commerce/sdk/latest/platform/company/order).
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
  if (!companyId) {
    return { ok: false, error: "Company ID is required." };
  }
  const parsed = parseStoredCredentials(settings.fyndCredentials, log);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const platform = parsed.credentials.platform;
  if (!platform) {
    return { ok: false, error: "Platform credentials (Client ID & Secret) are required." };
  }

  try {
    const token = await fetchFyndPlatformToken(baseUrl, companyId, platform.clientId, platform.clientSecret, log);
    const path = `/service/platform/order/v1.0/company/${companyId}/orders-listing?page_no=1&page_size=1`;
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

  /** Platform Order API base path (docs.fynd.com/partners/commerce/sdk/latest/platform/company/order) */
  private get platformOrderPath() {
    return `/service/platform/order/v1.0/company/${this.companyId}`;
  }

  /** Platform Order-manage API base path (for status-internal, etc.) */
  private get platformOrderManagePath() {
    return `/service/platform/order-manage/v1.0/company/${this.companyId}`;
  }

  private static readonly REQUEST_TIMEOUT_MS = 5_000;

  private async request(method: string, path: string, body?: unknown) {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.accessToken}`,
    };
    this.log?.("fynd-platform", "Request", `${method} ${path}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FyndPlatformClient.REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        signal: controller.signal,
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    } catch (netErr) {
      clearTimeout(timer);
      const m = netErr instanceof Error ? netErr.message : String(netErr);
      if (netErr instanceof Error && netErr.name === "AbortError") {
        throw new Error(`Fynd API timed out after ${FyndPlatformClient.REQUEST_TIMEOUT_MS}ms: ${method} ${path}`);
      }
      if (m.includes("fetch") || m.includes("network") || m.includes("ECONNREFUSED") || m.includes("ETIMEDOUT") || m.includes("ENOTFOUND")) {
        throw new Error("Network error: Could not reach Fynd API. Check base URL, firewall, and internet connection.");
      }
      throw netErr;
    }
    clearTimeout(timer);
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

  /**
   * Platform Order API has no company-level return reasons.
   * Bag-level reasons require shipment_id, bag_id, state.
   * Validates connection via orders-listing; returns null (use admin-configured reasons).
   */
  async getReturnReasons(): Promise<unknown> {
    await this.request("GET", `${this.platformOrderPath}/orders-listing?page_no=1&page_size=1`);
    return null;
  }

  /** Get order details including shipments. Uses Platform Order API: GET order-details. */
  async getShipments(orderId: string): Promise<unknown> {
    const res = await this.request("GET", `${this.platformOrderPath}/order-details?order_id=${encodeURIComponent(orderId)}`);
    const body = res as { order?: unknown; shipments?: unknown[] };
    return body?.shipments ?? body?.order ?? res;
  }

  /** Search shipments by external_order_id. Uses Platform Order API: GET shipments-listing. */
  async searchShipmentsByExternalOrderId(
    externalOrderId: string,
    params?: Partial<ShipmentsListingParams>
  ): Promise<{ items?: unknown[]; shipments?: unknown[]; data?: { items?: unknown[] }; orderId?: string; shipmentId?: string }> {
    const now = new Date();
    const endDate = params?.endDate ?? now.toISOString();
    const startDate = params?.startDate ?? (() => {
      const d = new Date(now);
      d.setMonth(d.getMonth() - 6);
      return d.toISOString();
    })();
    const searchParams = new URLSearchParams({
      group_entity: params?.groupEntity ?? "shipments",
      page_no: String(params?.pageNo ?? 1),
      page_size: String(params?.pageSize ?? 50),
      start_date: startDate,
      end_date: endDate,
      search_value: externalOrderId.trim(),
      search_type: params?.searchType ?? "external_order_id",
      sort_type: params?.sortType ?? "sla_asc",
    });
    if (params?.orderStatus) searchParams.set("bag_status", params.orderStatus);
    const path = `${this.platformOrderPath}/shipments-listing?${searchParams.toString()}`;
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

  private parseInternalIdsFromShipment(obj: Record<string, unknown> | null): { orderId: string | null; shipmentId: string | null } {
    return parseShipmentInternalIds(obj);
  }

  /** Update shipment status (e.g. return_initiated to create return on Fynd). Uses Platform Order API: PUT shipment/status-internal. */
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
    return this.request("PUT", `${this.platformOrderManagePath}/shipment/status-internal`, payload);
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

  private static readonly REQUEST_TIMEOUT_MS = 5_000;

  private async request(method: string, path: string) {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Basic ${this.basicAuth}`,
    };
    this.log?.("fynd-storefront", "Request", `${method} ${path}`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FyndStorefrontClient.REQUEST_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, { method, headers, signal: controller.signal });
    } catch (netErr) {
      clearTimeout(timer);
      if (netErr instanceof Error && netErr.name === "AbortError") {
        throw new Error(`Fynd Storefront API timed out after ${FyndStorefrontClient.REQUEST_TIMEOUT_MS}ms: ${method} ${path}`);
      }
      const m = netErr instanceof Error ? netErr.message : String(netErr);
      if (m.includes("fetch") || m.includes("network") || m.includes("ECONNREFUSED") || m.includes("ETIMEDOUT") || m.includes("ENOTFOUND")) {
        throw new Error("Network error: Could not reach Fynd API. Check base URL and internet connection.");
      }
      throw netErr;
    }
    clearTimeout(timer);
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
 * Create Fynd client. All Fynd operations use Platform API only (OAuth).
 * Storefront API is not used. requirePlatform is always true for return-related operations.
 */
export async function createFyndClientOrError(
  settings: FyndSettings & { fyndApiType?: string | null },
  options?: { requirePlatform?: boolean; requireStorefront?: boolean; log?: FyndLogFn }
): Promise<FyndClientResult> {
  const log = options?.log;
  const requirePlatform = options?.requirePlatform ?? true;
  const requireStorefront = options?.requireStorefront ?? false;

  if (requireStorefront) {
    return { ok: false, error: "Storefront API is not used. All Fynd operations use Platform API only. Configure Platform credentials (Company ID + Client ID & Secret) in Settings → Integrations." };
  }

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
      // Use raw OAuth + fetch (same flow as Test Platform and CURL). FDK uses different auth
      // that can cause 403 on write operations even when reads work.
      const token = await fetchFyndPlatformToken(
        baseUrl,
        settings.fyndCompanyId,
        credentials.platform.clientId,
        credentials.platform.clientSecret,
        log
      );
      const client = new FyndPlatformClient(
        baseUrl,
        settings.fyndCompanyId,
        settings.fyndApplicationId,
        token,
        log
      );
      return { ok: true, client };
    } catch (tokenErr) {
      const msg = tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
      log?.("fynd-client", "Platform OAuth failed", msg);
      return { ok: false, error: `Fynd login failed: ${msg}. Check Company ID, Client ID & Secret and environment (UAT/Prod) in Settings → Integrations.` };
    }
  }

  // Platform only when requirePlatform is false (e.g. generic test)
  if (credentials.platform && settings?.fyndCompanyId) {
    try {
      const token = await fetchFyndPlatformToken(
        baseUrl,
        settings.fyndCompanyId,
        credentials.platform.clientId,
        credentials.platform.clientSecret,
        log
      );
      const client = new FyndPlatformClient(
        baseUrl,
        settings.fyndCompanyId,
        settings.fyndApplicationId,
        token,
        log
      );
      return { ok: true, client };
    } catch (tokenErr) {
      const msg = tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
      log?.("fynd-client", "Platform OAuth failed", msg);
      return { ok: false, error: `Fynd login failed: ${msg}. Check Company ID, Client ID & Secret in Settings → Integrations.` };
    }
  }

  return { ok: false, error: "Fynd Platform credentials are required. Enter Company ID, Client ID & Secret in Settings → Integrations." };
}

export async function createFyndClient(
  settings: FyndSettings,
  log?: FyndLogFn
): Promise<FyndPlatformClient | FyndPlatformClientFDK | FyndStorefrontClient | FyndStorefrontClientFDK | null> {
  const result = await createFyndClientOrError(settings as FyndSettings & { fyndApiType?: string | null }, { requirePlatform: true, log });
  return result.ok ? result.client : null;
}
