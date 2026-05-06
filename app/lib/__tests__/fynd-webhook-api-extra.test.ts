import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Extra tests for fynd-webhook-api.server.ts.
 *
 * Note: deleteSubscriber was requested but no such export exists in the
 * source file (only listFyndWebhookSubscribers, registerFyndWebhook,
 * findSubscriberWithUrl, plus the FYND_WEBHOOK_EVENTS constant). We cover
 * additional edge cases for the three exported functions and the
 * parseCredentials internal branches reachable through them.
 */

const { fetchFyndPlatformTokenMock, decryptMock, getFyndBaseUrlMock } = vi.hoisted(() => ({
  fetchFyndPlatformTokenMock: vi.fn().mockResolvedValue("tok_xyz"),
  decryptMock: vi.fn(),
  getFyndBaseUrlMock: vi.fn(() => "https://api.fynd.example"),
}));

vi.mock("../fynd.server", () => ({
  fetchFyndPlatformToken: fetchFyndPlatformTokenMock,
}));

vi.mock("../fynd-config.server", () => ({
  getFyndBaseUrl: getFyndBaseUrlMock,
}));

vi.mock("../encryption.server", () => ({
  decrypt: decryptMock,
}));

import {
  listFyndWebhookSubscribers,
  registerFyndWebhook,
  findSubscriberWithUrl,
  FYND_WEBHOOK_EVENTS,
  type FyndSubscriber,
} from "../fynd-webhook-api.server";

const baseSettings = {
  fyndCompanyId: "98765",
  fyndApplicationId: "app-9",
  fyndCredentials: JSON.stringify({ platform: { clientId: "cid", clientSecret: "csec" } }),
};

const fetchSpy = vi.fn();

beforeEach(() => {
  fetchSpy.mockReset();
  fetchFyndPlatformTokenMock.mockReset().mockResolvedValue("tok_xyz");
  decryptMock
    .mockReset()
    .mockImplementation((s: string) =>
      JSON.stringify({ platform: { clientId: "dec_id", clientSecret: "dec_secret" } }),
    );
  getFyndBaseUrlMock.mockReset().mockReturnValue("https://api.fynd.example");
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/* ── FYND_WEBHOOK_EVENTS ─────────────────────────────────────────────── */

describe("FYND_WEBHOOK_EVENTS (extra)", () => {
  it("contains exactly six events for refund + shipment categories", () => {
    expect(FYND_WEBHOOK_EVENTS).toHaveLength(6);
    const names = new Set(FYND_WEBHOOK_EVENTS.map((e) => e.event_name));
    expect(names).toEqual(new Set(["refund", "shipment"]));
  });

  it("uses event_category 'application' on every event", () => {
    for (const e of FYND_WEBHOOK_EVENTS) {
      expect(e.event_category).toBe("application");
    }
  });
});

/* ── listFyndWebhookSubscribers ──────────────────────────────────────── */

describe("listFyndWebhookSubscribers (extra)", () => {
  it("trims whitespace-only companyId and rejects it", async () => {
    const r = await listFyndWebhookSubscribers({ ...baseSettings, fyndCompanyId: "   " });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/Company ID/) });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("supports the alt clientId/clientSecret snake_case form in JSON credentials", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ items: [], page: { item_total: 0 } }),
    });
    const r = await listFyndWebhookSubscribers({
      ...baseSettings,
      fyndCredentials: JSON.stringify({ client_id: "snake", client_secret: "case" }),
    });
    expect(r.ok).toBe(true);
    expect(fetchFyndPlatformTokenMock).toHaveBeenCalledWith(
      expect.any(String),
      "98765",
      "snake",
      "case",
      undefined,
    );
  });

  it("calls the log callback when credentials parse fails", async () => {
    const logged: Array<[string, string, string]> = [];
    const log = (step: string, message: string, detail?: string) => {
      logged.push([step, message, detail ?? ""]);
    };
    decryptMock.mockImplementation(() => {
      throw new Error("bad cipher");
    });
    const r = await listFyndWebhookSubscribers(
      { ...baseSettings, fyndCredentials: "encryptedblob" },
      log,
    );
    expect(r.ok).toBe(false);
    expect(
      logged.some((l) => l[0] === "fynd-webhook-api" && /Parse credentials failed/.test(l[1])),
    ).toBe(true);
  });

  it("returns generic 5xx error without scope hint", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "boom",
    });
    const r = await listFyndWebhookSubscribers(baseSettings);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/500/);
      expect(r.error).not.toMatch(/scope/i);
      expect(r.error).not.toMatch(/Invalid credentials/i);
    }
  });

  it("includes 'Unknown error' when 4xx response body is empty", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "",
    });
    const r = await listFyndWebhookSubscribers(baseSettings);
    if (!r.ok) expect(r.error).toMatch(/Unknown error/);
  });

  it("hits the page_no=1&page_size=50 endpoint for the right company", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ items: [], page: { item_total: 0 } }),
    });
    await listFyndWebhookSubscribers(baseSettings);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      "https://api.fynd.example/service/platform/webhook/v1.0/company/98765/subscriber/?page_no=1&page_size=50",
    );
    expect((init as { method: string }).method).toBe("GET");
  });

  it("returns empty subscribers array when items field is missing entirely", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({}),
    });
    const r = await listFyndWebhookSubscribers(baseSettings);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.subscribers).toEqual([]);
      expect(r.total).toBe(0);
    }
  });

  it("preserves event_configs metadata on returned subscribers", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () =>
        JSON.stringify({
          items: [
            {
              id: 7,
              name: "with-configs",
              webhook_url: "https://w.example/x",
              event_configs: [
                { event_name: "shipment", event_type: "update", event_category: "application" },
              ],
            },
          ],
          page: { item_total: 1 },
        }),
    });
    const r = await listFyndWebhookSubscribers(baseSettings);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.subscribers[0].event_configs).toEqual([
        { event_name: "shipment", event_type: "update", event_category: "application" },
      ]);
    }
  });
});

/* ── findSubscriberWithUrl ───────────────────────────────────────────── */

describe("findSubscriberWithUrl (extra)", () => {
  const subs: FyndSubscriber[] = [
    { id: 100, name: "p", webhook_url: "https://A.example.com/Path/" },
    { id: 200, name: "q", webhook_url: "https://b.example.com/path" },
  ];

  it("returns undefined for an empty subscriber list", () => {
    expect(findSubscriberWithUrl([], "https://anything")).toBeUndefined();
  });

  it("matches the first subscriber with case + trailing-slash variants", () => {
    const found = findSubscriberWithUrl(subs, "https://a.example.com/path");
    expect(found?.id).toBe(100);
  });

  it("does not match when only the path differs", () => {
    expect(findSubscriberWithUrl(subs, "https://a.example.com/Different")).toBeUndefined();
  });
});

/* ── registerFyndWebhook ─────────────────────────────────────────────── */

describe("registerFyndWebhook (extra)", () => {
  const good = {
    url: "https://hooks.example.app/api/webhooks/fynd/shop-9",
    name: "shop-9 hooks",
    email: "ops@example.com",
  };

  it("trims whitespace from companyId/applicationId before validating", async () => {
    fetchSpy.mockResolvedValue({ ok: true, text: async () => "{}" });
    await registerFyndWebhook(
      { ...baseSettings, fyndCompanyId: "  98765  ", fyndApplicationId: "  app-9  " },
      good.url,
      good.name,
      good.email,
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url] = fetchSpy.mock.calls[0];
    expect(url).toContain("/company/98765/subscriber/");
  });

  it("trims whitespace-only fields and rejects them", async () => {
    const r = await registerFyndWebhook(baseSettings, "   ", good.name, good.email);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/Webhook URL/i);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("accepts http:// (not just https://) URLs", async () => {
    fetchSpy.mockResolvedValue({ ok: true, text: async () => "{}" });
    const r = await registerFyndWebhook(
      baseSettings,
      "http://localhost:3000/hook",
      good.name,
      good.email,
    );
    expect(r.ok).toBe(true);
  });

  it("falls back to raw response text when 4xx body is not JSON", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });
    const r = await registerFyndWebhook(baseSettings, good.url, good.name, good.email);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/500/);
      expect(r.error).toMatch(/Internal Server Error/);
    }
  });

  it("uses parsed.error field when no message/err is present", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => JSON.stringify({ error: "validation failed" }),
    });
    const r = await registerFyndWebhook(baseSettings, good.url, good.name, good.email);
    if (!r.ok) {
      expect(r.error).toMatch(/422/);
      expect(r.error).toMatch(/validation failed/);
    }
  });

  it("truncates very long error messages to 400 chars", async () => {
    const huge = "x".repeat(2000);
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ message: huge }),
    });
    const r = await registerFyndWebhook(baseSettings, good.url, good.name, good.email);
    if (!r.ok) {
      // Raw 'x'-content is sliced to 400 chars; total error string is "Fynd Webhook API 500: " + 400 x's.
      const xs = r.error.match(/x+/)?.[0] ?? "";
      expect(xs.length).toBe(400);
    }
  });

  it("decrypts encrypted credentials and passes them to the token fetch", async () => {
    decryptMock.mockReturnValue(
      JSON.stringify({ platform: { clientId: "from_decrypt", clientSecret: "from_decrypt_sec" } }),
    );
    fetchSpy.mockResolvedValue({ ok: true, text: async () => "{}" });
    const r = await registerFyndWebhook(
      { ...baseSettings, fyndCredentials: "encryptedblob" },
      good.url,
      good.name,
      good.email,
    );
    expect(r.ok).toBe(true);
    expect(fetchFyndPlatformTokenMock).toHaveBeenCalledWith(
      expect.any(String),
      "98765",
      "from_decrypt",
      "from_decrypt_sec",
      undefined,
    );
  });

  it("PUTs the active status with SPECIFIC-EVENTS criteria", async () => {
    fetchSpy.mockResolvedValue({ ok: true, text: async () => "{}" });
    await registerFyndWebhook(baseSettings, good.url, good.name, good.email);
    const init = fetchSpy.mock.calls[0][1] as { body: string };
    const body = JSON.parse(init.body);
    expect(body.webhook_config.status).toBe("active");
    expect(body.webhook_config.association.criteria).toBe("SPECIFIC-EVENTS");
    expect(body.webhook_config.event_map.rest.type).toBe("rest");
  });

  it("includes Content-Type and Authorization headers", async () => {
    fetchSpy.mockResolvedValue({ ok: true, text: async () => "{}" });
    await registerFyndWebhook(baseSettings, good.url, good.name, good.email);
    const init = fetchSpy.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers.Authorization).toBe("Bearer tok_xyz");
  });

  it("handles a non-Error thrown value from the fetch", async () => {
    fetchSpy.mockImplementation(() => {
      throw "weird-string-error";
    });
    const r = await registerFyndWebhook(baseSettings, good.url, good.name, good.email);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/weird-string-error/);
  });

  it("falls back to the default success message when response body is invalid JSON", async () => {
    fetchSpy.mockResolvedValue({
      ok: true,
      text: async () => "not-json{{",
    });
    const r = await registerFyndWebhook(baseSettings, good.url, good.name, good.email);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.message).toMatch(/registered successfully/i);
  });

  it("rejects non-https/http schemes such as javascript:", async () => {
    const r = await registerFyndWebhook(baseSettings, "javascript:alert(1)", good.name, good.email);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/https?:\/\//);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
