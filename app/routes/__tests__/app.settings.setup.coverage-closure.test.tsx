// @vitest-environment jsdom
/**
 * @vitest-environment jsdom
 *
 * Coverage closure for app.settings.setup.tsx — server action + component:
 *   - line 119  test_platform when shop record is missing (prisma.shop.create branch)
 *   - line 169  register_webhook when shop record is missing (prisma.shop.create branch)
 *   - line 251  Outer try/catch rethrows a Response (auth / boundary path)
 *   - line 778  Debug-logs panel JSX renders when fetcher.data has logs
 */
import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

// ── Server action mocks ──────────────────────────────────────────────────
const {
  prismaMock,
  authenticateMock,
  getNormalizedCredentialsFromRawMock,
  testPlatformConnectionRawMock,
  createFyndLoggerMock,
  getAppModeMock,
  processFyndWebhookMock,
  listFyndWebhookSubscribersMock,
  findSubscriberWithUrlMock,
  registerFyndWebhookMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  getNormalizedCredentialsFromRawMock: vi.fn(),
  testPlatformConnectionRawMock: vi.fn(),
  createFyndLoggerMock: vi.fn(),
  getAppModeMock: vi.fn(),
  processFyndWebhookMock: vi.fn(),
  listFyndWebhookSubscribersMock: vi.fn(),
  findSubscriberWithUrlMock: vi.fn(),
  registerFyndWebhookMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({
  default: {},
  authenticate: { admin: authenticateMock },
}));
vi.mock("../../lib/fynd.server", () => ({
  getNormalizedCredentialsFromRaw: getNormalizedCredentialsFromRawMock,
  testPlatformConnectionRaw: testPlatformConnectionRawMock,
}));
vi.mock("../../lib/fynd-logger.server", () => ({
  createFyndLogger: createFyndLoggerMock,
}));
vi.mock("../../lib/fynd-config.server", () => ({
  getAppMode: getAppModeMock,
}));
vi.mock("../../lib/fynd-webhook.server", () => ({
  processFyndWebhook: processFyndWebhookMock,
}));
vi.mock("../../lib/fynd-webhook-api.server", () => ({
  listFyndWebhookSubscribers: listFyndWebhookSubscribersMock,
  findSubscriberWithUrl: findSubscriberWithUrlMock,
  registerFyndWebhook: registerFyndWebhookMock,
}));
vi.mock("../../components/AppPage", () => ({
  AppPage: ({ heading, children }: { heading: string; children: React.ReactNode }) => (
    <div>
      <h1>{heading}</h1>
      {children}
    </div>
  ),
}));

// ── Component: synthesize useFetcher with prepopulated data so the debug
// logs panel renders deterministically.
const mockLoaderState: { value: unknown } = { value: undefined };
type MockFetcherState = {
  state: "idle" | "loading" | "submitting";
  data:
    | { debugLogs?: Array<{ ts: string; step: string; message: string; detail?: string }> }
    | undefined;
  submit: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  Form: React.FC<React.FormHTMLAttributes<HTMLFormElement>>;
};
const mockFetcher: MockFetcherState = {
  state: "idle",
  data: undefined,
  submit: vi.fn(),
  load: vi.fn(),
  Form: ({ children, ...props }) => <form {...props}>{children}</form>,
};
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>(
    "react-router",
  );
  return {
    ...actual,
    useLoaderData: () => mockLoaderState.value,
    useFetcher: () => mockFetcher,
  };
});

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { error: vi.fn(() => null), headers: vi.fn(() => ({})) },
  shopifyApp: vi.fn(() => ({
    addDocumentResponseHeaders: vi.fn(),
    authenticate: { admin: vi.fn() },
    unauthenticated: {},
    login: vi.fn(),
    registerWebhooks: vi.fn(),
    sessionStorage: {},
  })),
  ApiVersion: { January25: "2025-01" },
  AppDistribution: { AppStore: "app_store" },
  DeliveryMethod: { Http: "http" },
}));

import { renderWithRouter } from "../../test/component-helpers";
import { waitFor } from "@testing-library/react";
import FyndSetup, { action } from "../app.settings.setup";

function formReq(form: Record<string, string>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) fd.append(k, v);
  return new Request("https://x", { method: "POST", body: fd });
}

const origAppUrl = process.env.SHOPIFY_APP_URL;

beforeEach(() => {
  resetPrismaMock(prismaMock);
  prismaMock.shop.findUnique.mockReset().mockResolvedValue(null);
  prismaMock.shop.create
    .mockReset()
    .mockImplementation(async ({ data }) => ({
      id: "shop-newly-created",
      ...data,
      settings: null,
    }));
  authenticateMock
    .mockReset()
    .mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  getNormalizedCredentialsFromRawMock.mockReset().mockReturnValue(null);
  testPlatformConnectionRawMock.mockReset();
  createFyndLoggerMock.mockReset().mockReturnValue({ logs: [], log: vi.fn() });
  getAppModeMock.mockReset().mockReturnValue("prod");
  processFyndWebhookMock.mockReset();
  listFyndWebhookSubscribersMock.mockReset();
  findSubscriberWithUrlMock.mockReset().mockReturnValue(null);
  registerFyndWebhookMock.mockReset();
  process.env.SHOPIFY_APP_URL = "https://app.example.com";

  mockLoaderState.value = undefined;
  mockFetcher.state = "idle";
  mockFetcher.data = undefined;
  mockFetcher.submit.mockReset();
  mockFetcher.load.mockReset();
});

afterEach(() => {
  if (origAppUrl === undefined) delete process.env.SHOPIFY_APP_URL;
  else process.env.SHOPIFY_APP_URL = origAppUrl;
});

describe("app.settings.setup — coverage closure (server)", () => {
  it("test_platform creates shop record when missing (line 119)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = (await action({
      request: formReq({ intent: "test_platform" }),
      params: {},
      context: {},
    } as never)) as { success: boolean; error?: string };
    expect(prismaMock.shop.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { shopDomain: "store.myshopify.com" },
        include: { settings: true },
      }),
    );
    // Newly-created shop has no settings → request to test creds short-circuits.
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Save credentials/i);
  });

  it("register_webhook creates shop record when missing (line 169)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = (await action({
      request: formReq({ intent: "register_webhook" }),
      params: {},
      context: {},
    } as never)) as { success: boolean; registerError?: string };
    expect(prismaMock.shop.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { shopDomain: "store.myshopify.com" },
        include: { settings: true },
      }),
    );
    // No settings → short-circuits before calling registerFyndWebhook.
    expect(res.success).toBe(false);
    expect(registerFyndWebhookMock).not.toHaveBeenCalled();
  });

  it("rethrows Response thrown from inside the try (line 251)", async () => {
    // shop.findUnique throws a Response (e.g. session expired re-auth).
    const redirect = new Response(null, {
      status: 302,
      headers: { Location: "/auth/login" },
    });
    prismaMock.shop.findUnique.mockReset().mockImplementation(async () => {
      throw redirect;
    });
    await expect(
      action({
        request: formReq({ intent: "test_platform" }),
        params: {},
        context: {},
      } as never),
    ).rejects.toBe(redirect);
  });
});

describe("app.settings.setup — coverage closure (component)", () => {
  it("renders the Debug logs panel when fetcher.data has logs (line 778)", async () => {
    mockLoaderState.value = {
      hasPlatformCreds: false,
      fyndCompanyId: "",
      fyndApplicationId: "",
      fyndEnvironment: "uat",
      fyndCustomBaseUrl: "",
      appUrl: "https://example.com",
      webhookUrl: "https://example.com/api/webhooks/fynd/shop_123",
      legacyWebhookUrl: "https://example.com/api/webhooks/fynd",
      hasPerShopWebhookSecret: false,
      appMode: "prod",
      existingSubscriber: null,
      subscribersError: null,
    };
    mockFetcher.data = {
      debugLogs: [
        { ts: "2026-05-06T01:02:03Z", step: "auth", message: "ok" },
        {
          ts: "2026-05-06T01:02:04Z",
          step: "save",
          message: "persisted",
          detail: "shopId=cm123",
        },
      ],
    };
    const { container } = renderWithRouter(FyndSetup, {
      initialEntries: ["/app/settings/setup"],
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Debug logs (2)");
    });
    expect(container.textContent).toContain("auth: ok");
    expect(container.textContent).toContain("save: persisted");
    // The detail-suffix branch (` | ${e.detail}`) is hit by the second entry.
    expect(container.textContent).toContain("| shopId=cm123");
  });
});
