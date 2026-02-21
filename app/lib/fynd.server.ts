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
          ? " Invalid or expired credentials. Check Company ID, Client ID & Secret."
          : res.status === 403
            ? " Access denied. Check app permissions in Fynd Platform."
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
  | { ok: true; client: FyndPlatformClient | FyndStorefrontClient }
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
    let accessToken: string;
    try {
      accessToken = await fetchFyndPlatformToken(
        baseUrl,
        settings.fyndCompanyId,
        credentials.platform.clientId,
        credentials.platform.clientSecret,
        log
      );
    } catch (tokenErr) {
      const msg = tokenErr instanceof Error ? tokenErr.message : String(tokenErr);
      log?.("fynd-client", "OAuth failed", msg);
      return { ok: false, error: `Fynd login failed: ${msg}. Check Company ID, Client ID & Secret and environment (UAT/Prod) in Settings → Integrations.` };
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

  if (requireStorefront) {
    if (!credentials.storefront) {
      return { ok: false, error: "Storefront API requires an Application Token. Add Storefront credentials in Settings → Integrations." };
    }
    const client = new FyndStorefrontClient(baseUrl, settings.fyndApplicationId, credentials.storefront.applicationToken, log);
    return { ok: true, client };
  }

  // Prefer Platform, then Storefront (for generic/createFyndClient usage)
  if (credentials.platform && settings?.fyndCompanyId) {
    try {
      const accessToken = await fetchFyndPlatformToken(
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
        accessToken,
        log
      );
      return { ok: true, client };
    } catch {
      // fall through to Storefront if OAuth fails
    }
  }
  if (credentials.storefront) {
    const client = new FyndStorefrontClient(baseUrl, settings.fyndApplicationId, credentials.storefront.applicationToken, log);
    return { ok: true, client };
  }

  return { ok: false, error: "Fynd credentials are not set. Enter Client ID & Secret (Platform) and/or Application Token (Storefront) in Settings → Integrations." };
}

export async function createFyndClient(
  settings: FyndSettings,
  log?: FyndLogFn
): Promise<FyndPlatformClient | FyndStorefrontClient | null> {
  const result = await createFyndClientOrError(settings as FyndSettings & { fyndApiType?: string | null }, { requirePlatform: false, log });
  return result.ok ? result.client : null;
}
