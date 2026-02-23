/**
 * Fynd Platform Webhook API — Register and list webhook subscribers.
 * @see https://docs.fynd.com/partners/commerce/sdk/latest/platform/company/webhook
 */

import { getFyndBaseUrl } from "./fynd-config.server";
import { fetchFyndPlatformToken } from "./fynd.server";
import { decrypt } from "./encryption.server";
import type { FyndLogFn } from "./fynd.server";

/** Events we subscribe to for return/refund automation */
export const FYND_WEBHOOK_EVENTS = [
  { event_category: "application", event_name: "refund", event_type: "refund_initiated", version: 1 },
  { event_category: "application", event_name: "refund", event_type: "refund_pending", version: 1 },
  { event_category: "application", event_name: "refund", event_type: "refund_done", version: 1 },
  { event_category: "application", event_name: "refund", event_type: "refund_failed", version: 1 },
  { event_category: "application", event_name: "shipment", event_type: "update", version: 1 },
  { event_category: "application", event_name: "shipment", event_type: "data_update", version: 1 },
] as const;

export type FyndSubscriber = {
  id: number;
  name: string;
  webhook_url: string;
  status?: string;
  provider?: string;
  email_id?: string;
  created_on?: string;
  updated_on?: string;
  event_configs?: Array<{ event_name?: string; event_type?: string; event_category?: string }>;
};

export type ListSubscribersResult =
  | { ok: true; subscribers: FyndSubscriber[]; total: number }
  | { ok: false; error: string };

export type RegisterWebhookResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

function parseCredentials(fyndCredentials: string | null | undefined, log?: FyndLogFn): { clientId: string; clientSecret: string } | null {
  if (!fyndCredentials?.trim()) return null;
  try {
    const raw = String(fyndCredentials).trim();
    const parsed = raw.startsWith("{") ? JSON.parse(raw) : JSON.parse(decrypt(raw));
    const platform = parsed?.platform ?? parsed;
    const clientId = platform?.clientId ?? platform?.client_id;
    const clientSecret = platform?.clientSecret ?? platform?.client_secret;
    if (clientId && clientSecret) return { clientId: String(clientId).trim(), clientSecret: String(clientSecret).trim() };
  } catch (e) {
    log?.("fynd-webhook-api", "Parse credentials failed", e instanceof Error ? e.message : String(e));
  }
  return null;
}

/** List webhook subscribers for the company */
export async function listFyndWebhookSubscribers(
  settings: {
    fyndEnvironment?: string | null;
    fyndCustomBaseUrl?: string | null;
    fyndCompanyId?: string | null;
    fyndApplicationId?: string | null;
    fyndCredentials?: string | null;
  },
  log?: FyndLogFn
): Promise<ListSubscribersResult> {
  const baseUrl = getFyndBaseUrl(settings);
  const companyId = settings?.fyndCompanyId?.trim();
  if (!companyId) return { ok: false, error: "Company ID is required." };

  const creds = parseCredentials(settings.fyndCredentials, log);
  if (!creds) return { ok: false, error: "Fynd credentials are not configured." };

  try {
    const token = await fetchFyndPlatformToken(baseUrl, companyId, creds.clientId, creds.clientSecret, log);
    const path = `/service/platform/webhook/v1.0/company/${companyId}/subscriber/?page_no=1&page_size=50`;
    const url = `${baseUrl}${path}`;
    log?.("fynd-webhook-api", "List subscribers", path);

    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
    });

    const text = await res.text();
    if (!res.ok) {
      const hint =
        res.status === 403
          ? " Your OAuth app may need company/webhooks or company/settings scope. Check Fynd Partners."
          : res.status === 401
            ? " Invalid credentials."
            : "";
      return { ok: false, error: `Fynd Webhook API ${res.status}: ${(text || "Unknown error").slice(0, 200)}${hint}` };
    }

    const data = JSON.parse(text || "{}") as {
      items?: Array<{
        id?: number;
        name?: string;
        webhook_url?: string;
        status?: string;
        provider?: string;
        email_id?: string;
        created_on?: string;
        updated_on?: string;
        event_configs?: Array<{ event_name?: string; event_type?: string; event_category?: string }>;
      }>;
      page?: { item_total?: number };
    };

    const items = data?.items ?? [];
    const subscribers: FyndSubscriber[] = items.map((i) => ({
      id: i.id ?? 0,
      name: i.name ?? "Unknown",
      webhook_url: i.webhook_url ?? "",
      status: i.status,
      provider: i.provider,
      email_id: i.email_id,
      created_on: i.created_on,
      updated_on: i.updated_on,
      event_configs: i.event_configs,
    }));

    return { ok: true, subscribers, total: data?.page?.item_total ?? subscribers.length };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.("fynd-webhook-api", "List error", msg);
    return { ok: false, error: msg };
  }
}

/** Check if our webhook URL is already registered */
export function findSubscriberWithUrl(
  subscribers: FyndSubscriber[],
  webhookUrl: string
): FyndSubscriber | undefined {
  const normalized = webhookUrl.replace(/\/$/, "").toLowerCase();
  return subscribers.find((s) => (s.webhook_url ?? "").replace(/\/$/, "").toLowerCase() === normalized);
}

/** Register (upsert) webhook subscriber via Platform Webhook API v3 */
export async function registerFyndWebhook(
  settings: {
    fyndEnvironment?: string | null;
    fyndCustomBaseUrl?: string | null;
    fyndCompanyId?: string | null;
    fyndApplicationId?: string | null;
    fyndCredentials?: string | null;
  },
  webhookUrl: string,
  subscriberName: string,
  notificationEmail: string,
  log?: FyndLogFn
): Promise<RegisterWebhookResult> {
  const baseUrl = getFyndBaseUrl(settings);
  const companyId = settings?.fyndCompanyId?.trim();
  const applicationId = settings?.fyndApplicationId?.trim();

  if (!companyId) return { ok: false, error: "Company ID is required." };
  if (!applicationId) return { ok: false, error: "Application ID is required." };
  if (!webhookUrl?.trim()) return { ok: false, error: "Webhook URL is required." };
  if (!subscriberName?.trim()) return { ok: false, error: "Subscriber name is required." };
  if (!notificationEmail?.trim()) return { ok: false, error: "Notification email is required." };

  const creds = parseCredentials(settings.fyndCredentials, log);
  if (!creds) return { ok: false, error: "Fynd credentials are not configured." };

  const urlClean = webhookUrl.trim().replace(/\/$/, "");
  if (!urlClean.startsWith("https://") && !urlClean.startsWith("http://")) {
    return { ok: false, error: "Webhook URL must start with https:// or http://." };
  }

  try {
    const token = await fetchFyndPlatformToken(baseUrl, companyId, creds.clientId, creds.clientSecret, log);

    const body = {
      webhook_config: {
        notification_email: notificationEmail.trim(),
        name: subscriberName.trim(),
        status: "active",
        association: {
          application_id: [applicationId],
          criteria: "SPECIFIC-EVENTS",
        },
      },
      event_map: {
        rest: {
          webhook_url: urlClean,
          type: "rest",
          events: FYND_WEBHOOK_EVENTS.map((e) => ({ ...e })),
        },
      },
    };

    const path = `/service/platform/webhook/v3.0/company/${companyId}/subscriber/`;
    const apiUrl = `${baseUrl}${path}`;
    log?.("fynd-webhook-api", "Register webhook", path);

    const res = await fetch(apiUrl, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    const text = await res.text();
    if (!res.ok) {
      let errMsg = text || "Unknown error";
      try {
        const parsed = JSON.parse(text) as { message?: string; error?: string };
        errMsg = parsed.message ?? parsed.error ?? errMsg;
      } catch {
        // use raw text
      }
      const hint =
        res.status === 403
          ? " Your OAuth app may need company/webhooks or company/settings scope in Fynd Partners."
          : res.status === 400
            ? " Check webhook URL format and application ID."
            : "";
      return { ok: false, error: `Fynd Webhook API ${res.status}: ${String(errMsg).slice(0, 300)}${hint}` };
    }

    let message = "Webhook registered successfully.";
    try {
      const parsed = JSON.parse(text) as { message?: string };
      if (parsed.message) message = parsed.message;
    } catch {
      // use default
    }

    return { ok: true, message };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log?.("fynd-webhook-api", "Register error", msg);
    return { ok: false, error: msg };
  }
}
