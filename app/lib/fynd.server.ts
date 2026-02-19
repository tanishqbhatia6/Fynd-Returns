const FYND_API_BASE = process.env.FYND_API_BASE_URL || "https://api.fynd.com";
import { decrypt } from "./encryption.server";

export type FyndLogFn = (step: string, message: string, detail?: string) => void;

// --- Platform API (OAuth client_credentials) ---
// Docs: https://docs.fynd.com/partners/commerce/sdk/latest/platform/client-libraries
// Auth: Bearer token from POST /oauth/token with Basic base64(client_id:client_secret)

export async function fetchFyndPlatformToken(
  companyId: string,
  clientId: string,
  clientSecret: string,
  log?: FyndLogFn
): Promise<string> {
  const url = `${FYND_API_BASE}/service/panel/authentication/v1.0/company/${companyId}/oauth/token`;
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

/** Platform API client - uses Bearer token from OAuth */
export class FyndPlatformClient {
  constructor(
    private companyId: string,
    private applicationId: string,
    private accessToken: string,
    private log?: FyndLogFn
  ) {}

  private get basePath() {
    return `/service/platform/order/v1.0/company/${this.companyId}/application/${this.applicationId}`;
  }

  private async request(method: string, path: string) {
    const url = `${FYND_API_BASE}${path}`;
    const headers = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.accessToken}`,
    };
    this.log?.("fynd-platform", "Request", `GET ${url}`);
    const res = await fetch(url, { method, headers });
    const body = await res.text();
    if (!res.ok) throw new Error(`Fynd Platform API error ${res.status}: ${body}`);
    return JSON.parse(body);
  }

  async getReturnReasons() {
    return this.request("GET", `${this.basePath}/orders/returns/reasons`);
  }

  async testConnection() {
    await this.getReturnReasons();
  }
}

// --- Storefront API (Basic auth with application_id:application_token) ---
// Docs: https://docs.fynd.com/partners/commerce/sdk/latest/application/client-libraries
// Auth: Authorization: Basic base64(application_id:application_token)

export class FyndStorefrontClient {
  constructor(
    private applicationId: string,
    private applicationToken: string,
    private log?: FyndLogFn
  ) {}

  private get basicAuth() {
    return Buffer.from(`${this.applicationId}:${this.applicationToken}`).toString("base64");
  }

  private async request(method: string, path: string) {
    const url = `${FYND_API_BASE}${path}`;
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

  /** Test: GET /service/application/configuration/v1.0/languages */
  async getLanguages() {
    return this.request("GET", "/service/application/configuration/v1.0/languages");
  }

  /** Bag return reasons - Storefront Order API */
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
  settings: {
    fyndCompanyId?: string | null;
    fyndApplicationId?: string | null;
    fyndCredentials?: string | null;
  },
  log?: FyndLogFn
): Promise<FyndPlatformClient | FyndStorefrontClient | null> {
  if (!settings?.fyndApplicationId) {
    log?.("fynd-client", "Missing applicationId");
    return null;
  }
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
    return new FyndStorefrontClient(settings.fyndApplicationId, token, log);
  }

  // Platform API
  if (!settings?.fyndCompanyId) {
    log?.("fynd-client", "Platform needs companyId");
    return null;
  }
  let accessToken = credentials.accessToken || credentials.token;
  if (!accessToken && credentials.clientId && credentials.clientSecret) {
    accessToken = await fetchFyndPlatformToken(
      settings.fyndCompanyId,
      credentials.clientId,
      credentials.clientSecret,
      log
    );
  }
  if (!accessToken) return null;
  return new FyndPlatformClient(
    settings.fyndCompanyId,
    settings.fyndApplicationId,
    accessToken,
    log
  );
}
