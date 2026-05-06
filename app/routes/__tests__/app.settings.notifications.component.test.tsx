/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Mocks for module-top-level imports in app/routes/app.settings.notifications.tsx ──
// The component imports authenticate/prisma and a handful of server-only libs at
// module scope. Stub these so importing the route in jsdom doesn't crash on
// Node-only deps (encryption/crypto, smtp test, etc.).
vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));

vi.mock("../db.server", () => ({
  default: {
    shopSettings: { upsert: vi.fn() },
    notificationLog: { findMany: vi.fn() },
    shop: { findUnique: vi.fn(), create: vi.fn() },
  },
}));

vi.mock("../lib/shop.server", () => ({
  findOrCreateShop: vi.fn(),
}));

vi.mock("../lib/notification.server", () => ({
  testSmtpConnection: vi.fn(),
}));

vi.mock("../lib/encryption.server", () => ({
  encryptIfNeeded: vi.fn((v: string) => v),
  decryptIfEncrypted: vi.fn((v: string) => v),
  looksEncrypted: vi.fn(() => false),
}));

// boundary helpers used by the server entry — stub for safety against
// transitive module evaluation.
vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: {
    error: vi.fn(() => null),
    headers: vi.fn(() => ({})),
  },
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
import Notifications from "../app.settings.notifications";

// Mirror the loader's masked-password sentinel exactly. The form should render
// this string in the password fields when SMTP / WhatsApp credentials are
// already configured — the real values must NEVER reach the browser.
const SMTP_PASS_PLACEHOLDER = "__UNCHANGED__";

const baseLoaderData = {
  notificationNewReturn: true,
  notificationApproved: true,
  notificationRejected: false,
  notificationRefunded: true,
  smtpHost: "smtp.gmail.com",
  smtpPort: 587,
  smtpUser: "returns@example.com",
  // Loader returns the sentinel (not the real password) when one is configured.
  smtpPass: SMTP_PASS_PLACEHOLDER,
  smtpFromEmail: "returns@example.com",
  smtpFromName: "Example Store Returns",
  smtpSecure: false,
  adminNotifyEmail: "admin@example.com",
  adminSoundEnabled: true,
  smtpConfigured: true,
  emailTemplatesJson: {
    new_return: { subject: "Custom subject", bodyHtml: "<p>Custom body</p>" },
  },
  whatsappEnabled: false,
  whatsappProvider: "meta_cloud",
  whatsappApiKey: "",
  whatsappPhoneNumberId: "",
  whatsappFromNumber: "",
  portalOtpEmailEnabled: false,
  portalOtpSmsEnabled: false,
  notificationLogs: [
    {
      id: "log-1",
      createdAt: new Date("2025-01-15T10:30:00Z").toISOString(),
      channel: "email",
      eventType: "new_return",
      recipient: "customer@example.com",
      subject: "Your return",
      status: "sent",
      error: null,
    },
    {
      id: "log-2",
      createdAt: new Date("2025-01-14T08:00:00Z").toISOString(),
      channel: "whatsapp",
      eventType: "approved",
      recipient: "+15551234567",
      subject: null,
      status: "failed",
      error: "Provider rejected",
    },
  ],
  notificationLogFilters: { logChannel: null, logStatus: null, logQ: null },
};

describe("Notifications settings (default export)", () => {
  it("renders the page heading", async () => {
    const { container } = renderWithRouter(Notifications, {
      initialEntries: ["/app/settings/notifications"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Notifications");
    });
  });

  it("renders the SMTP password input with the masked sentinel value", async () => {
    const { container } = renderWithRouter(Notifications, {
      initialEntries: ["/app/settings/notifications"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("input[name='smtpPass']")).toBeTruthy();
    });
    const passInput = container.querySelector("input[name='smtpPass']") as HTMLInputElement | null;
    expect(passInput).toBeTruthy();
    expect(passInput?.getAttribute("type")).toBe("password");
    // The masked sentinel — never the real password — must populate the field
    // when SMTP credentials are configured.
    expect(passInput?.value).toBe(SMTP_PASS_PLACEHOLDER);
  });

  it("renders all SMTP fields (host, port, user, from email/name)", async () => {
    const { container } = renderWithRouter(Notifications, {
      initialEntries: ["/app/settings/notifications"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("input[name='smtpHost']")).toBeTruthy();
    });
    const host = container.querySelector("input[name='smtpHost']") as HTMLInputElement | null;
    const port = container.querySelector("input[name='smtpPort']") as HTMLInputElement | null;
    const user = container.querySelector("input[name='smtpUser']") as HTMLInputElement | null;
    const fromEmail = container.querySelector(
      "input[name='smtpFromEmail']",
    ) as HTMLInputElement | null;
    const fromName = container.querySelector(
      "input[name='smtpFromName']",
    ) as HTMLInputElement | null;
    expect(host?.value).toBe("smtp.gmail.com");
    expect(port?.value).toBe("587");
    expect(user?.value).toBe("returns@example.com");
    expect(fromEmail?.value).toBe("returns@example.com");
    expect(fromName?.value).toBe("Example Store Returns");
  });

  it("renders the four event toggle checkboxes with the expected checked state", async () => {
    const { container } = renderWithRouter(Notifications, {
      initialEntries: ["/app/settings/notifications"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("input[name='notificationNewReturn']")).toBeTruthy();
    });
    const newReturn = container.querySelector(
      "input[name='notificationNewReturn']",
    ) as HTMLInputElement | null;
    const approved = container.querySelector(
      "input[name='notificationApproved']",
    ) as HTMLInputElement | null;
    const rejected = container.querySelector(
      "input[name='notificationRejected']",
    ) as HTMLInputElement | null;
    const refunded = container.querySelector(
      "input[name='notificationRefunded']",
    ) as HTMLInputElement | null;
    expect(newReturn?.checked).toBe(true);
    expect(approved?.checked).toBe(true);
    expect(rejected?.checked).toBe(false);
    expect(refunded?.checked).toBe(true);
  });

  it("renders the 'Connected' badge when smtpConfigured is true", async () => {
    const { container } = renderWithRouter(Notifications, {
      initialEntries: ["/app/settings/notifications"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Email Server (SMTP)");
    });
    expect(container.textContent).toContain("Connected");
  });

  it("renders the notification log filter form with channel/status selects", async () => {
    const { container } = renderWithRouter(Notifications, {
      initialEntries: ["/app/settings/notifications"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Notification Log");
    });
    const channelSelect = container.querySelector(
      "select[name='logChannel']",
    ) as HTMLSelectElement | null;
    const statusSelect = container.querySelector(
      "select[name='logStatus']",
    ) as HTMLSelectElement | null;
    const searchInput = container.querySelector("input[name='logQ']") as HTMLInputElement | null;
    expect(channelSelect).toBeTruthy();
    expect(statusSelect).toBeTruthy();
    expect(searchInput).toBeTruthy();
    // Channel select includes the documented options.
    const channelOptions = Array.from(channelSelect?.querySelectorAll("option") ?? []).map((o) =>
      o.getAttribute("value"),
    );
    expect(channelOptions).toEqual(expect.arrayContaining(["", "email", "whatsapp", "sms"]));
  });

  it("renders the notification log rows from loader data", async () => {
    const { container } = renderWithRouter(Notifications, {
      initialEntries: ["/app/settings/notifications"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Notification Log");
    });
    expect(container.textContent).toContain("customer@example.com");
    expect(container.textContent).toContain("+15551234567");
    // Status badges
    expect(container.textContent).toContain("Sent");
    expect(container.textContent).toContain("Failed");
  });

  it("renders the Email Templates section listing each event with 'Customized' badge for overridden ones", async () => {
    const { container } = renderWithRouter(Notifications, {
      initialEntries: ["/app/settings/notifications"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Email Templates");
    });
    expect(container.textContent).toContain("New Return");
    expect(container.textContent).toContain("Approved");
    expect(container.textContent).toContain("Rejected");
    expect(container.textContent).toContain("Refunded");
    // The loader returned a custom template for `new_return`, so the
    // "CUSTOMIZED" badge should appear at least once.
    expect(container.textContent?.toLowerCase()).toContain("customized");
  });
});
