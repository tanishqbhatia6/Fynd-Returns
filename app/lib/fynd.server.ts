const FYND_API_BASE = process.env.FYND_API_BASE_URL || "https://api.fynd.com";
import { decrypt } from "./encryption.server";

export class FyndClient {
  constructor(
    private companyId: string,
    private applicationId: string,
    private accessToken: string
  ) {}

  private get basePath() {
    return `/service/platform/order/v1.0/company/${this.companyId}/application/${this.applicationId}`;
  }

  private async request(method: string, path: string, options: RequestInit = {}) {
    const url = `${FYND_API_BASE}${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.accessToken}`,
        "x-access-token": this.accessToken,
        ...(options.headers as Record<string, string>),
      },
      ...options,
    });
    if (!res.ok) {
      throw new Error(`Fynd API error ${res.status}: ${await res.text()}`);
    }
    return res.json();
  }

  async getShipmentTracking(shipmentId: string) {
    return this.request("GET", `${this.basePath}/orders/shipments/${shipmentId}/track`);
  }

  async getReturnReasons() {
    return this.request("GET", `${this.basePath}/orders/returns/reasons`);
  }
}

export function createFyndClient(settings: {
  fyndCompanyId?: string | null;
  fyndApplicationId?: string | null;
  fyndCredentials?: string | null;
}): FyndClient | null {
  if (!settings?.fyndCompanyId || !settings?.fyndApplicationId) return null;
  let credentials: { accessToken?: string; token?: string } = {};
  try {
    const raw = settings.fyndCredentials;
    if (raw?.includes(":")) {
      credentials = JSON.parse(decrypt(raw));
    } else {
      credentials = JSON.parse(raw || "{}");
    }
  } catch {
    // ignore
  }
  const token = credentials.accessToken || credentials.token;
  if (!token) return null;
  return new FyndClient(
    settings.fyndCompanyId,
    settings.fyndApplicationId,
    token
  );
}
