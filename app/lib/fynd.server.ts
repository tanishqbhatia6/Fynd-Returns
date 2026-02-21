import { decrypt } from "./encryption.server";
import { getFyndBaseUrl } from "./fynd-config.server";

export type FyndLogFn = (step: string, message: string, detail?: string) => void;

export type FyndSettings = {
  fyndEnvironment?: string | null;
  fyndCustomBaseUrl?: string | null;
  fyndCompanyId?: string | null;
  fyndApplicationId?: string | null;
  fyndCredentials?: string | null;
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
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${basicAuth}`,
    },
    body: JSON.stringify({ grant_type: "client_credentials" }),
  });
  const body = await res.text();
  log?.("fynd-platform-oauth", "Response", `status=${res.status}`);
  if (!res.ok) throw new Error(`Fynd Platform OAuth error ${res.status}: ${body}`);
  const data = JSON.parse(body) as { access_token?: string };
  if (!data.access_token) throw new Error("No access_token in OAuth response");
  return data.access_token;
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
    const res = await fetch(url, {
      method,
      headers,
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Fynd Platform API error ${res.status}: ${text}`);
    return text ? (JSON.parse(text) as unknown) : null;
  }

  async getReturnReasons() {
    return this.request("GET", `${this.basePath}/orders/returns/reasons`);
  }

  /** Get shipments for an order (orderId = Fynd order ID, often matches Shopify order name) */
  async getShipments(orderId: string): Promise<unknown> {
    return this.request("GET", `${this.basePath}/orders/${encodeURIComponent(orderId)}/shipments`);
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

  async testConnection() {
    await this.getReturnReasons();
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
    const res = await fetch(url, { method, headers });
    const body = await res.text();
    if (!res.ok) throw new Error(`Fynd Storefront API error ${res.status}: ${body}`);
    return JSON.parse(body);
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
};

/** Result when we need a Platform client but got Storefront or null */
export type FyndClientResult =
  | { ok: true; client: FyndPlatformClient | FyndStorefrontClient }
  | { ok: false; error: string };

/**
 * Create Fynd client and return it or a clear error (e.g. "Storefront configured" or "Credentials invalid").
 * Use this when you need getShipments (Platform only) and want to show a specific message.
 */
export async function createFyndClientOrError(
  settings: FyndSettings & { fyndApiType?: string | null },
  options?: { requirePlatform?: boolean; log?: FyndLogFn }
): Promise<FyndClientResult> {
  const log = options?.log;
  const requirePlatform = options?.requirePlatform ?? false;

  if (!settings?.fyndApplicationId) {
    return { ok: false, error: "Fynd Application ID is missing. Set it in Settings → Integrations." };
  }
  const baseUrl = getFyndBaseUrl(settings);
  log?.("fynd-client", "Base URL", baseUrl);

  let credentials: FyndCredentials = {};
  const raw = settings.fyndCredentials;
  if (!raw || String(raw).trim() === "") {
    return { ok: false, error: "Fynd credentials are not set. Enter Client ID & Secret (Platform) or Application Token (Storefront) in Settings → Integrations." };
  }
  try {
    const s = String(raw).trim();
    if (s.startsWith("{")) {
      credentials = JSON.parse(s) as FyndCredentials;
    } else if (s.includes(":")) {
      try {
        credentials = JSON.parse(decrypt(s)) as FyndCredentials;
      } catch (decErr) {
        log?.("fynd-client", "Decrypt failed", decErr instanceof Error ? decErr.message : String(decErr));
        return { ok: false, error: "Could not read stored credentials (wrong ENCRYPTION_KEY or corrupted). Re-save Client ID & Secret in Settings → Integrations." };
      }
    } else {
      credentials = JSON.parse(s || "{}") as FyndCredentials;
    }
  } catch (parseErr) {
    log?.("fynd-client", "Parse failed", parseErr instanceof Error ? parseErr.message : String(parseErr));
    return { ok: false, error: "Stored Fynd credentials are invalid. Re-save them in Settings → Integrations." };
  }

  const apiType = (credentials.apiType ?? settings.fyndApiType ?? "platform").toLowerCase();

  if (apiType === "storefront") {
    const token = credentials.applicationToken;
    if (!token) {
      return { ok: false, error: "Storefront Application Token is missing. Set it in Settings → Integrations." };
    }
    const client = new FyndStorefrontClient(baseUrl, settings.fyndApplicationId, token, log);
    if (requirePlatform) {
      return { ok: false, error: "Creating returns and refreshing details require Platform API (Company ID + Client ID & Secret). You have Storefront configured. Switch to Platform in Settings → Integrations." };
    }
    return { ok: true, client };
  }

  if (!settings?.fyndCompanyId) {
    return { ok: false, error: "Fynd Company ID is missing. Set it in Settings → Integrations (Platform API)." };
  }
  let accessToken = credentials.accessToken ?? credentials.token;
  if (!accessToken && credentials.clientId && credentials.clientSecret) {
    try {
      accessToken = await fetchFyndPlatformToken(
        baseUrl,
        settings.fyndCompanyId,
        credentials.clientId,
        credentials.clientSecret,
        log
      );
    } catch (tokenErr) {
      const msg = tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
      log?.("fynd-client", "OAuth failed", msg);
      return { ok: false, error: `Fynd login failed: ${msg}. Check Company ID, Client ID & Secret and environment (UAT/Prod) in Settings → Integrations.` };
    }
  }
  if (!accessToken) {
    return { ok: false, error: "Fynd Platform credentials incomplete. Enter Client ID & Secret in Settings → Integrations and save." };
  }
  const client = new FyndPlatformClient(
    baseUrl,
    settings.fyndCompanyId,
    settings.fyndApplicationId,
    accessToken,
    log
  );
  return { ok: true, client };
}

export async function createFyndClient(
  settings: FyndSettings,
  log?: FyndLogFn
): Promise<FyndPlatformClient | FyndStorefrontClient | null> {
  const result = await createFyndClientOrError(settings as FyndSettings & { fyndApiType?: string | null }, { requirePlatform: false, log });
  return result.ok ? result.client : null;
}
