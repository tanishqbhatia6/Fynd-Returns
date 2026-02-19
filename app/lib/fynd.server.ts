const FYND_API_BASE = process.env.FYND_API_BASE_URL || "https://api.fynd.com";
import { decrypt } from "./encryption.server";

export type FyndLogFn = (step: string, message: string, detail?: string) => void;

/** Fetch Platform API access token via OAuth client_credentials (required for Platform APIs) */
export async function fetchFyndAccessToken(
  companyId: string,
  clientId: string,
  clientSecret: string,
  log?: FyndLogFn
): Promise<string> {
  const url = `${FYND_API_BASE}/service/panel/authentication/v1.0/company/${companyId}/oauth/token`;
  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  log?.("fynd-oauth", "Fetching token", `url=${url} basicAuthLen=${basicAuth.length}`);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Basic ${basicAuth}`,
    },
    body: JSON.stringify({ grant_type: "client_credentials" }),
  });
  const body = await res.text();
  log?.("fynd-oauth", "Response", `status=${res.status} body=${body.slice(0, 200)}`);
  if (!res.ok) throw new Error(`Fynd OAuth error ${res.status}: ${body}`);
  const data = JSON.parse(body) as { access_token?: string };
  if (!data.access_token) throw new Error("No access_token in OAuth response");
  log?.("fynd-oauth", "Token obtained", `length=${data.access_token.length}`);
  return data.access_token;
}

export class FyndClient {
  constructor(
    private companyId: string,
    private applicationId: string,
    private accessToken: string,
    private log?: FyndLogFn
  ) {}

  private get basePath() {
    return `/service/platform/order/v1.0/company/${this.companyId}/application/${this.applicationId}`;
  }

  private async request(method: string, path: string, options: RequestInit = {}) {
    const url = `${FYND_API_BASE}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${this.accessToken}`,
      "x-access-token": this.accessToken,
      ...(options.headers as Record<string, string>),
    };
    this.log?.("fynd-api", "Request", `method=${method} url=${url}`);
    this.log?.("fynd-api", "Outgoing headers (full)", JSON.stringify({
      "Content-Type": headers["Content-Type"],
      "Authorization": headers["Authorization"],
      "x-access-token": headers["x-access-token"],
    }, null, 2));
    const start = this.accessToken.slice(0, Math.min(12, this.accessToken.length));
    const end = this.accessToken.length > 12 ? this.accessToken.slice(-12) : "";
    this.log?.("fynd-api", "Token details", `length=${this.accessToken.length} startsWith="${start}" endsWith="${end}"${this.accessToken.length < 50 ? " [WARN: Platform API tokens are usually 100+ chars from OAuth]" : ""}`);
    const res = await fetch(url, {
      method,
      headers,
      ...options,
    });
    const body = await res.text();
    if (!res.ok) {
      const resHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => { resHeaders[k] = v; });
      this.log?.("fynd-api", "Error response", `status=${res.status} body=${body}`);
      this.log?.("fynd-api", "Response headers", JSON.stringify(resHeaders));
      throw new Error(`Fynd API error ${res.status}: ${body}`);
    }
    return JSON.parse(body);
  }

  async getShipmentTracking(shipmentId: string) {
    return this.request("GET", `${this.basePath}/orders/shipments/${shipmentId}/track`);
  }

  async getReturnReasons() {
    return this.request("GET", `${this.basePath}/orders/returns/reasons`);
  }
}

export type FyndCredentials = {
  accessToken?: string;
  token?: string;
  clientId?: string;
  clientSecret?: string;
};

export async function createFyndClient(
  settings: {
    fyndCompanyId?: string | null;
    fyndApplicationId?: string | null;
    fyndCredentials?: string | null;
  },
  log?: FyndLogFn
): Promise<FyndClient | null> {
  if (!settings?.fyndCompanyId || !settings?.fyndApplicationId) {
    log?.("fynd-client", "Missing ids", `companyId=${!!settings?.fyndCompanyId} appId=${!!settings?.fyndApplicationId}`);
    return null;
  }
  let credentials: FyndCredentials = {};
  const raw = settings.fyndCredentials;
  log?.("fynd-client", "Raw credentials", `present=${!!raw} length=${raw?.length ?? 0} hasColon=${raw?.includes(":") ?? false}`);
  try {
    if (raw?.includes(":")) {
      log?.("fynd-client", "Decrypting", "encrypted format (iv:tag:data)");
      credentials = JSON.parse(decrypt(raw)) as FyndCredentials;
      log?.("fynd-client", "Decrypt success", `hasAccessToken=${!!credentials.accessToken} hasClientId=${!!credentials.clientId}`);
    } else {
      log?.("fynd-client", "Parsing plain JSON", "no encryption");
      credentials = JSON.parse(raw || "{}") as FyndCredentials;
    }
  } catch (err) {
    log?.("fynd-client", "Decrypt/parse failed", String(err));
    return null;
  }
  let token = credentials.accessToken || credentials.token;
  if (!token && credentials.clientId && credentials.clientSecret) {
    log?.("fynd-client", "Using OAuth", "Fetching token via client_credentials");
    token = await fetchFyndAccessToken(
      settings.fyndCompanyId,
      credentials.clientId,
      credentials.clientSecret,
      log
    );
  }
  if (!token) {
    log?.("fynd-client", "No token", `keys=${Object.keys(credentials).join(",")}. Platform API needs access_token OR clientId+clientSecret.`);
    return null;
  }
  log?.("fynd-client", "Client created", `tokenLength=${token.length}`);
  return new FyndClient(
    settings.fyndCompanyId,
    settings.fyndApplicationId,
    token,
    log
  );
}
