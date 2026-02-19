const FYND_API_BASE = process.env.FYND_API_BASE_URL || "https://api.fynd.com";
import { decrypt } from "./encryption.server";

export type FyndLogFn = (step: string, message: string, detail?: string) => void;

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
    const tokenPreview = this.accessToken.length >= 8
      ? `${this.accessToken.slice(0, 4)}...${this.accessToken.slice(-4)}`
      : `[${this.accessToken.length} chars]`;
    this.log?.("fynd-api", "Request", `method=${method} url=${url}`);
    this.log?.("fynd-api", "Headers", `Authorization: Bearer [len:${this.accessToken.length}] | x-access-token: [len:${this.accessToken.length}] | Content-Type: application/json`);
    this.log?.("fynd-api", "Token preview", `length=${this.accessToken.length} value=${tokenPreview}`);
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

export function createFyndClient(
  settings: {
    fyndCompanyId?: string | null;
    fyndApplicationId?: string | null;
    fyndCredentials?: string | null;
  },
  log?: FyndLogFn
): FyndClient | null {
  if (!settings?.fyndCompanyId || !settings?.fyndApplicationId) {
    log?.("fynd-client", "Missing ids", `companyId=${!!settings?.fyndCompanyId} appId=${!!settings?.fyndApplicationId}`);
    return null;
  }
  let credentials: { accessToken?: string; token?: string } = {};
  const raw = settings.fyndCredentials;
  log?.("fynd-client", "Raw credentials", `present=${!!raw} length=${raw?.length ?? 0} hasColon=${raw?.includes(":") ?? false}`);
  try {
    if (raw?.includes(":")) {
      log?.("fynd-client", "Decrypting", "encrypted format (iv:tag:data)");
      credentials = JSON.parse(decrypt(raw));
      log?.("fynd-client", "Decrypt success", `hasAccessToken=${!!credentials.accessToken} hasToken=${!!credentials.token}`);
    } else {
      log?.("fynd-client", "Parsing plain JSON", "no encryption");
      credentials = JSON.parse(raw || "{}");
    }
  } catch (err) {
    log?.("fynd-client", "Decrypt/parse failed", String(err));
    return null;
  }
  const token = credentials.accessToken || credentials.token;
  if (!token) {
    log?.("fynd-client", "No token in credentials", `keys=${Object.keys(credentials).join(",")}`);
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
