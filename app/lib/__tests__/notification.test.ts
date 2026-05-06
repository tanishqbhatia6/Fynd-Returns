import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * notification.server.ts tests.
 * ────────────────────────────────────────────────────────────────────
 * This file is ~840 LOC and loads SMTP config from Prisma + sends
 * email via nodemailer + logs to Prisma again. We mock all three so
 * the test can drive the public send functions through their decision
 * branches without a real SMTP server.
 *
 * Coverage targets:
 *   - Toggle-disabled fast paths (bail immediately, no nodemailer call)
 *   - SMTP-not-configured fast paths
 *   - Missing-recipient error paths
 *   - Happy-path sendEmail → nodemailer.createTransport().sendMail()
 *   - testSmtpConnection (nodemailer.verify)
 *   - sendWhatsAppNotification (fetch mocked, no MSW — direct vi.mock)
 *
 * We deliberately don't try to cover every branch of every template
 * function; those are markup builders and the unit test for them
 * would essentially be a snapshot of the HTML.
 */

/* ── Mocks ────────────────────────────────────────────────────────── */

const { prismaMock, sendMailMock, verifyMock, createTransportMock } = vi.hoisted(() => {
  const sendMail = vi.fn();
  const verify = vi.fn();
  const createTransport = vi.fn(() => ({ sendMail, verify }));
  return {
    sendMailMock: sendMail,
    verifyMock: verify,
    createTransportMock: createTransport,
    prismaMock: {
      shop: { findUnique: vi.fn() },
      notificationLog: { create: vi.fn().mockResolvedValue({}) },
    },
  };
});

vi.mock("nodemailer", () => ({
  default: { createTransport: createTransportMock },
  createTransport: createTransportMock,
}));

vi.mock("../../db.server", () => ({ default: prismaMock }));

vi.mock("../portal-i18n", () => {
  const LABELS: Record<string, string> = {
    "email.newReturn.subject": "New return for {{order}} (ID: {{id}})",
    "email.newReturn.heading": "New return request",
    "email.newReturn.body": "A customer has submitted a return",
    "email.newReturn.requestId": "Request ID",
    "email.newReturn.customer": "Customer",
    "email.newReturn.cta": "Review it now",
    "email.approved.subject": "Your return for {{order}} is approved",
    "email.approved.heading": "Return approved",
    "email.approved.body": "Your return for {{order}} has been approved.",
    "email.approved.storeMessage": "Store message",
    "email.approved.nextSteps": "Next steps will follow",
    "email.rejected.subject": "Return request for {{order}}",
    "email.rejected.heading": "Return not approved",
    "email.rejected.body": "We've reviewed your return for {{order}}.",
    "email.rejected.reason": "Reason",
    "email.rejected.contact": "Contact us if you have questions",
    "email.refunded.subject": "Your refund for {{order}} is ready",
    "email.refunded.heading": "Refund processed",
    "email.refunded.body": "Your refund for {{order}} is on its way.",
    "email.refunded.note": "Please allow a few business days",
    "email.otp.subject": "Your code",
    "email.otp.heading": "Verify your email",
    "email.otp.body": "Here is your code",
    "email.otp.expiry": "Expires in 10 minutes",
    "email.footer.poweredBy": "Powered by Fynd Returns",
    "portal.order.orderDetails": "Order",
    "portal.order.items": "Items",
  };
  return {
    // SYNC — returns the labels map directly. The real impl is sync too.
    getPortalLabels: () => LABELS,
    t: (key: string, labels: Record<string, string>, vars?: Record<string, string>) => {
      let v = labels[key] ?? key;
      if (vars) {
        for (const [k, val] of Object.entries(vars)) {
          v = v.replace(new RegExp(`\\{\\{\\s*${k}\\s*\\}\\}`, "g"), val);
        }
      }
      return v;
    },
  };
});

vi.mock("../i18n.server", () => ({
  formatMoney: (amt: string, cur: string) => `${cur} ${amt}`,
  isRtlLocale: (locale: string) => ["ar", "he", "fa", "ur"].includes((locale || "").toLowerCase()),
}));

vi.mock("../observability/logger.server", () => ({
  notifLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../observability/tracing.server", () => ({
  withSpan: async <T>(_n: string, _a: unknown, fn: (s: unknown) => Promise<T>) =>
    fn({ setAttribute: () => {}, end: () => {} }),
  addBusinessEvent: vi.fn(),
}));

vi.mock("../encryption.server", () => ({
  decryptIfEncrypted: (v: string | null | undefined) => v ?? null,
}));

/* ── SUT imports (must come after vi.mock) ────────────────────────── */

import {
  sendNewReturnNotification,
  sendApprovalNotification,
  sendRejectionNotification,
  sendRefundNotification,
  sendOtpEmail,
  testSmtpConnection,
  sendCancellationNotification,
  sendCancellationDeclinedNotification,
  sendWhatsAppNotification,
  getWhatsAppConfig,
} from "../notification.server";

/* ── Fixtures / helpers ───────────────────────────────────────────── */

function makeShopWithSmtp(
  overrides: Partial<{
    smtpHost: string | null;
    smtpPort: number | null;
    smtpUser: string | null;
    smtpPass: string | null;
    smtpFromEmail: string | null;
    smtpFromName: string | null;
    smtpSecure: boolean;
    adminNotifyEmail: string | null;
    notificationNewReturn: boolean;
    notificationApproved: boolean;
    notificationRejected: boolean;
    notificationRefunded: boolean;
    notificationCancelled: boolean;
    emailTemplatesJson: string | null;
    portalLanguage: string | null;
    shopLocale: string | null;
    shopCurrency: string | null;
    shopTimezone: string | null;
  }> = {},
) {
  return {
    id: "shop-1",
    shopDomain: "my-shop.myshopify.com",
    settings: {
      id: "s1",
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpUser: "user@example.com",
      smtpPass: "pw",
      smtpFromEmail: "noreply@example.com",
      smtpFromName: "Test Store",
      smtpSecure: false,
      adminNotifyEmail: "admin@example.com",
      notificationNewReturn: true,
      notificationApproved: true,
      notificationRejected: true,
      notificationRefunded: true,
      notificationCancelled: true,
      emailTemplatesJson: null,
      portalLanguage: "en",
      shopLocale: "en",
      shopCurrency: "USD",
      shopTimezone: "UTC",
      ...overrides,
    },
  };
}

function makeShopWithoutSmtp() {
  return {
    id: "shop-1",
    shopDomain: "my-shop.myshopify.com",
    settings: {
      id: "s1",
      smtpHost: null,
      smtpUser: null,
      smtpPass: null,
      notificationNewReturn: true,
      notificationApproved: true,
      notificationRejected: true,
      notificationRefunded: true,
      notificationCancelled: true,
      adminNotifyEmail: null,
      emailTemplatesJson: null,
      portalLanguage: "en",
      shopCurrency: "USD",
    },
  };
}

beforeEach(() => {
  prismaMock.shop.findUnique.mockReset();
  prismaMock.notificationLog.create.mockReset().mockResolvedValue({});
  sendMailMock.mockReset();
  verifyMock.mockReset();
  createTransportMock.mockClear();
});

/* ── sendNewReturnNotification ────────────────────────────────────── */

describe("sendNewReturnNotification", () => {
  const baseParams = {
    shopDomain: "my-shop.myshopify.com",
    orderName: "#1001",
    itemCount: 2,
    returnRequestId: "RPM-A1B2C3D4",
  };

  it("returns success + skips when toggle is disabled", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(
      makeShopWithSmtp({ notificationNewReturn: false }),
    );
    const res = await sendNewReturnNotification(baseParams);
    expect(res.success).toBe(true);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("returns success + skips when SMTP not configured", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithoutSmtp());
    const res = await sendNewReturnNotification(baseParams);
    expect(res.success).toBe(true);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("returns error when no admin email configured", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp({ adminNotifyEmail: null }));
    const res = await sendNewReturnNotification(baseParams);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/admin email/i);
  });

  it("sends email to admin when SMTP + toggle on", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());
    sendMailMock.mockResolvedValue({});
    const res = await sendNewReturnNotification(baseParams);
    expect(res.success).toBe(true);
    expect(sendMailMock).toHaveBeenCalledOnce();
    const call = sendMailMock.mock.calls[0][0] as { to: string; subject: string };
    expect(call.to).toBe("admin@example.com");
    expect(call.subject).toContain("RPM-A1B2C3D4");
  });

  it("overrides recipient when params.to is provided", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());
    sendMailMock.mockResolvedValue({});
    await sendNewReturnNotification({ ...baseParams, to: "ops@example.com" });
    const call = sendMailMock.mock.calls[0][0] as { to: string };
    expect(call.to).toBe("ops@example.com");
  });

  it("uses custom template when emailTemplatesJson.new_return is set", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(
      makeShopWithSmtp({
        emailTemplatesJson: JSON.stringify({
          new_return: { subject: "Custom: {{orderName}}", bodyHtml: "<p>{{returnId}}</p>" },
        }),
      }),
    );
    sendMailMock.mockResolvedValue({});
    await sendNewReturnNotification(baseParams);
    const call = sendMailMock.mock.calls[0][0] as { subject: string; html: string };
    expect(call.subject).toBe("Custom: #1001");
    expect(call.html).toContain("RPM-A1B2C3D4");
  });

  it("returns failure when nodemailer throws permanent error", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());
    sendMailMock.mockRejectedValue(new Error("550 invalid recipient"));
    const res = await sendNewReturnNotification(baseParams);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/invalid recipient/);
  });
});

/* ── sendApprovalNotification ─────────────────────────────────────── */

describe("sendApprovalNotification", () => {
  const baseParams = {
    shopDomain: "my-shop.myshopify.com",
    to: "cust@example.com",
    orderName: "#1001",
  };

  it("skips when toggle disabled", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp({ notificationApproved: false }));
    const res = await sendApprovalNotification(baseParams);
    expect(res.success).toBe(true);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("skips when SMTP not configured", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithoutSmtp());
    const res = await sendApprovalNotification(baseParams);
    expect(res.success).toBe(true);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("sends email to customer on approval", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());
    sendMailMock.mockResolvedValue({});
    await sendApprovalNotification(baseParams);
    const call = sendMailMock.mock.calls[0][0] as { to: string; subject: string };
    expect(call.to).toBe("cust@example.com");
    expect(call.subject).toContain("#1001");
  });

  it("includes admin notes when provided", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());
    sendMailMock.mockResolvedValue({});
    await sendApprovalNotification({ ...baseParams, notes: "Please ship within 7 days" });
    const call = sendMailMock.mock.calls[0][0] as { html: string };
    expect(call.html).toContain("Please ship within 7 days");
  });
});

/* ── sendRejectionNotification ────────────────────────────────────── */

describe("sendRejectionNotification", () => {
  const baseParams = {
    shopDomain: "my-shop.myshopify.com",
    to: "cust@example.com",
    orderName: "#1001",
    rejectionReason: "Outside return window",
  };

  it("skips when toggle disabled", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp({ notificationRejected: false }));
    const res = await sendRejectionNotification(baseParams);
    expect(res.success).toBe(true);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("sends rejection email with reason in body", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());
    sendMailMock.mockResolvedValue({});
    await sendRejectionNotification(baseParams);
    const call = sendMailMock.mock.calls[0][0] as { html: string };
    expect(call.html).toContain("Outside return window");
  });
});

/* ── sendRefundNotification ───────────────────────────────────────── */

describe("sendRefundNotification", () => {
  const baseParams = {
    shopDomain: "my-shop.myshopify.com",
    to: "cust@example.com",
    orderName: "#1001",
  };

  it("skips when toggle disabled", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp({ notificationRefunded: false }));
    const res = await sendRefundNotification(baseParams);
    expect(res.success).toBe(true);
  });

  it("includes formatted refund amount + currency when provided", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());
    sendMailMock.mockResolvedValue({});
    await sendRefundNotification({ ...baseParams, amount: "49.99", currency: "USD" });
    const call = sendMailMock.mock.calls[0][0] as { html: string };
    expect(call.html).toContain("49.99");
  });

  it("handles refund with no amount (skipped in body)", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());
    sendMailMock.mockResolvedValue({});
    const res = await sendRefundNotification(baseParams);
    expect(res.success).toBe(true);
  });
});

/* ── sendOtpEmail ─────────────────────────────────────────────────── */

describe("sendOtpEmail", () => {
  it("skips silently when SMTP missing (OTP fallback)", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithoutSmtp());
    const res = await sendOtpEmail({
      shopDomain: "my-shop.myshopify.com",
      to: "cust@example.com",
      otp: "123456",
    });
    // OTP fallback returns success to avoid leaking "no SMTP" through the UI.
    expect(res.success).toBe(true);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("sends OTP email with the code in the HTML body", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());
    sendMailMock.mockResolvedValue({});
    await sendOtpEmail({
      shopDomain: "my-shop.myshopify.com",
      to: "cust@example.com",
      otp: "987654",
    });
    const call = sendMailMock.mock.calls[0][0] as { html: string; to: string };
    expect(call.to).toBe("cust@example.com");
    expect(call.html).toContain("987654");
  });
});

/* ── sendCancellationNotification ─────────────────────────────────── */

describe("sendCancellationNotification", () => {
  it("skips when toggle disabled", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(
      makeShopWithSmtp({ notificationCancelled: false }),
    );
    const res = await sendCancellationNotification({
      shopDomain: "my-shop.myshopify.com",
      to: "cust@example.com",
      orderName: "#1001",
    });
    expect(res.success).toBe(true);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("sends cancellation email when enabled", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());
    sendMailMock.mockResolvedValue({});
    await sendCancellationNotification({
      shopDomain: "my-shop.myshopify.com",
      to: "cust@example.com",
      orderName: "#1001",
    });
    expect(sendMailMock).toHaveBeenCalledOnce();
  });
});

describe("sendCancellationDeclinedNotification", () => {
  it("always sends (no toggle)", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());
    sendMailMock.mockResolvedValue({});
    const res = await sendCancellationDeclinedNotification({
      shopDomain: "my-shop.myshopify.com",
      to: "cust@example.com",
      orderName: "#1001",
    });
    expect(res.success).toBe(true);
    expect(sendMailMock).toHaveBeenCalled();
  });

  it("returns success when SMTP missing (best-effort)", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithoutSmtp());
    const res = await sendCancellationDeclinedNotification({
      shopDomain: "my-shop.myshopify.com",
      to: "cust@example.com",
      orderName: "#1001",
    });
    expect(res.success).toBe(true);
  });
});

/* ── testSmtpConnection ───────────────────────────────────────────── */

describe("testSmtpConnection", () => {
  it("returns success when verify() resolves", async () => {
    verifyMock.mockResolvedValue(true);
    const res = await testSmtpConnection({
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "u",
      pass: "p",
    });
    expect(res.success).toBe(true);
    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "smtp.example.com",
        port: 587,
        secure: false,
      }),
    );
  });

  it("returns failure when verify() throws", async () => {
    verifyMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await testSmtpConnection({
      host: "bad.example.com",
      port: 25,
      secure: false,
      user: "u",
      pass: "p",
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/ECONNREFUSED/);
  });
});

/* ── WhatsApp ─────────────────────────────────────────────────────── */

describe("getWhatsAppConfig", () => {
  it("returns null when no shop found", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(null);
    expect(await getWhatsAppConfig("missing.myshopify.com")).toBe(null);
  });

  it("returns null when whatsappEnabled is false", async () => {
    prismaMock.shop.findUnique.mockResolvedValue({
      settings: { whatsappEnabled: false, whatsappApiKey: "k", whatsappProvider: "meta_cloud" },
    });
    expect(await getWhatsAppConfig("x.myshopify.com")).toBe(null);
  });

  it("returns null when whatsappApiKey is missing", async () => {
    prismaMock.shop.findUnique.mockResolvedValue({
      settings: { whatsappEnabled: true, whatsappApiKey: null, whatsappProvider: "meta_cloud" },
    });
    expect(await getWhatsAppConfig("x.myshopify.com")).toBe(null);
  });

  it("returns config when all fields present", async () => {
    prismaMock.shop.findUnique.mockResolvedValue({
      settings: {
        whatsappEnabled: true,
        whatsappApiKey: "secret-key",
        whatsappProvider: "meta_cloud",
        whatsappPhoneNumberId: "pnid",
        whatsappFromNumber: "+911234567890",
      },
    });
    const cfg = await getWhatsAppConfig("x.myshopify.com");
    expect(cfg).toEqual({
      provider: "meta_cloud",
      apiKey: "secret-key",
      phoneNumberId: "pnid",
      fromNumber: "+911234567890",
    });
  });
});

describe("sendWhatsAppNotification", () => {
  const fetchSpy = vi.fn();
  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  it("fails fast with missing recipient", async () => {
    const res = await sendWhatsAppNotification(
      { provider: "meta_cloud", apiKey: "k", phoneNumberId: "p" },
      "",
      "hi",
    );
    expect(res.success).toBe(false);
  });

  it("fails fast with missing message", async () => {
    const res = await sendWhatsAppNotification(
      { provider: "meta_cloud", apiKey: "k", phoneNumberId: "p" },
      "+911234567890",
      "",
    );
    expect(res.success).toBe(false);
  });

  it("sends via Meta Cloud — prepends + to phone number if missing", async () => {
    fetchSpy.mockResolvedValue({ ok: true, text: async () => "" });
    const res = await sendWhatsAppNotification(
      { provider: "meta_cloud", apiKey: "token", phoneNumberId: "pn123" },
      "911234567890",
      "Your return is approved",
    );
    expect(res.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toContain("/pn123/messages");
    const body = JSON.parse((init as { body: string }).body);
    expect(body.to).toBe("+911234567890");
    expect(body.text.body).toBe("Your return is approved");
  });

  it("keeps + prefix when already present", async () => {
    fetchSpy.mockResolvedValue({ ok: true, text: async () => "" });
    await sendWhatsAppNotification(
      { provider: "meta_cloud", apiKey: "t", phoneNumberId: "p" },
      "+1234",
      "m",
    );
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body);
    expect(body.to).toBe("+1234");
  });

  it("returns failure on Meta Cloud 4xx/5xx", async () => {
    fetchSpy.mockResolvedValue({ ok: false, status: 401, text: async () => "invalid token" });
    const res = await sendWhatsAppNotification(
      { provider: "meta_cloud", apiKey: "bad", phoneNumberId: "p" },
      "+1",
      "m",
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/401/);
  });

  it("skips (logs + returns success) when Meta Cloud phoneNumberId is missing", async () => {
    // Falls through to the "provider not yet implemented" branch. Returns
    // success because the notification is best-effort — no WhatsApp means
    // we don't block the rest of the return flow.
    const res = await sendWhatsAppNotification({ provider: "meta_cloud", apiKey: "k" }, "+1", "m");
    expect(res.success).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips (logs + returns success) for unimplemented providers like twilio", async () => {
    const res = await sendWhatsAppNotification({ provider: "twilio", apiKey: "k" }, "+1", "m");
    expect(res.success).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
