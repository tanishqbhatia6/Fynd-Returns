import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * fynd-webhook-api.server.ts tests.
 *
 * Mocks fetch globally + stubs fetchFyndPlatformToken so we can drive
 * the full list / register flow without real network calls.
 */

const { fetchFyndPlatformTokenMock } = vi.hoisted(() => ({
  fetchFyndPlatformTokenMock: vi.fn().mockResolvedValue("tok_abc"),
}));

vi.mock("../fynd.server", () => ({
  fetchFyndPlatformToken: fetchFyndPlatformTokenMock,
}));

vi.mock("../fynd-config.server", () => ({
  getFyndBaseUrl: () => "https://api.fynd.example",
}));

vi.mock("../encryption.server", () => ({
  decrypt: (s: string) =>
    JSON.stringify({ platform: { clientId: "dec_id", clientSecret: "dec_secret" } }),
}));

import {
  listFyndWebhookSubscribers,
  registerFyndWebhook,
  findSubscriberWithUrl,
  FYND_WEBHOOK_EVENTS,
} from "../fynd-webhook-api.server";

const settings = {
  fyndCompanyId: "12345",
  fyndApplicationId: "app-1",
  fyndCredentials: JSON.stringify({ platform: { clientId: "cid", clientSecret: "csec" } }),
};

const fetchSpy = vi.fn();
beforeEach(() => {
  fetchSpy.mockReset();
  fetchFyndPlatformTokenMock.mockReset().mockResolvedValue("tok_abc");
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/* ── FYND_WEBHOOK_EVENTS constant ─────────────────────────────────── */

describe("FYND_WEBHOOK_EVENTS", () => {
  it("covers the refund lifecycle + shipment updates", () => {
    const types = FYND_WEBHOOK_EVENTS.map((e) => e.event_type);
    expect(types).toContain("refund_initiated");
    expect(types).toContain("refund_pending");
    expect(types).toContain("refund_done");
    expect(types).toContain("refund_failed");
    expect(types).toContain("update");
    expect(types).toContain("data_update");
  });
  it("all events are version 1", () => {
    for (const e of FYND_WEBHOOK_EVENTS) expect(e.version).toBe(1);
  });
});

/* ── listFyndWebhookSubscribers ───────────────────────────────────── */

describe("listFyndWebhookSubscribers", () => {
  it("fails when companyId missing", async () => {
    const r = await listFyndWebhookSubscribers({ ...settings, fyndCompanyId: "" });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/Company ID/) });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails when credentials are empty", async () => {
    const r = await listFyndWebhookSubscribers({ ...settings, fyndCredentials: "" });
    expect(r.ok).toBe(false);
  });

  it("fails when credentials are malformed JSON", async () => {
    const r = await listFyndWebhookSubscribers({ ...settings, fyndCredentials: "not-json{{{" });
    expect(r.ok).toBe(false);
  });

  it("parses encrypted credentials via decrypt()", async () => {
    // Any non-JSON string triggers the decrypt path. Our decrypt mock
    // returns a valid JSON credential string.
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ items: [], page: { item_total: 0 } }),
    });
    const r = await listFyndWebhookSubscribers({
      ...settings,
      fyndCredentials: "encrypted:blob",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.subscribers).toEqual([]);
  });

  it("returns subscribers on 200 response", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          items: [
            {
              id: 1,
              name: "My webhook",
              webhook_url: "https://x.com/hook",
              status: "active",
              provider: "rest",
              email_id: "a@b.com",
              event_configs: [
                { event_name: "refund", event_type: "refund_done", event_category: "application" },
              ],
            },
          ],
          page: { item_total: 1 },
        }),
    });
    const r = await listFyndWebhookSubscribers(settings);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.subscribers).toHaveLength(1);
      expect(r.subscribers[0].name).toBe("My webhook");
      expect(r.total).toBe(1);
    }
  });

  it("fills missing fields with defaults (id=0, name='Unknown')", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ items: [{}], page: { item_total: 1 } }),
    });
    const r = await listFyndWebhookSubscribers(settings);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.subscribers[0].id).toBe(0);
      expect(r.subscribers[0].name).toBe("Unknown");
      expect(r.subscribers[0].webhook_url).toBe("");
    }
  });

  it("falls back total=subscribers.length when page.item_total missing", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ items: [{ id: 1 }, { id: 2 }] }),
    });
    const r = await listFyndWebhookSubscribers(settings);
    if (r.ok) expect(r.total).toBe(2);
  });

  it("returns error message on 403 with scope hint", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '{"message":"Forbidden"}',
    });
    const r = await listFyndWebhookSubscribers(settings);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/403/);
      expect(r.error).toMatch(/scope/i);
    }
  });

  it("returns error with 'Invalid credentials' hint on 401", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 401, text: async () => "" });
    const r = await listFyndWebhookSubscribers(settings);
    if (!r.ok) expect(r.error).toMatch(/Invalid credentials/);
  });

  it("returns error on invalid JSON body", async () => {
    fetchSpy.mockResolvedValue({ ok: true, text: async () => "not json" });
    const r = await listFyndWebhookSubscribers(settings);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/invalid JSON/);
  });

  it("returns error when token fetch throws", async () => {
    fetchFyndPlatformTokenMock.mockRejectedValue(new Error("auth down"));
    const r = await listFyndWebhookSubscribers(settings);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/auth down/);
  });

  it("sends Authorization: Bearer <token> header", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ items: [], page: { item_total: 0 } }),
    });
    await listFyndWebhookSubscribers(settings);
    const init = fetchSpy.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe("Bearer tok_abc");
  });
});

/* ── findSubscriberWithUrl ─────────────────────────────────────────── */

describe("findSubscriberWithUrl", () => {
  const subs = [
    { id: 1, name: "a", webhook_url: "https://returnpromax.app/api/webhooks/fynd/shop-1" },
    { id: 2, name: "b", webhook_url: "https://hook.example.com/other" },
  ];
  it("matches a URL with trailing-slash normalisation", () => {
    const found = findSubscriberWithUrl(subs, "https://returnpromax.app/api/webhooks/fynd/shop-1/");
    expect(found?.id).toBe(1);
  });
  it("is case-insensitive", () => {
    const found = findSubscriberWithUrl(subs, "HTTPS://returnpromax.app/api/webhooks/FYND/shop-1");
    expect(found?.id).toBe(1);
  });
  it("returns undefined when no subscriber matches", () => {
    expect(findSubscriberWithUrl(subs, "https://no-such.host/hook")).toBe(undefined);
  });
  it("handles missing webhook_url on a subscriber gracefully", () => {
    const res = findSubscriberWithUrl(
      [{ id: 1, name: "x", webhook_url: "" }],
      "https://somewhere.app/hook",
    );
    expect(res).toBe(undefined);
  });
});

/* ── registerFyndWebhook ───────────────────────────────────────────── */

describe("registerFyndWebhook", () => {
  const good = {
    url: "https://returnpromax.app/api/webhooks/fynd/shop-1",
    name: "Shop-1 returns",
    email: "ops@fynd.com",
  };

  it("fails when webhook URL lacks http/https", async () => {
    const r = await registerFyndWebhook(settings, "ftp://bad", good.name, good.email);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/https?:\/\//);
  });

  it.each([
    ["companyId", { ...settings, fyndCompanyId: "" }, /Company ID/],
    ["applicationId", { ...settings, fyndApplicationId: "" }, /Application ID/],
    ["credentials", { ...settings, fyndCredentials: "" }, /credentials/],
  ])("fails when %s is missing", async (_label, s, regex) => {
    const r = await registerFyndWebhook(s, good.url, good.name, good.email);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(regex as RegExp);
  });

  it("fails when webhookUrl is empty", async () => {
    const r = await registerFyndWebhook(settings, "", good.name, good.email);
    expect(r.ok).toBe(false);
  });

  it("fails when subscriberName is empty", async () => {
    const r = await registerFyndWebhook(settings, good.url, "", good.email);
    expect(r.ok).toBe(false);
  });

  it("fails when notificationEmail is empty", async () => {
    const r = await registerFyndWebhook(settings, good.url, good.name, "");
    expect(r.ok).toBe(false);
  });

  it("sends PUT with correct body structure", async () => {
    fetchSpy.mockResolvedValue({ ok: true, text: async () => JSON.stringify({ message: "ok" }) });
    await registerFyndWebhook(settings, good.url, good.name, good.email);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain("/service/platform/webhook/v3.0/company/12345/subscriber/");
    expect((init as { method: string }).method).toBe("PUT");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.webhook_config.name).toBe(good.name);
    expect(body.webhook_config.notification_email).toBe(good.email);
    expect(body.webhook_config.association.application_id).toEqual(["app-1"]);
    expect(body.webhook_config.event_map.rest.webhook_url).toBe(good.url);
    expect(body.webhook_config.event_map.rest.events.length).toBe(FYND_WEBHOOK_EVENTS.length);
  });

  it("strips trailing slash from URL", async () => {
    fetchSpy.mockResolvedValue({ ok: true, text: async () => "{}" });
    await registerFyndWebhook(settings, "https://x.com/hook/", good.name, good.email);
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body);
    expect(body.webhook_config.event_map.rest.webhook_url).toBe("https://x.com/hook");
  });

  it("returns success with default message when response has no message field", async () => {
    fetchSpy.mockResolvedValue({ ok: true, text: async () => "{}" });
    const r = await registerFyndWebhook(settings, good.url, good.name, good.email);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toMatch(/registered successfully/i);
  });

  it("returns Fynd-provided message when present", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ message: "Webhook upserted" }),
    });
    const r = await registerFyndWebhook(settings, good.url, good.name, good.email);
    if (r.ok) expect(r.message).toBe("Webhook upserted");
  });

  it("returns 403 with scope hint on forbidden response", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => '{"message":"Forbidden"}',
    });
    const r = await registerFyndWebhook(settings, good.url, good.name, good.email);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/403/);
      expect(r.error).toMatch(/scope/i);
    }
  });

  it("returns 400 with format hint on bad request", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => '{"message":"bad input"}',
    });
    const r = await registerFyndWebhook(settings, good.url, good.name, good.email);
    if (!r.ok) {
      expect(r.error).toMatch(/400/);
      expect(r.error).toMatch(/format|structure/i);
    }
  });

  it("parses Fynd's `err[]` array when present", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () =>
        JSON.stringify({
          err: [
            { path: "webhook_config.name", msg: "required" },
            { path: "webhook_config.notification_email", msg: "invalid format" },
          ],
        }),
    });
    const r = await registerFyndWebhook(settings, good.url, good.name, good.email);
    if (!r.ok) {
      expect(r.error).toMatch(/webhook_config.name: required/);
      expect(r.error).toMatch(/invalid format/);
    }
  });

  it("returns error string on network exception", async () => {
    fetchSpy.mockRejectedValue(new Error("timeout"));
    const r = await registerFyndWebhook(settings, good.url, good.name, good.email);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/timeout/);
  });

  it("calls the log callback during request", async () => {
    fetchSpy.mockResolvedValue({ ok: true, text: async () => "{}" });
    const logs: Array<{ step: string; message: string }> = [];
    await registerFyndWebhook(settings, good.url, good.name, good.email, (step, message) => {
      logs.push({ step, message });
    });
    expect(logs.some((l) => l.step === "fynd-webhook-api")).toBe(true);
  });
});
