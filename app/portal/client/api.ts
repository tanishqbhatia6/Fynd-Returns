import type {
  CreateReturnResponse,
  LookupResponse,
  LookupType,
  OrderResponse,
  ProductResponse,
} from "./types";

type FetchOptions = RequestInit & { timeoutMs?: number };

export class PortalApi {
  private readonly baseUrl: string;

  constructor(appUrl: string) {
    this.baseUrl = `${appUrl.replace(/\/$/, "")}/api/portal`;
  }

  async lookup(body: {
    shop: string;
    lookupType: LookupType;
    lookupValue: string;
    portalToken?: string;
    sessionId?: string;
  }) {
    return this.fetchJson<LookupResponse>("/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async verifyOtp(sessionId: string, otp: string) {
    return this.fetchJson<{ portalToken?: string; error?: string }>("/otp/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, otp }),
      timeoutMs: 12000,
    });
  }

  async resendOtp(sessionId: string) {
    return this.fetchJson<{ success?: boolean; error?: string }>("/otp/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
      timeoutMs: 12000,
    });
  }

  async order(shop: string, orderNumber: string) {
    const qs = new URLSearchParams({ shop, orderNumber });
    return this.fetchJson<OrderResponse>(`/order?${qs.toString()}`);
  }

  async createReturn(body: Record<string, unknown>) {
    return this.fetchJson<CreateReturnResponse>("/create-return", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async enrich(body: { shop: string; type?: string; orderName?: string; returnIds?: string[] }) {
    return this.fetchJson<{ fyndData?: unknown; returnEnrichments?: Record<string, unknown> }>(
      "/fynd-enrich",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: 14000,
      },
    );
  }

  async products(shop: string, productId: string) {
    const qs = new URLSearchParams({ shop, productId });
    return this.fetchJson<ProductResponse>(`/products?${qs.toString()}`, { timeoutMs: 14000 });
  }

  async cancelReturn(body: {
    shop: string;
    returnCaseId: string;
    portalToken?: string;
    portalCsrfToken?: string;
    isApproved?: boolean;
  }) {
    return this.fetchJson<{ success?: boolean; flow?: string; error?: string }>("/cancel-return", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      timeoutMs: 18000,
    });
  }

  private async fetchJson<T>(path: string, options: FetchOptions = {}): Promise<T> {
    const controller = options.timeoutMs ? new AbortController() : null;
    const timeout = options.timeoutMs
      ? window.setTimeout(() => controller?.abort(), options.timeoutMs)
      : undefined;
    const { timeoutMs: _timeoutMs, ...fetchOptions } = options;
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...fetchOptions,
        signal: controller?.signal,
      });
      const data = (await response.json().catch(() => ({}))) as T & { error?: string };
      this.captureSecurityTokens(data as { portalCsrfToken?: string; portalToken?: string });
      if (!response.ok) {
        throw new Error(data.error || `Request failed with ${response.status}`);
      }
      return data;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error("Request timed out. Please try again.");
      }
      throw error;
    } finally {
      if (timeout) window.clearTimeout(timeout);
    }
  }

  private captureSecurityTokens(data: { portalCsrfToken?: string; portalToken?: string }) {
    if (data.portalCsrfToken) window.__RPM_PORTAL_CSRF__ = data.portalCsrfToken;
    if (data.portalToken) window.__RPM_AUTH_TOKEN__ = data.portalToken;
  }
}
