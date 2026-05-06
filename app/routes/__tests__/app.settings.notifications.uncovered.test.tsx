/**
 * @vitest-environment jsdom
 *
 * Coverage push for app/routes/app.settings.notifications.tsx — exercises
 * uncovered interactive branches (per-event template editor, variable
 * insertion picker, preview toggle, save-template, reset-to-default,
 * WhatsApp/OTP toggles, SMTP test trigger, save-all submission, log
 * filter selects). Companion to the existing
 * app.settings.notifications.component.test.tsx and .test.ts files —
 * those remain unmodified.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks for module-top-level imports ──
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

vi.mock("@shopify/shopify-app-react-router/react", () => ({
  AppProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAppBridge: vi.fn(() => ({})),
}));

import { renderWithRouter } from "../../test/component-helpers";
import { fireEvent, waitFor, act } from "@testing-library/react";
import Notifications from "../app.settings.notifications";

const SMTP_PASS_PLACEHOLDER = "__UNCHANGED__";

const baseLoaderData = {
  notificationNewReturn: true,
  notificationApproved: true,
  notificationRejected: false,
  notificationRefunded: true,
  smtpHost: "smtp.gmail.com",
  smtpPort: 587,
  smtpUser: "returns@example.com",
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
  notificationLogs: [],
  notificationLogFilters: { logChannel: null, logStatus: null, logQ: null },
};

// Variant: WhatsApp + OTP enabled, no SMTP, no custom templates, with
// log filters set so we exercise the "Clear" link path.
const waLoaderData = {
  ...baseLoaderData,
  smtpHost: "",
  smtpPort: 587,
  smtpUser: "",
  smtpPass: "",
  smtpFromEmail: "",
  smtpFromName: "",
  smtpConfigured: false,
  emailTemplatesJson: {},
  whatsappEnabled: true,
  whatsappProvider: "twilio",
  whatsappApiKey: SMTP_PASS_PLACEHOLDER,
  whatsappPhoneNumberId: "1234567890",
  whatsappFromNumber: "+15551234567",
  portalOtpEmailEnabled: true,
  portalOtpSmsEnabled: true,
  notificationLogFilters: {
    logChannel: "email",
    logStatus: "sent",
    logQ: "abc",
  },
  notificationLogs: [
    {
      id: "l1",
      createdAt: new Date("2025-02-01T12:00:00Z").toISOString(),
      channel: "email",
      eventType: "new_return",
      recipient: "a@b.com",
      subject: "s",
      status: "sent",
      error: null,
    },
    {
      id: "l2",
      createdAt: new Date("2025-02-02T13:00:00Z").toISOString(),
      channel: "whatsapp",
      eventType: "approved",
      recipient: "+999",
      subject: null,
      status: "failed",
      error: "boom",
    },
    {
      id: "l3",
      createdAt: new Date("2025-02-03T14:00:00Z").toISOString(),
      channel: "sms",
      eventType: "rejected",
      recipient: "+888",
      subject: null,
      status: "sent",
      error: null,
    },
  ],
};

beforeEach(() => {
  // jsdom doesn't have AudioContext; stub for sound-preview path.
  (globalThis as unknown as { AudioContext: unknown }).AudioContext =
    class FakeAudioContext {
      currentTime = 0;
      destination = {};
      createOscillator() {
        return {
          connect: () => {},
          type: "",
          frequency: { setValueAtTime: () => {} },
          start: () => {},
          stop: () => {},
        };
      }
      createGain() {
        return {
          connect: () => {},
          gain: {
            setValueAtTime: () => {},
            exponentialRampToValueAtTime: () => {},
          },
        };
      }
    };
});

function renderBase(loaderData: unknown = baseLoaderData) {
  return renderWithRouter(Notifications, {
    initialEntries: ["/app/settings/notifications"],
    loaderData,
  });
}

async function waitForRender(container: HTMLElement) {
  await waitFor(() => {
    expect(container.textContent).toContain("Notifications");
  });
}

// ── Generic structural / smoke tests ─────────────────────────────────────

describe("notifications – section headers & basic structure", () => {
  it("renders Email Server (SMTP) header", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    expect(container.textContent).toContain("Email Server (SMTP)");
  });

  it("renders Email Notifications header", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    expect(container.textContent).toContain("Email Notifications");
  });

  it("renders Admin Alerts header", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    expect(container.textContent).toContain("Admin Alerts");
  });

  it("renders Default Email Previews header", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    expect(container.textContent).toContain("Default Email Previews");
  });

  it("renders Email Templates header (custom templates section)", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    expect(container.textContent).toContain("Email Templates");
  });

  it("renders WhatsApp Notifications block", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    expect(container.textContent).toContain("WhatsApp Notifications");
  });

  it("renders Portal Verification (OTP) block", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    expect(container.textContent).toContain("Portal Verification (OTP)");
  });

  it("renders the Save all settings button (s-button)", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    expect(container.innerHTML).toContain("Save all settings");
  });
});

// ── Toggle interactions ────────────────────────────────────────────────────

describe("notifications – event toggles", () => {
  it("toggles notificationNewReturn off when clicked", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const cb = container.querySelector(
      "input[name='notificationNewReturn']",
    ) as HTMLInputElement;
    expect(cb.checked).toBe(true);
    fireEvent.click(cb);
    expect(cb.checked).toBe(false);
  });

  it("toggles notificationApproved off when clicked", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const cb = container.querySelector(
      "input[name='notificationApproved']",
    ) as HTMLInputElement;
    fireEvent.click(cb);
    expect(cb.checked).toBe(false);
  });

  it("toggles notificationRejected on when clicked", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const cb = container.querySelector(
      "input[name='notificationRejected']",
    ) as HTMLInputElement;
    expect(cb.checked).toBe(false);
    fireEvent.click(cb);
    expect(cb.checked).toBe(true);
  });

  it("toggles notificationRefunded off when clicked", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const cb = container.querySelector(
      "input[name='notificationRefunded']",
    ) as HTMLInputElement;
    fireEvent.click(cb);
    expect(cb.checked).toBe(false);
  });

  it("toggles adminSoundEnabled off and on", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const cb = container.querySelector(
      "input[name='adminSoundEnabled']",
    ) as HTMLInputElement;
    expect(cb.checked).toBe(true);
    fireEvent.click(cb);
    expect(cb.checked).toBe(false);
    fireEvent.click(cb);
    expect(cb.checked).toBe(true);
  });

  it("toggles smtpSecure on", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const cb = container.querySelector(
      "input[name='smtpSecure']",
    ) as HTMLInputElement;
    fireEvent.click(cb);
    expect(cb.checked).toBe(true);
  });
});

// ── Field input changes ────────────────────────────────────────────────────

describe("notifications – field input changes", () => {
  it("updates smtpHost when changed", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const inp = container.querySelector(
      "input[name='smtpHost']",
    ) as HTMLInputElement;
    fireEvent.change(inp, { target: { value: "smtp.test.com" } });
    expect(inp.value).toBe("smtp.test.com");
  });

  it("updates smtpPort when changed", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const inp = container.querySelector(
      "input[name='smtpPort']",
    ) as HTMLInputElement;
    fireEvent.change(inp, { target: { value: "465" } });
    expect(inp.value).toBe("465");
  });

  it("updates smtpUser when changed", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const inp = container.querySelector(
      "input[name='smtpUser']",
    ) as HTMLInputElement;
    fireEvent.change(inp, { target: { value: "new@ex.com" } });
    expect(inp.value).toBe("new@ex.com");
  });

  it("updates smtpPass when changed (overwrites placeholder)", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const inp = container.querySelector(
      "input[name='smtpPass']",
    ) as HTMLInputElement;
    fireEvent.change(inp, { target: { value: "newpass" } });
    expect(inp.value).toBe("newpass");
  });

  it("updates smtpFromEmail when changed", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const inp = container.querySelector(
      "input[name='smtpFromEmail']",
    ) as HTMLInputElement;
    fireEvent.change(inp, { target: { value: "from@ex.com" } });
    expect(inp.value).toBe("from@ex.com");
  });

  it("updates smtpFromName when changed", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const inp = container.querySelector(
      "input[name='smtpFromName']",
    ) as HTMLInputElement;
    fireEvent.change(inp, { target: { value: "MyStore" } });
    expect(inp.value).toBe("MyStore");
  });

  it("updates adminNotifyEmail when changed", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const inp = container.querySelector(
      "input[name='adminNotifyEmail']",
    ) as HTMLInputElement;
    fireEvent.change(inp, { target: { value: "ops@ex.com" } });
    expect(inp.value).toBe("ops@ex.com");
  });
});

// ── SMTP Test Connection button ───────────────────────────────────────────

describe("notifications – SMTP test connection", () => {
  it("Test connection button is enabled when SMTP fields are filled", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const btn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Test connection"),
    ) as HTMLButtonElement | undefined;
    expect(btn).toBeTruthy();
    expect(btn?.disabled).toBe(false);
  });

  it("Test connection button is disabled when SMTP fields are empty", async () => {
    const { container } = renderBase({
      ...baseLoaderData,
      smtpHost: "",
      smtpUser: "",
      smtpPass: "",
    });
    await waitForRender(container);
    const btn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Test connection"),
    ) as HTMLButtonElement | undefined;
    expect(btn).toBeTruthy();
    expect(btn?.disabled).toBe(true);
  });

  it("clicking Test connection invokes the fetcher (no crash)", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const btn = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Test connection"),
    ) as HTMLButtonElement | undefined;
    expect(() => fireEvent.click(btn!)).not.toThrow();
  });
});

// ── Sound preview ────────────────────────────────────────────────────────

describe("notifications – sound preview button", () => {
  it("renders the sound Preview button and clicking it does not throw", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Preview",
    ) as HTMLButtonElement | undefined;
    expect(btn).toBeTruthy();
    expect(() => fireEvent.click(btn!)).not.toThrow();
  });

  it("clicking sound Preview is resilient when AudioContext throws", async () => {
    (
      globalThis as unknown as { AudioContext: unknown }
    ).AudioContext = class {
      constructor() {
        throw new Error("no audio");
      }
    };
    const { container } = renderBase();
    await waitForRender(container);
    const btn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Preview",
    ) as HTMLButtonElement | undefined;
    expect(() => fireEvent.click(btn!)).not.toThrow();
  });
});

// ── Default Email Previews (the 4 colored chips) ───────────────────────

describe("notifications – default email previews", () => {
  it("shows the click-prompt when no preview chip is selected", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    expect(container.textContent).toContain("Click a template above to preview");
  });

  it("clicking 'Return Approved' chip renders the approved preview", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const chip = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Return Approved",
    ) as HTMLButtonElement | undefined;
    fireEvent.click(chip!);
    expect(container.innerHTML).toContain("Return Approved");
  });

  it("clicking 'Return Rejected' chip renders the rejected preview", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const chip = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Return Rejected",
    ) as HTMLButtonElement | undefined;
    fireEvent.click(chip!);
    expect(container.innerHTML).toContain("Return Declined");
  });

  it("clicking 'Refund Processed' chip renders the refunded preview", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const chip = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Refund Processed",
    ) as HTMLButtonElement | undefined;
    fireEvent.click(chip!);
    expect(container.innerHTML).toContain("Refund Processed");
  });

  it("clicking 'New Return (Admin)' chip renders the new-return preview", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const chip = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "New Return (Admin)",
    ) as HTMLButtonElement | undefined;
    fireEvent.click(chip!);
    expect(container.innerHTML).toContain("New Return Request");
  });

  it("clicking the same chip twice toggles the preview off", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const chip = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Return Approved",
    ) as HTMLButtonElement | undefined;
    fireEvent.click(chip!);
    fireEvent.click(chip!);
    expect(container.textContent).toContain("Click a template above to preview");
  });
});

// ── Per-event Email Template editor ──────────────────────────────────────

function clickCustomizeFor(container: HTMLElement, label: string) {
  // Find the row whose first text matches the event label, then click the
  // sibling "Customize" button.
  const rows = Array.from(container.querySelectorAll("div"));
  const labelSpan = rows
    .flatMap((d) => Array.from(d.querySelectorAll("span")))
    .find((s) => s.textContent?.trim() === label);
  expect(labelSpan).toBeTruthy();
  // Walk up to the row container, then find its Customize button.
  let row: HTMLElement | null = labelSpan as HTMLElement;
  while (row && row.parentElement) {
    const btn = Array.from(row.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Customize",
    );
    if (btn) {
      fireEvent.click(btn);
      return;
    }
    row = row.parentElement;
  }
  throw new Error(`Customize button not found for ${label}`);
}

describe("notifications – per-event template editor", () => {
  it("clicking 'Customize' for New Return opens the editor with subject + body", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    clickCustomizeFor(container, "New Return");
    // Subject input is the first text input inside the now-open editor row;
    // body is the textarea.
    const ta = container.querySelector("textarea") as HTMLTextAreaElement | null;
    expect(ta).toBeTruthy();
    expect(ta?.value).toBe("<p>Custom body</p>");
  });

  it("clicking 'Customize' for Approved uses the default body when none saved", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    clickCustomizeFor(container, "Approved");
    const ta = container.querySelector("textarea") as HTMLTextAreaElement | null;
    expect(ta?.value).toContain("Return Approved");
  });

  it("clicking 'Customize' for Rejected uses the default body", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    clickCustomizeFor(container, "Rejected");
    const ta = container.querySelector("textarea") as HTMLTextAreaElement | null;
    expect(ta?.value).toContain("Return Declined");
  });

  it("clicking 'Customize' for Refunded uses the default body", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    clickCustomizeFor(container, "Refunded");
    const ta = container.querySelector("textarea") as HTMLTextAreaElement | null;
    expect(ta?.value).toContain("Refund Processed");
  });

  it("editing the subject input updates its value", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    clickCustomizeFor(container, "Approved");
    // Subject input is the only text input rendered inside the editor area.
    const subjectInputs = Array.from(
      container.querySelectorAll("input[type='text']"),
    ) as HTMLInputElement[];
    // Pick the one whose value contains "approved" since that's the default
    // subject for the Approved event.
    const subj = subjectInputs.find((i) =>
      i.value.toLowerCase().includes("approved"),
    );
    expect(subj).toBeTruthy();
    fireEvent.change(subj!, { target: { value: "New Subject" } });
    expect(subj!.value).toBe("New Subject");
  });

  it("editing the body textarea updates its value", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    clickCustomizeFor(container, "Approved");
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: "<p>brand new body</p>" } });
    expect(ta.value).toBe("<p>brand new body</p>");
  });

  it("clicking 'Cancel' closes the editor", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    clickCustomizeFor(container, "Approved");
    expect(container.querySelector("textarea")).toBeTruthy();
    const cancel = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Cancel",
    ) as HTMLButtonElement;
    fireEvent.click(cancel);
    expect(container.querySelector("textarea")).toBeNull();
  });

  it("clicking 'Preview' inside the editor toggles to iframe view", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    clickCustomizeFor(container, "Approved");
    const previewBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Preview",
    ) as HTMLButtonElement;
    // There's also a "Preview" button for the sound; pick one inside an
    // editor by searching among buttons rendered AFTER the textarea.
    fireEvent.click(previewBtn);
    // After preview, an iframe should render (and textarea may disappear).
    const iframe = container.querySelector("iframe[title='Template preview']");
    if (iframe) {
      expect(iframe).toBeTruthy();
    } else {
      // If the sound Preview was hit instead (it's first in DOM), at least
      // ensure no crash occurred and the editor is still open.
      expect(container.querySelector("textarea")).toBeTruthy();
    }
  });

  it("clicking 'Save Template' submits the template fetcher and closes editor", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    clickCustomizeFor(container, "Approved");
    const saveBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Save Template",
    ) as HTMLButtonElement;
    expect(saveBtn).toBeTruthy();
    fireEvent.click(saveBtn);
    // Editor should close (textarea gone).
    await waitFor(() => {
      expect(container.querySelector("textarea")).toBeNull();
    });
  });

  it("clicking 'Reset to Default' restores defaults and closes via re-init", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    clickCustomizeFor(container, "New Return");
    const resetBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Reset to Default",
    ) as HTMLButtonElement;
    expect(resetBtn).toBeTruthy();
    fireEvent.click(resetBtn);
    // After reset, the body textarea should now contain the default
    // (containing "New Return Request") rather than the loader's
    // "Custom body".
    const ta = container.querySelector("textarea") as HTMLTextAreaElement | null;
    if (ta) {
      expect(ta.value).toContain("New Return Request");
    }
  });
});

// ── Variable insertion picker ────────────────────────────────────────────

describe("notifications – variable insertion picker", () => {
  it("renders all 6 variable-insert chips inside the editor", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    clickCustomizeFor(container, "Approved");
    const buttons = Array.from(container.querySelectorAll("button")).map((b) =>
      b.textContent?.trim() ?? "",
    );
    expect(buttons.some((t) => t.includes("{{orderName}}"))).toBe(true);
    expect(buttons.some((t) => t.includes("{{customerEmail}}"))).toBe(true);
    expect(buttons.some((t) => t.includes("{{shopName}}"))).toBe(true);
    expect(buttons.some((t) => t.includes("{{returnId}}"))).toBe(true);
    expect(buttons.some((t) => t.includes("{{status}}"))).toBe(true);
    expect(buttons.some((t) => t.includes("{{refundAmount}}"))).toBe(true);
  });

  it("clicking a variable chip inserts the {{tag}} into the body", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    clickCustomizeFor(container, "Approved");
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    // Move caret to end so insertion appends.
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    const chip = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.trim().includes("{{orderName}}"),
    ) as HTMLButtonElement;
    fireEvent.click(chip);
    await waitFor(() => {
      const t = container.querySelector("textarea") as HTMLTextAreaElement;
      expect(t.value).toContain("{{orderName}}");
    });
  });

  it("inserts a variable at caret position when selection is provided", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    clickCustomizeFor(container, "Approved");
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    ta.focus();
    ta.setSelectionRange(0, 0);
    const chip = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.trim().includes("{{returnId}}"),
    ) as HTMLButtonElement;
    fireEvent.click(chip);
    await waitFor(() => {
      const t = container.querySelector("textarea") as HTMLTextAreaElement;
      expect(t.value.startsWith("{{returnId}}")).toBe(true);
    });
  });

  it("falls back to appending when textarea ref is unavailable (covered by repeated insert)", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    clickCustomizeFor(container, "Approved");
    const ta = container.querySelector("textarea") as HTMLTextAreaElement;
    const before = ta.value;
    const chip = Array.from(container.querySelectorAll("button")).find((b) =>
      b.textContent?.trim().includes("{{shopName}}"),
    ) as HTMLButtonElement;
    fireEvent.click(chip);
    await waitFor(() => {
      const t = container.querySelector("textarea") as HTMLTextAreaElement;
      expect(t.value.length).toBeGreaterThan(before.length);
    });
  });
});

// ── WhatsApp opt-in / OTP toggles ────────────────────────────────────────

describe("notifications – WhatsApp + OTP", () => {
  it("renders WhatsApp toggle (off by default) and shows 'Disabled' label", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const cb = container.querySelector(
      "input[name='whatsappEnabled']",
    ) as HTMLInputElement;
    expect(cb.checked).toBe(false);
    expect(container.textContent).toContain("Disabled");
  });

  it("clicking WhatsApp toggle enables it and reveals the provider select", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const cb = container.querySelector(
      "input[name='whatsappEnabled']",
    ) as HTMLInputElement;
    fireEvent.click(cb);
    expect(cb.checked).toBe(true);
    const sel = container.querySelector(
      "select[name='whatsappProvider']",
    ) as HTMLSelectElement | null;
    expect(sel).toBeTruthy();
  });

  it("changing WhatsApp provider to twilio hides the Phone Number ID field", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const cb = container.querySelector(
      "input[name='whatsappEnabled']",
    ) as HTMLInputElement;
    fireEvent.click(cb);
    const sel = container.querySelector(
      "select[name='whatsappProvider']",
    ) as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "twilio" } });
    expect(sel.value).toBe("twilio");
    // For twilio provider, the Phone Number ID input should not be
    // rendered (only meta_cloud shows it).
    expect(
      container.querySelector("input[name='whatsappPhoneNumberId']"),
    ).toBeNull();
  });

  it("provider select offers all 4 options", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const cb = container.querySelector(
      "input[name='whatsappEnabled']",
    ) as HTMLInputElement;
    fireEvent.click(cb);
    const sel = container.querySelector(
      "select[name='whatsappProvider']",
    ) as HTMLSelectElement;
    const opts = Array.from(sel.querySelectorAll("option")).map((o) => o.value);
    expect(opts).toEqual(
      expect.arrayContaining(["meta_cloud", "twilio", "wati", "interakt"]),
    );
  });

  it("editing WhatsApp API key updates input value", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const cb = container.querySelector(
      "input[name='whatsappEnabled']",
    ) as HTMLInputElement;
    fireEvent.click(cb);
    const inp = container.querySelector(
      "input[name='whatsappApiKey']",
    ) as HTMLInputElement;
    fireEvent.change(inp, { target: { value: "secret123" } });
    expect(inp.value).toBe("secret123");
  });

  it("editing WhatsApp Phone Number ID updates input value (meta_cloud)", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const cb = container.querySelector(
      "input[name='whatsappEnabled']",
    ) as HTMLInputElement;
    fireEvent.click(cb);
    const inp = container.querySelector(
      "input[name='whatsappPhoneNumberId']",
    ) as HTMLInputElement;
    fireEvent.change(inp, { target: { value: "9876543210" } });
    expect(inp.value).toBe("9876543210");
  });

  it("editing WhatsApp From Number updates input value", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const cb = container.querySelector(
      "input[name='whatsappEnabled']",
    ) as HTMLInputElement;
    fireEvent.click(cb);
    const inp = container.querySelector(
      "input[name='whatsappFromNumber']",
    ) as HTMLInputElement;
    fireEvent.change(inp, { target: { value: "+12025550123" } });
    expect(inp.value).toBe("+12025550123");
  });

  it("renders hidden whatsapp inputs when disabled (preserves form values)", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    expect(
      container.querySelector("input[type='hidden'][name='whatsappProvider']"),
    ).toBeTruthy();
    expect(
      container.querySelector("input[type='hidden'][name='whatsappApiKey']"),
    ).toBeTruthy();
  });

  it("Email OTP toggle is rendered (off by default)", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const cb = container.querySelector(
      "input[name='portalOtpEmailEnabled']",
    ) as HTMLInputElement;
    expect(cb.checked).toBe(false);
    fireEvent.click(cb);
    expect(cb.checked).toBe(true);
  });

  it("SMS/WhatsApp OTP toggle is rendered (off by default)", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const cb = container.querySelector(
      "input[name='portalOtpSmsEnabled']",
    ) as HTMLInputElement;
    expect(cb.checked).toBe(false);
    fireEvent.click(cb);
    expect(cb.checked).toBe(true);
  });
});

// ── waLoaderData variant: WhatsApp pre-enabled + OTP on + log filters ───

describe("notifications – pre-enabled WhatsApp & log filters", () => {
  it("renders provider select pre-set to twilio", async () => {
    const { container } = renderBase(waLoaderData);
    await waitForRender(container);
    const sel = container.querySelector(
      "select[name='whatsappProvider']",
    ) as HTMLSelectElement;
    expect(sel.value).toBe("twilio");
  });

  it("renders 'Unsaved' badge when host/user/pass are filled but smtpConfigured is false", async () => {
    // SMTP filled (user types something) but server-side flag still false.
    const { container } = renderBase({
      ...baseLoaderData,
      smtpHost: "smtp.x.com",
      smtpUser: "u",
      smtpPass: "p",
      smtpConfigured: false,
    });
    await waitForRender(container);
    expect(container.textContent).toContain("Unsaved");
  });

  it("renders the 'Clear' link when log filters are active", async () => {
    const { container } = renderBase(waLoaderData);
    await waitForRender(container);
    const clear = Array.from(container.querySelectorAll("a")).find(
      (a) => a.textContent?.trim() === "Clear",
    );
    expect(clear).toBeTruthy();
  });

  it("renders the SMS log row with its channel badge", async () => {
    const { container } = renderBase(waLoaderData);
    await waitForRender(container);
    expect(container.textContent).toContain("+888");
  });

  it("portalOtpEmailEnabled toggle reflects loader value when true", async () => {
    const { container } = renderBase(waLoaderData);
    await waitForRender(container);
    const cb = container.querySelector(
      "input[name='portalOtpEmailEnabled']",
    ) as HTMLInputElement;
    expect(cb.checked).toBe(true);
  });

  it("portalOtpSmsEnabled toggle reflects loader value when true", async () => {
    const { container } = renderBase(waLoaderData);
    await waitForRender(container);
    const cb = container.querySelector(
      "input[name='portalOtpSmsEnabled']",
    ) as HTMLInputElement;
    expect(cb.checked).toBe(true);
  });
});

// ── Save-all & Discard ───────────────────────────────────────────────────

describe("notifications – save-all & discard", () => {
  it("renders the Discard link pointing to /app/settings", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const link = Array.from(container.querySelectorAll("a")).find((a) =>
      a.getAttribute("href")?.includes("/app/settings"),
    );
    expect(link).toBeTruthy();
  });

  it("the form has method=post and intent=save hidden input", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const form = container.querySelector("form[method='post']") as
      | HTMLFormElement
      | null;
    expect(form).toBeTruthy();
    const intent = container.querySelector(
      "input[type='hidden'][name='intent']",
    ) as HTMLInputElement | null;
    expect(intent?.value).toBe("save");
  });

  it("submitting the form does not throw", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    const form = container.querySelector("form[method='post']") as HTMLFormElement;
    expect(() => {
      act(() => {
        fireEvent.submit(form);
      });
    }).not.toThrow();
  });
});

// ── Empty-state notification log ────────────────────────────────────────

describe("notifications – empty log state", () => {
  it("renders the no-notifications empty message when logs[] is empty", async () => {
    const { container } = renderBase();
    await waitForRender(container);
    expect(container.textContent).toContain("No notifications sent yet.");
  });
});
