/**
 * @vitest-environment jsdom
 *
 * Final-mile branch coverage across six settings routes — pushing each file
 * across the 98% branch threshold without modifying existing tests or any
 * source files. Mix of:
 *   • component-level tests that hit small remaining UI branches
 *   • action / loader direct-call tests that hit the server-side helpers
 *     (parsePolicyForForm, buildPolicyJson, the per-shape JSON parse paths)
 *
 * The vi.mock entries deliberately register both `../X` (the path the source
 * file imports) AND `../../X` (the path this test file imports), so vitest
 * resolves a single mock identity that both code paths share.
 */
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module-level mocks for server-only imports ──
vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../db.server", () => ({
  default: {
    shop: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn() },
    shopSettings: { upsert: vi.fn() },
    notificationLog: { findMany: vi.fn(async () => []) },
    fyndWebhookLog: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
      groupBy: vi.fn(async () => []),
    },
  },
}));
vi.mock("../../db.server", () => ({
  default: {
    shop: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn() },
    shopSettings: { upsert: vi.fn() },
    notificationLog: { findMany: vi.fn(async () => []) },
    fyndWebhookLog: {
      count: vi.fn(async () => 0),
      findMany: vi.fn(async () => []),
      groupBy: vi.fn(async () => []),
    },
  },
}));
vi.mock("../lib/shop.server", () => ({
  findOrCreateShop: vi.fn(async () => ({ id: "shop_1", settings: null })),
  syncShopLocaleAndCurrency: vi.fn(async () => undefined),
}));
vi.mock("../../lib/shop.server", () => ({
  findOrCreateShop: vi.fn(async () => ({ id: "shop_1", settings: null })),
  syncShopLocaleAndCurrency: vi.fn(async () => undefined),
}));
vi.mock("../lib/shopify-admin.server", () => ({
  fetchAllLocations: vi.fn(async () => []),
}));
vi.mock("../../lib/shopify-admin.server", () => ({
  fetchAllLocations: vi.fn(async () => []),
}));
vi.mock("../lib/encryption.server", () => ({
  encrypt: (s: string) => `enc(${s})`,
  encryptIfNeeded: (s: string | null | undefined) => (s ? `enc(${s})` : null),
  decryptIfEncrypted: (s: string | null | undefined) =>
    s ? String(s).replace(/^enc\(|\)$/g, "") : null,
  looksEncrypted: () => false,
}));
vi.mock("../../lib/encryption.server", () => ({
  encrypt: (s: string) => `enc(${s})`,
  encryptIfNeeded: (s: string | null | undefined) => (s ? `enc(${s})` : null),
  decryptIfEncrypted: (s: string | null | undefined) =>
    s ? String(s).replace(/^enc\(|\)$/g, "") : null,
  looksEncrypted: () => false,
}));
vi.mock("../lib/fynd.server", () => ({
  createFyndClientOrError: vi.fn(),
  getNormalizedCredentialsFromRaw: vi.fn(() => null),
  testPlatformConnectionRaw: vi.fn(),
}));
vi.mock("../../lib/fynd.server", () => ({
  createFyndClientOrError: vi.fn(),
  getNormalizedCredentialsFromRaw: vi.fn(() => null),
  testPlatformConnectionRaw: vi.fn(),
}));
vi.mock("../lib/fynd-logger.server", () => ({
  createFyndLogger: () => ({ logs: [], log: vi.fn() }),
}));
vi.mock("../../lib/fynd-logger.server", () => ({
  createFyndLogger: () => ({ logs: [], log: vi.fn() }),
}));
vi.mock("../lib/fynd-config.server", () => ({
  FYND_ENVIRONMENTS: {
    uat: "https://api.uat.fyndx1.de",
    prod: "https://api.fynd.com",
  },
  getAppMode: vi.fn(() => "prod"),
}));
vi.mock("../../lib/fynd-config.server", () => ({
  FYND_ENVIRONMENTS: {
    uat: "https://api.uat.fyndx1.de",
    prod: "https://api.fynd.com",
  },
  getAppMode: vi.fn(() => "prod"),
}));
vi.mock("../lib/credential-validation.server", () => ({
  sanitizeCredentialInputs: vi.fn(),
}));
vi.mock("../../lib/credential-validation.server", () => ({
  sanitizeCredentialInputs: vi.fn(),
}));
vi.mock("../lib/notification.server", () => ({
  testSmtpConnection: vi.fn(),
}));
vi.mock("../../lib/notification.server", () => ({
  testSmtpConnection: vi.fn(),
}));
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
vi.mock("../components/AppPage", () => ({
  AppPage: ({
    heading,
    children,
  }: {
    heading: React.ReactNode;
    children: React.ReactNode;
  }) => (
    <div data-testid="app-page">
      <h1>{heading}</h1>
      {children}
    </div>
  ),
}));

// Driveable react-router hook stubs.
type FetcherShape = {
  state: "idle" | "loading" | "submitting";
  data: unknown;
  formData?: FormData;
  submit: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  Form: React.FC<
    React.FormHTMLAttributes<HTMLFormElement> & { children?: React.ReactNode }
  >;
};
const loaderState: { value: unknown } = { value: undefined };
const fetcherStates: FetcherShape[] = [];
const renderCounter = { value: 0 };
const searchParamsState: { value: URLSearchParams } = {
  value: new URLSearchParams(),
};

function defaultFetcher(): FetcherShape {
  return {
    state: "idle",
    data: undefined,
    formData: undefined,
    submit: vi.fn(),
    load: vi.fn(),
    Form: ({ children, ...rest }) => <form {...rest}>{children}</form>,
  };
}

vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>(
    "react-router",
  );
  return {
    ...actual,
    useLoaderData: () => {
      renderCounter.value = 0;
      return loaderState.value;
    },
    useFetcher: () => {
      const idx = renderCounter.value++;
      if (!fetcherStates[idx]) fetcherStates[idx] = defaultFetcher();
      return fetcherStates[idx];
    },
    useSearchParams: () => [
      searchParamsState.value,
      vi.fn(
        (
          next:
            | URLSearchParams
            | ((p: URLSearchParams) => URLSearchParams),
        ) => {
          searchParamsState.value =
            typeof next === "function" ? next(searchParamsState.value) : next;
        },
      ),
    ],
    useRevalidator: () => ({ revalidate: vi.fn(), state: "idle" }),
  };
});

import { renderWithRouter } from "../../test/component-helpers";
import { fireEvent, waitFor } from "@testing-library/react";
import ReturnRules, { action as rulesAction } from "../app.settings.rules";
import Widget from "../app.settings.widget";
import Integrations, {
  loader as integrationsLoader,
  action as integrationsAction,
} from "../app.settings.integrations";
import ProductPolicies from "../app.settings.product-policies";
import Notifications from "../app.settings.notifications";
import WebhookLogs from "../app.settings.webhook-logs";
import { authenticate } from "../../shopify.server";
import prisma from "../../db.server";
import { findOrCreateShop } from "../../lib/shop.server";
import { sanitizeCredentialInputs } from "../../lib/credential-validation.server";
import { DEFAULT_PORTAL_THEME, FONT_OPTIONS } from "../../lib/portal-theme.server";
import { SUPPORTED_LANGUAGES, DEFAULT_LABELS } from "../../lib/portal-i18n";

const WAIT = { timeout: 8000 };

beforeEach(() => {
  loaderState.value = undefined;
  fetcherStates.length = 0;
  renderCounter.value = 0;
  searchParamsState.value = new URLSearchParams();
});

// ────────────────────────── rules ──────────────────────────
describe("app.settings.rules — final branches", () => {
  const ld = {
    returnWindowDays: 30,
    minimumReturnPrice: "0",
    returnReasons: ["Wrong size", "Damaged"],
    returnReasonsByCategory: [],
    restrictedRegions: [],
    returnOffers: [],
    returnOffersEnabled: true,
    feesByReason: [],
    windowsByCountry: [{ country: "US", days: 45 }],
    shopCurrency: "EUR",
  };

  it("adds and removes a country-specific window row (covers add + remove + onChange)", async () => {
    loaderState.value = ld;
    const { container } = renderWithRouter(ReturnRules, {
      initialEntries: ["/app/settings/rules"],
      loaderData: ld,
    });
    let countryInputs: HTMLInputElement[] = [];
    await waitFor(() => {
      countryInputs = Array.from(
        container.querySelectorAll<HTMLInputElement>(
          'input[placeholder="Country code (e.g. US, UK, DE)"]',
        ),
      );
      expect(countryInputs.length).toBe(1);
    }, WAIT);
    const addBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "+ Add country",
    );
    expect(addBtn).toBeTruthy();
    fireEvent.click(addBtn!);
    await waitFor(() => {
      countryInputs = Array.from(
        container.querySelectorAll<HTMLInputElement>(
          'input[placeholder="Country code (e.g. US, UK, DE)"]',
        ),
      );
      expect(countryInputs.length).toBe(2);
    }, WAIT);
    fireEvent.change(countryInputs[1], { target: { value: "DE" } });
    expect(countryInputs[1].value).toBe("DE");
    const daysInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>(
        'input[type="number"][min="1"][max="365"]',
      ),
    ).filter((i) => !i.getAttribute("name"));
    expect(daysInputs.length).toBeGreaterThanOrEqual(2);
    fireEvent.change(daysInputs[daysInputs.length - 1], {
      target: { value: "60" },
    });
    expect(daysInputs[daysInputs.length - 1].value).toBe("60");
    fireEvent.change(daysInputs[daysInputs.length - 1], {
      target: { value: "" },
    });
    const xButtons = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.textContent?.trim() === "×",
    );
    const countryRemove = xButtons.find((b) =>
      /days/i.test(b.parentElement?.textContent ?? ""),
    );
    expect(countryRemove).toBeTruthy();
    fireEvent.click(countryRemove!);
    await waitFor(() => {
      countryInputs = Array.from(
        container.querySelectorAll<HTMLInputElement>(
          'input[placeholder="Country code (e.g. US, UK, DE)"]',
        ),
      );
      expect(countryInputs.length).toBe(1);
    }, WAIT);
  });

  it("renders an offer with both reasonCode AND tag (covers '·' separator branch)", async () => {
    loaderState.value = {
      ...ld,
      returnOffers: [
        {
          id: "o1",
          offerType: "discount_pct" as const,
          offerValue: 10,
          message: "10% off",
          reasonCode: "Wrong size",
          tag: "promo",
        },
      ],
    };
    const { container } = renderWithRouter(ReturnRules, {
      initialEntries: ["/app/settings/rules"],
      loaderData: loaderState.value,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Wrong size");
      expect(container.textContent).toContain("promo");
    }, WAIT);
  });

  it("shows the action success banner (data.success=true)", async () => {
    loaderState.value = ld;
    fetcherStates[0] = { ...defaultFetcher(), data: { success: true } };
    const { container } = renderWithRouter(ReturnRules, {
      initialEntries: ["/app/settings/rules"],
      loaderData: ld,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Settings saved successfully.");
    }, WAIT);
  });

  it("shows the action error banner (data.success=false + error)", async () => {
    loaderState.value = ld;
    fetcherStates[0] = {
      ...defaultFetcher(),
      data: { success: false, error: "DB exploded" },
    };
    const { container } = renderWithRouter(ReturnRules, {
      initialEntries: ["/app/settings/rules"],
      loaderData: ld,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("DB exploded");
    }, WAIT);
  });
});

// ────────────────────────── widget ──────────────────────────
describe("app.settings.widget — final branches", () => {
  const ld = {
    portalTheme: { ...DEFAULT_PORTAL_THEME },
    portalConfig: {
      showOrderTracking: true,
      showReturnTracking: true,
      showCreateReturnTab: true,
      defaultTab: "return" as const,
      allowMediaUploads: true,
      allowReturnCancellation: true,
    },
    fontOptions: FONT_OPTIONS,
    portalUrl: "https://test.myshopify.com/apps/returns",
    portalLanguage: "en",
    portalLabelOverrides: {} as Record<string, string>,
    resolvedLabels: { ...DEFAULT_LABELS },
    labelKeys: Object.keys(DEFAULT_LABELS),
    supportedLanguages: SUPPORTED_LANGUAGES,
    shopLocale: "en",
    shopCurrency: "USD",
    shopTimezone: "UTC",
    brandLogoUrl: null,
    brandFaviconUrl: null,
  };

  it("renders the success branch (data.success=true)", async () => {
    loaderState.value = ld;
    fetcherStates[0] = { ...defaultFetcher(), data: { success: true } };
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: ld,
    });
    await waitFor(() => {
      expect(container.textContent ?? "").toMatch(/saved|success/i);
    }, WAIT);
  });

  it("renders the explicit error branch (success=false + error)", async () => {
    loaderState.value = ld;
    fetcherStates[0] = {
      ...defaultFetcher(),
      data: { success: false, error: "DB write failed" },
    };
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: ld,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("DB write failed");
    }, WAIT);
  });

  it("renders the default error message when success=false and no error supplied", async () => {
    loaderState.value = ld;
    fetcherStates[0] = { ...defaultFetcher(), data: { success: false } };
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: ld,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Failed to save settings.");
    }, WAIT);
  });
});

// ────────────────────────── integrations ──────────────────────────
describe("app.settings.integrations — final branches", () => {
  const ld = {
    fyndApiType: "platform",
    fyndEnvironment: "uat",
    policy: {
      returnWindowDays: 30,
      allowExchange: false,
      minOrderValue: 0,
      refundMethods: ["original_payment", "store_credit"],
      defaultRefundMethod: "original_payment",
      excludedTags: [],
      allowedCategories: [],
      restockFeePercent: 0,
    },
    fyndCustomBaseUrl: "",
    appMode: "prod" as const,
    fyndCompanyId: "2263",
    fyndApplicationId: "67a09b70c8ea7c9123f00fab",
    fyndCredentials: "",
    hasPlatformCreds: false,
    hasStorefrontCreds: false,
    policyJson: "{}",
    fyndEnvironments: {
      uat: "https://api.uat.fyndx1.de",
      prod: "https://api.fynd.com",
    },
    gorgiasEnabled: false,
    gorgiasApiKey: "",
    gorgiasWidgetUrl: "https://app.example.com/api/integrations/gorgias?shop=t",
    fyndWebhookSecretConfigured: false,
    fyndWebhookUrl: "https://app.example.com/api/webhooks/fynd/shop_1",
    fyndWebhookSecretJustGenerated: undefined as string | undefined,
  };

  it("renders 'Credentials saved successfully.' on tokenUpdated=true", async () => {
    loaderState.value = ld;
    fetcherStates[0] = {
      ...defaultFetcher(),
      data: { success: true, tokenUpdated: true },
    };
    fetcherStates[1] = defaultFetcher();
    const { container } = renderWithRouter(Integrations, {
      initialEntries: ["/app/settings/integrations"],
      loaderData: ld,
    });
    await waitFor(() => {
      expect(container.textContent).toContain(
        "Credentials saved successfully.",
      );
    }, WAIT);
  });

  it("renders the just-generated secret amber banner via webhookFetcher.data", async () => {
    loaderState.value = ld;
    fetcherStates[0] = defaultFetcher();
    fetcherStates[1] = {
      ...defaultFetcher(),
      data: {
        success: true,
        fyndWebhookSecretJustGenerated: "shh-very-secret-xyz",
      },
    };
    const { container } = renderWithRouter(Integrations, {
      initialEntries: ["/app/settings/integrations"],
      loaderData: ld,
    });
    await waitFor(() => {
      const input = container.querySelector<HTMLInputElement>(
        'input[aria-label="Generated webhook secret (one-time display)"]',
      );
      expect(input?.value).toBe("shh-very-secret-xyz");
    }, WAIT);
    expect(container.textContent).toContain("Copy this secret now");
  });

  it("renders the webhookFetcher error inline message", async () => {
    loaderState.value = ld;
    fetcherStates[0] = defaultFetcher();
    fetcherStates[1] = {
      ...defaultFetcher(),
      data: { error: "rotate failed: server down" },
    };
    const { container } = renderWithRouter(Integrations, {
      initialEntries: ["/app/settings/integrations"],
      loaderData: ld,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("rotate failed: server down");
    }, WAIT);
  });

  it("flips the 'dev' radio onChange (covers setAppMode handler)", async () => {
    loaderState.value = ld;
    fetcherStates[0] = defaultFetcher();
    fetcherStates[1] = defaultFetcher();
    const { container } = renderWithRouter(Integrations, {
      initialEntries: ["/app/settings/integrations"],
      loaderData: ld,
    });
    await waitFor(() => {
      expect(
        container.querySelector(
          'input[type="radio"][name="appMode"][value="dev"]',
        ),
      ).toBeTruthy();
    }, WAIT);
    const dev = container.querySelector(
      'input[type="radio"][name="appMode"][value="dev"]',
    ) as HTMLInputElement;
    fireEvent.click(dev);
    expect(dev.checked).toBe(true);
  });
});

// ────────────────────────── product-policies ──────────────────────────
describe("app.settings.product-policies — final branches", () => {
  const ldPP = { rules: [] as unknown[] };

  it("renders the save success banner (fetcher.data.success=true)", async () => {
    loaderState.value = ldPP;
    fetcherStates[0] = { ...defaultFetcher(), data: { success: true } };
    const { container } = renderWithRouter(ProductPolicies, {
      initialEntries: ["/app/settings/product-policies"],
      loaderData: ldPP,
    });
    await waitFor(() => {
      expect(container.textContent ?? "").toContain(
        "Product policies saved successfully.",
      );
    }, WAIT);
  });

  it("renders the save error banner (fetcher.data.success=false + error)", async () => {
    loaderState.value = ldPP;
    fetcherStates[0] = {
      ...defaultFetcher(),
      data: { success: false, error: "kaboom" },
    };
    const { container } = renderWithRouter(ProductPolicies, {
      initialEntries: ["/app/settings/product-policies"],
      loaderData: ldPP,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("kaboom");
    }, WAIT);
  });
});

// ────────────────────────── notifications ──────────────────────────
describe("app.settings.notifications — final branches", () => {
  const baseN = {
    notificationsByEvent: {
      new_return_request: { email: false, whatsapp: false },
      return_approved: { email: false, whatsapp: false },
      return_rejected: { email: false, whatsapp: false },
      refund_processed: { email: false, whatsapp: false },
    },
    smtpConfig: null,
    smtpHost: "",
    smtpPort: "587",
    smtpUsername: "",
    smtpPassword: "",
    smtpFromEmail: "",
    smtpFromName: "",
    smtpSecure: false,
    adminNotifyEmail: "",
    adminSoundEnabled: true,
    smtpConfigured: false,
    emailTemplatesJson: {} as Record<
      string,
      { subject: string; bodyHtml: string }
    >,
    whatsappEnabled: false,
    whatsappProvider: "meta_cloud",
    whatsappApiKey: "",
    whatsappPhoneNumberId: "",
    whatsappFromNumber: "",
    portalOtpEmailEnabled: false,
    portalOtpSmsEnabled: false,
    notificationLogs: [] as unknown[],
    notificationLogFilters: {
      logChannel: null,
      logStatus: null,
      logQ: null,
    },
  };

  it("renders SMTP test-error feedback (testFetcher.data.testResult.success=false)", async () => {
    loaderState.value = baseN;
    fetcherStates[0] = defaultFetcher(); // saveFetcher
    fetcherStates[1] = {
      ...defaultFetcher(),
      data: {
        testResult: { success: false, error: "host unreachable: timeout" },
      },
    };
    fetcherStates[2] = defaultFetcher(); // templateFetcher
    const { container } = renderWithRouter(Notifications, {
      initialEntries: ["/app/settings/notifications"],
      loaderData: baseN,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("host unreachable: timeout");
    }, WAIT);
  });

  it("renders SMTP test-success feedback (testFetcher.data.testResult.success=true)", async () => {
    loaderState.value = baseN;
    fetcherStates[0] = defaultFetcher();
    fetcherStates[1] = {
      ...defaultFetcher(),
      data: { testResult: { success: true } },
    };
    fetcherStates[2] = defaultFetcher();
    const { container } = renderWithRouter(Notifications, {
      initialEntries: ["/app/settings/notifications"],
      loaderData: baseN,
    });
    await waitFor(() => {
      expect(container.textContent ?? "").toContain(
        "SMTP connection successful",
      );
    }, WAIT);
  });

  it("renders templates-saved feedback (templateFetcher.data.templatesSaved=true)", async () => {
    loaderState.value = baseN;
    fetcherStates[0] = defaultFetcher();
    fetcherStates[1] = defaultFetcher();
    fetcherStates[2] = {
      ...defaultFetcher(),
      data: { templatesSaved: true },
    };
    const { container } = renderWithRouter(Notifications, {
      initialEntries: ["/app/settings/notifications"],
      loaderData: baseN,
    });
    await waitFor(() => {
      expect(container.textContent ?? "").toMatch(/template/i);
    }, WAIT);
  });
});

// ────────────────────────── webhook-logs ──────────────────────────
const baseWebhookLoader = {
  logs: [] as unknown[],
  page: 1,
  totalPages: 1,
  totalCount: 0,
  analytics: {
    total: 0,
    successCount: 0,
    errorCount: 0,
    ignoredCount: 0,
    duplicateCount: 0,
    successRate: 100,
    actionCounts: {} as Record<string, number>,
  },
  filters: {
    actionFilter: "",
    statusFilter: "",
    searchQuery: "",
    dateFrom: "",
    dateTo: "",
  },
  actionOptions: [
    { value: "", label: "All actions" },
    { value: "error", label: "Error" },
  ],
  statusOptions: [
    { value: "", label: "All statuses" },
    { value: "delivered", label: "Delivered" },
  ],
  loaderError: null as string | null,
};

describe("app.settings.webhook-logs — final branches", () => {
  it("renders rows with null/missing optional fields (covers em-dash fallback branches)", async () => {
    const ld = {
      ...baseWebhookLoader,
      logs: [
        {
          id: "log-1",
          shipmentId: null,
          orderId: null,
          affiliateOrderId: null,
          refundStatus: null,
          fyndStatus: null,
          eventType: "shipment_status_update",
          action: "status_updated",
          returnCaseId: null,
          carrier: null,
          awbNumber: null,
          trackingUrl: null,
          customerName: null,
          customerEmail: null,
          customerPhone: null,
          error: null,
          rawPayload: "{}",
          createdAt: new Date("2025-05-01T00:00:00.000Z").toISOString(),
          source: "fynd",
        },
      ],
      totalCount: 1,
      analytics: {
        total: 1,
        successCount: 1,
        errorCount: 0,
        ignoredCount: 0,
        duplicateCount: 0,
        successRate: 100,
        actionCounts: { status_updated: 1 },
      },
    };
    loaderState.value = ld;
    fetcherStates[0] = defaultFetcher();
    const { container } = renderWithRouter(WebhookLogs, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: ld,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("—");
    }, WAIT);
  });

  it("renders the loaderError banner when loaderError is set", async () => {
    const ld = { ...baseWebhookLoader, loaderError: "DB connection lost" };
    loaderState.value = ld;
    fetcherStates[0] = defaultFetcher();
    const { container } = renderWithRouter(WebhookLogs, {
      initialEntries: ["/app/settings/webhook-logs"],
      loaderData: ld,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("DB connection lost");
    }, WAIT);
  });
});

// ────────────────────────── server-side action / loader branches ──────────────────────────
function makeFormRequest(form: Record<string, string | string[]>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) {
    if (Array.isArray(v)) v.forEach((vv) => fd.append(k, vv));
    else fd.append(k, v);
  }
  return new Request("https://x", { method: "POST", body: fd });
}

describe("app.settings.rules — action branches (server-side)", () => {
  it("rules action: parses every JSON shape (arrays + non-arrays + invalid) and persists via upsert", async () => {
    const auth = authenticate.admin as unknown as ReturnType<typeof vi.fn>;
    const findOC = findOrCreateShop as unknown as ReturnType<typeof vi.fn>;
    const upsert = (
      prisma as unknown as {
        shopSettings: { upsert: ReturnType<typeof vi.fn> };
      }
    ).shopSettings.upsert;
    auth.mockResolvedValueOnce({ session: { shop: "x.myshopify.com" } });
    findOC.mockResolvedValueOnce({ id: "shop_1", settings: null });
    upsert.mockResolvedValueOnce({});
    const req = makeFormRequest({
      returnWindowDays: "45",
      minimumReturnPrice: "12.5",
      returnReasonsJson: JSON.stringify(["A", "B"]),
      restrictedRegionsJson: JSON.stringify([{ country: "US" }]),
      returnOffersJson: JSON.stringify([
        { offerType: "discount_pct", offerValue: 10 },
      ]),
      feesByReasonJson: JSON.stringify([{ reason: "X", feeAmount: 5 }]),
      windowsByCountryJson: JSON.stringify([{ country: "DE", days: 30 }]),
      returnReasonsByCategoryJson: JSON.stringify({ Tops: ["a"] }),
      returnOffersEnabled: "on",
    });
    const result = (await rulesAction({
      request: req,
      params: {},
      context: {},
    } as unknown as Parameters<typeof rulesAction>[0])) as { success: boolean };
    expect(result.success).toBe(true);
    expect(upsert).toHaveBeenCalled();
  });

  it("rules action: every JSON parses to a NON-array (covers Array.isArray=false branches) + non-Error throw", async () => {
    const auth = authenticate.admin as unknown as ReturnType<typeof vi.fn>;
    const findOC = findOrCreateShop as unknown as ReturnType<typeof vi.fn>;
    const upsert = (
      prisma as unknown as {
        shopSettings: { upsert: ReturnType<typeof vi.fn> };
      }
    ).shopSettings.upsert;
    auth.mockResolvedValueOnce({ session: { shop: "x.myshopify.com" } });
    findOC.mockResolvedValueOnce({ id: "shop_1", settings: null });
    // Reject with a non-Error value to hit the `e instanceof Error ? : ...` branch.
    upsert.mockRejectedValueOnce("string-thrown-not-an-Error");
    const req = makeFormRequest({
      returnWindowDays: "0", // → clamped to 1 via Math.max
      minimumReturnPrice: "-50", // → clamped to 0
      // All JSON parses successfully but to a NON-array → undefined branch.
      returnReasonsJson: JSON.stringify({ notArr: true }),
      restrictedRegionsJson: JSON.stringify({ notArr: true }),
      returnOffersJson: JSON.stringify({ notArr: true }),
      feesByReasonJson: JSON.stringify({ notArr: true }),
      windowsByCountryJson: JSON.stringify({ notArr: true }),
      // returnReasonsByCategoryJson: empty/whitespace skips the inner block.
      returnReasonsByCategoryJson: "   ",
    });
    const result = (await rulesAction({
      request: req,
      params: {},
      context: {},
    } as unknown as Parameters<typeof rulesAction>[0])) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe("Failed to save settings.");
  });

  it("rules action: malformed JSON falls through catch + DB error returns success=false", async () => {
    const auth = authenticate.admin as unknown as ReturnType<typeof vi.fn>;
    const findOC = findOrCreateShop as unknown as ReturnType<typeof vi.fn>;
    const upsert = (
      prisma as unknown as {
        shopSettings: { upsert: ReturnType<typeof vi.fn> };
      }
    ).shopSettings.upsert;
    auth.mockResolvedValueOnce({ session: { shop: "x.myshopify.com" } });
    findOC.mockResolvedValueOnce({ id: "shop_1", settings: null });
    upsert.mockRejectedValueOnce(new Error("DB write blew up"));
    const req = makeFormRequest({
      returnWindowDays: "999",
      minimumReturnPrice: "not-a-number",
      returnReasonsJson: "{not json",
      restrictedRegionsJson: "also-broken",
      returnOffersJson: "{",
      feesByReasonJson: "[invalid",
      windowsByCountryJson: "garbage",
      returnReasonsByCategoryJson: JSON.stringify(["array-not-object"]),
    });
    const result = (await rulesAction({
      request: req,
      params: {},
      context: {},
    } as unknown as Parameters<typeof rulesAction>[0])) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe("DB write blew up");
  });
});

describe("app.settings.integrations — loader/action helper branches (server-side)", () => {
  it("integrations loader: parsePolicyForForm exercises every type-guard branch", async () => {
    const auth = authenticate.admin as unknown as ReturnType<typeof vi.fn>;
    const findUnique = (
      prisma as unknown as { shop: { findUnique: ReturnType<typeof vi.fn> } }
    ).shop.findUnique;
    auth.mockResolvedValueOnce({ session: { shop: "x.myshopify.com" } });
    const policyJson = JSON.stringify({
      returnWindowDays: 9999, // → clamped to 365 via Math.min branch
      allowExchange: true,
      minOrderValue: "not-a-number", // → defaults branch
      refundMethods: ["original_payment", 42, "bogus_method", "store_credit"],
      defaultRefundMethod: "fake_method", // → defaults branch
      excludedTags: ["ok", 1, "good"],
      allowedCategories: "not-an-array", // → defaults branch
      restockFeePercent: -5, // → clamped via Math.max
    });
    findUnique.mockResolvedValueOnce({
      id: "shop_1",
      shopDomain: "x.myshopify.com",
      settings: {
        fyndCredentials: "enc({})",
        policyJson,
        fyndCompanyId: "C1",
        fyndApplicationId: "A1",
        fyndApiType: "platform",
        fyndEnvironment: "uat",
        fyndCustomBaseUrl: "https://custom",
        gorgiasEnabled: true,
        gorgiasApiKey: "enc(g)",
      },
    });
    const result = (await integrationsLoader({
      request: new Request("https://x"),
      params: {},
      context: {},
    } as unknown as Parameters<typeof integrationsLoader>[0])) as {
      policy: {
        returnWindowDays: number;
        minOrderValue: number;
        refundMethods: string[];
        restockFeePercent: number;
      };
    };
    expect(result.policy.returnWindowDays).toBe(365);
    expect(result.policy.restockFeePercent).toBe(0);
    expect(result.policy.refundMethods).toEqual([
      "original_payment",
      "store_credit",
    ]);
  });

  it("integrations action: buildPolicyJson exercises multi-value getAll + invalid-default + appMode=dev + Gorgias preserve", async () => {
    const auth = authenticate.admin as unknown as ReturnType<typeof vi.fn>;
    const findUnique = (
      prisma as unknown as { shop: { findUnique: ReturnType<typeof vi.fn> } }
    ).shop.findUnique;
    const upsert = (
      prisma as unknown as {
        shopSettings: { upsert: ReturnType<typeof vi.fn> };
      }
    ).shopSettings.upsert;
    auth.mockResolvedValueOnce({ session: { shop: "x.myshopify.com" } });
    findUnique.mockResolvedValueOnce({
      id: "shop_1",
      shopDomain: "x.myshopify.com",
      settings: { gorgiasApiKey: "enc(prev)" },
    });
    upsert.mockResolvedValueOnce({});
    (
      sanitizeCredentialInputs as unknown as ReturnType<typeof vi.fn>
    ).mockImplementationOnce((v: unknown) => ({ valid: true, sanitized: v }));
    const req = makeFormRequest({
      intent: "save",
      fyndEnvironment: "prod",
      fyndCustomBaseUrl: "",
      appMode: "dev",
      fyndCompanyId: "",
      fyndApplicationId: "",
      fyndClientId: "",
      fyndClientSecret: "",
      policyReturnWindowDays: "30",
      policyAllowExchange: "on",
      policyMinOrderValue: "5",
      policyRefundMethods: ["original_payment", "store_credit"],
      policyDefaultRefundMethod: "invalid_method",
      policyExcludedTags: "tag1, tag2",
      policyAllowedCategories: "cat1",
      policyRestockFeePercent: "200",
      gorgiasEnabled: "on",
      gorgiasApiKey: "__UNCHANGED__",
    });
    const result = (await integrationsAction({
      request: req,
      params: {},
      context: {},
    } as unknown as Parameters<typeof integrationsAction>[0])) as {
      success: boolean;
      tokenUpdated?: boolean;
    };
    expect(result.success).toBe(true);
    expect(result.tokenUpdated).toBe(false);
    expect(upsert).toHaveBeenCalled();
  });

  it("integrations action: clear_token nulls credentials + test_platform error path returns testResult=false", async () => {
    const auth = authenticate.admin as unknown as ReturnType<typeof vi.fn>;
    const findUnique = (
      prisma as unknown as { shop: { findUnique: ReturnType<typeof vi.fn> } }
    ).shop.findUnique;
    const upsertSettings = (
      prisma as unknown as {
        shopSettings: { upsert: ReturnType<typeof vi.fn> };
      }
    ).shopSettings.upsert;

    // Path 1: clear_token intent — covers the clear/null branch + create-shop fallback.
    auth.mockResolvedValueOnce({ session: { shop: "x.myshopify.com" } });
    findUnique.mockResolvedValueOnce(null); // forces shop.create branch (line 288)
    const create = (
      prisma as unknown as { shop: { create: ReturnType<typeof vi.fn> } }
    ).shop.create;
    create.mockResolvedValueOnce({ id: "shop_new", shopDomain: "x.myshopify.com" });
    upsertSettings.mockResolvedValueOnce({});
    const clearReq = makeFormRequest({ intent: "clear_token" });
    const r1 = (await integrationsAction({
      request: clearReq,
      params: {},
      context: {},
    } as unknown as Parameters<typeof integrationsAction>[0])) as {
      success: boolean;
      cleared?: boolean;
    };
    expect(r1.success).toBe(true);
    expect(r1.cleared).toBe(true);

    // Path 2: test_platform with downstream failure — covers `rawResult.ok=false`
    // branch and propagates the platform error string.
    const { testPlatformConnectionRaw } = await import(
      "../../lib/fynd.server"
    );
    const tpc = testPlatformConnectionRaw as unknown as ReturnType<typeof vi.fn>;
    tpc.mockResolvedValueOnce({ ok: false, error: "401 invalid_credentials" });
    auth.mockResolvedValueOnce({ session: { shop: "x.myshopify.com" } });
    findUnique.mockResolvedValueOnce({
      id: "shop_2",
      shopDomain: "x.myshopify.com",
      settings: {
        fyndCredentials: 'enc({"platform":{"clientId":"c","clientSecret":"s"}})',
        fyndApplicationId: "A1",
        fyndCompanyId: "C1",
      },
    });
    const { getNormalizedCredentialsFromRaw } = await import(
      "../../lib/fynd.server"
    );
    (
      getNormalizedCredentialsFromRaw as unknown as ReturnType<typeof vi.fn>
    ).mockReturnValueOnce({ platform: { clientId: "c", clientSecret: "s" } });
    const testReq = makeFormRequest({
      intent: "test_platform",
      fyndCompanyId: "C1",
      fyndApplicationId: "A1",
      fyndClientId: "c",
      fyndClientSecret: "s",
      fyndEnvironment: "uat",
      fyndCustomBaseUrl: "",
    });
    const r2 = (await integrationsAction({
      request: testReq,
      params: {},
      context: {},
    } as unknown as Parameters<typeof integrationsAction>[0])) as {
      success: boolean;
      error?: string;
      testResult?: boolean;
    };
    expect(r2.success).toBe(false);
    expect(r2.testResult).toBe(false);
    expect(r2.error).toBe("401 invalid_credentials");
  });

  it("integrations action: sanitizeCredentialInputs validation failure returns success=false with error", async () => {
    const auth = authenticate.admin as unknown as ReturnType<typeof vi.fn>;
    auth.mockResolvedValueOnce({ session: { shop: "x.myshopify.com" } });
    (
      sanitizeCredentialInputs as unknown as ReturnType<typeof vi.fn>
    ).mockImplementationOnce(() => ({ valid: false, error: "bad input X" }));
    const req = makeFormRequest({
      intent: "save",
      fyndEnvironment: "uat",
      appMode: "prod",
      fyndCompanyId: "0xBAD",
      fyndApplicationId: "0xBAD",
      fyndClientId: "0xBAD",
      fyndClientSecret: "0xBAD",
      policyReturnWindowDays: "30",
    });
    const result = (await integrationsAction({
      request: req,
      params: {},
      context: {},
    } as unknown as Parameters<typeof integrationsAction>[0])) as {
      success: boolean;
      error?: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe("bad input X");
  });
});
