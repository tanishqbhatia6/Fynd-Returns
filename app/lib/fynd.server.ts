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

export async function createFyndClient(
  settings: FyndSettings,
  log?: FyndLogFn
): Promise<FyndPlatformClient | FyndStorefrontClient | null> {
  if (!settings?.fyndApplicationId) {
    log?.("fynd-client", "Missing applicationId");
    return null;
  }
  const baseUrl = getFyndBaseUrl(settings);
  log?.("fynd-client", "Base URL", baseUrl);

  let credentials: FyndCredentials = {};
  const raw = settings.fyndCredentials;
  try {
    if (raw?.startsWith("{")) {
      credentials = JSON.parse(raw) as FyndCredentials;
    } else if (raw?.includes(":")) {
      credentials = JSON.parse(decrypt(raw)) as FyndCredentials;
    } else {
      credentials = JSON.parse(raw || "{}") as FyndCredentials;
    }
  } catch {
    return null;
  }
  const apiType = credentials.apiType || "platform";

  if (apiType === "storefront") {
    const token = credentials.applicationToken;
    if (!token) {
      log?.("fynd-client", "Storefront needs applicationToken");
      return null;
    }
    return new FyndStorefrontClient(baseUrl, settings.fyndApplicationId, token, log);
  }

  // Platform API
  if (!settings?.fyndCompanyId) {
    log?.("fynd-client", "Platform needs companyId");
    return null;
  }
  let accessToken = credentials.accessToken || credentials.token;
  if (!accessToken && credentials.clientId && credentials.clientSecret) {
    accessToken = await fetchFyndPlatformToken(
      baseUrl,
      settings.fyndCompanyId,
      credentials.clientId,
      credentials.clientSecret,
      log
    );
  }
  if (!accessToken) return null;
  return new FyndPlatformClient(
    baseUrl,
    settings.fyndCompanyId,
    settings.fyndApplicationId,
    accessToken,
    log
  );
}
