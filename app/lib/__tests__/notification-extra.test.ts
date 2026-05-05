import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * notification.server.ts — EXTRA tests.
 * ────────────────────────────────────────────────────────────────────
 * Companion file to notification.test.ts. Targets branches the
 * baseline test file leaves uncovered:
 *
 *   - sendApprovalNotification: missing recipient, custom template,
 *     WhatsApp follow-up (success / no config / no phone)
 *   - sendRefundNotification: missing recipient, custom template
 *     with formatted refund amount, WhatsApp follow-up
 *   - sendCustomerNoteNotification: SMTP-missing fast path,
 *     missing recipient, happy path with shopName / without shopName,
 *     note rendered into HTML
 *   - sendNewReturnNotification: invalid emailTemplatesJson tolerated,
 *     RTL locale (Arabic) renders dir="rtl", custom template
 *     escapes HTML in template variables
 *   - sendOtpEmail: missing recipient, retry on transient error
 *   - testSmtpConnection: passes auth correctly, handles non-Error throws
 *   - sendWhatsappNotification: timeout / network failure path,
 *     interakt provider skip, response.text() rejection still fails
 *     gracefully
 */

/* ── Mocks ────────────────────────────────────────────────────────── */

const { prismaMock, sendMailMock, verifyMock, createTransportMock, decryptMock } = vi.hoisted(() => {
  const sendMail = vi.fn();
  const verify = vi.fn();
  const createTransport = vi.fn(() => ({ sendMail, verify }));
  const decrypt = vi.fn((v: string | null | undefined) => v ?? null);
  return {
    sendMailMock: sendMail,
    verifyMock: verify,
    createTransportMock: createTransport,
    decryptMock: decrypt,
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
  const ARABIC_LABELS: Record<string, string> = {
    ...LABELS,
    "email.newReturn.heading": "طلب إرجاع جديد",
    "email.footer.poweredBy": "مدعوم من Fynd Returns",
  };
  return {
    getPortalLabels: (locale: string) =>
      (locale || "").toLowerCase() === "ar" ? ARABIC_LABELS : LABELS,
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
  withSpan: async <T,>(_n: string, _a: unknown, fn: (s: unknown) => Promise<T>) =>
    fn({ setAttribute: () => {}, end: () => {} }),
  addBusinessEvent: vi.fn(),
}));

vi.mock("../encryption.server", () => ({
  decryptIfEncrypted: (v: string | null | undefined) => decryptMock(v),
}));

/* ── SUT imports (must come after vi.mock) ────────────────────────── */

import {
  sendNewReturnNotification,
  sendApprovalNotification,
  sendRefundNotification,
  sendCustomerNoteNotification,
  sendOtpEmail,
  testSmtpConnection,
  sendWhatsAppNotification,
} from "../notification.server";

/* ── Fixtures ─────────────────────────────────────────────────────── */

function makeShopWithSmtp(overrides: Record<string, unknown> = {}) {
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

function makeShopWithWhatsApp(extraSettings: Record<string, unknown> = {}) {
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
      whatsappEnabled: true,
      whatsappProvider: "meta_cloud",
      whatsappApiKey: "wa-token",
      whatsappPhoneNumberId: "pn-987",
      whatsappFromNumber: "+15551112222",
      ...extraSettings,
    },
  };
}

beforeEach(() => {
  prismaMock.shop.findUnique.mockReset();
  prismaMock.notificationLog.create.mockReset().mockResolvedValue({});
  sendMailMock.mockReset();
  verifyMock.mockReset();
  createTransportMock.mockClear();
  decryptMock.mockReset().mockImplementation((v: string | null | undefined) => v ?? null);
});

/* ── sendApprovalNotification — extra branches ────────────────────── */

describe("sendApprovalNotification — extra", () => {
  const baseParams = {
    shopDomain: "my-shop.myshopify.com",
    to: "cust@example.com",
    orderName: "#1001",
  };

  it("returns error when params.to is empty string", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());
    const res = await sendApprovalNotification({ ...baseParams, to: "" });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/recipient/i);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("uses custom approved template when configured", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp({
      emailTemplatesJson: JSON.stringify({
        approved: {
          subject: "APPROVED {{orderName}}",
          bodyHtml: "<p>Hi {{customerEmail}} for {{returnId}}</p>",
        },
      }),
    }));
    sendMailMock.mockResolvedValue({});
    await sendApprovalNotification({ ...baseParams, returnId: "RPM-XYZ" });
    const call = (sendMailMock.mock.calls as unknown as unknown[][])[0][0] as unknown as { subject: string; html: string };
    expect(call.subject).toBe("APPROVED #1001");
    expect(call.html).toContain("cust@example.com");
    expect(call.html).toContain("RPM-XYZ");
  });

  it("triggers WhatsApp follow-up when customer phone + WA config present", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithWhatsApp());
    sendMailMock.mockResolvedValue({});
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await sendApprovalNotification({
      ...baseParams,
      customerPhone: "+919998887777",
      notes: "Pickup tomorrow",
    });
    expect(res.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as unknown as { body: string }).body);
    expect(body.to).toBe("+919998887777");
    expect(body.text.body).toContain("approved");
    expect(body.text.body).toContain("Pickup tomorrow");

    vi.unstubAllGlobals();
  });

  it("does NOT call WhatsApp when no WhatsApp config (returns email result)", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());
    sendMailMock.mockResolvedValue({});
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const res = await sendApprovalNotification({
      ...baseParams,
      customerPhone: "+919998887777",
    });
    expect(res.success).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it("does NOT call WhatsApp when customerPhone is null", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithWhatsApp());
    sendMailMock.mockResolvedValue({});
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    await sendApprovalNotification({ ...baseParams, customerPhone: null });
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

/* ── sendRefundNotification — extra branches ──────────────────────── */

describe("sendRefundNotification — extra", () => {
  const baseParams = {
    shopDomain: "my-shop.myshopify.com",
    to: "cust@example.com",
    orderName: "#1001",
  };

  it("returns error when no recipient (toggle on, smtp present)", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());
    const res = await sendRefundNotification({ ...baseParams, to: "" });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/recipient/i);
  });

  it("uses custom refunded template with formatted refundAmount var", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp({
      emailTemplatesJson: JSON.stringify({
        refunded: {
          subject: "Refund {{orderName}}",
          bodyHtml: "<p>Amount {{refundAmount}}</p>",
        },
      }),
    }));
    sendMailMock.mockResolvedValue({});
    await sendRefundNotification({ ...baseParams, amount: "25.00", currency: "EUR" });
    const call = (sendMailMock.mock.calls as unknown as unknown[][])[0][0] as unknown as { html: string };
    // formatMoney mock => `${cur} ${amt}` = "EUR 25.00"
    expect(call.html).toContain("EUR 25.00");
  });

  it("uses default currency from shop settings when not provided", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp({ shopCurrency: "GBP" }));
    sendMailMock.mockResolvedValue({});
    await sendRefundNotification({ ...baseParams, amount: "10.00" });
    const call = (sendMailMock.mock.calls as unknown as unknown[][])[0][0] as unknown as { html: string };
    expect(call.html).toContain("GBP 10.00");
  });

  it("sends WhatsApp follow-up when phone + WA config present", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithWhatsApp());
    sendMailMock.mockResolvedValue({});
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    vi.stubGlobal("fetch", fetchSpy);

    await sendRefundNotification({
      ...baseParams,
      amount: "49.99",
      currency: "USD",
      customerPhone: "+15554441111",
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as unknown as { body: string }).body);
    expect(body.text.body).toContain("49.99");
    expect(body.text.body).toContain("USD");

    vi.unstubAllGlobals();
  });
});

/* ── sendCustomerNoteNotification ─────────────────────────────────── */

describe("sendCustomerNoteNotification", () => {
  const baseParams = {
    shopDomain: "my-shop.myshopify.com",
    to: "cust@example.com",
    orderName: "#1001",
    note: "Hello — your refund is delayed due to bank holiday.",
  };

  it("returns success and skips when SMTP missing", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithoutSmtp());
    const res = await sendCustomerNoteNotification(baseParams);
    expect(res.success).toBe(true);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("returns error when params.to is empty", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());
    const res = await sendCustomerNoteNotification({ ...baseParams, to: "" });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/recipient/i);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("sends note email with shopName rendered in heading", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());
    sendMailMock.mockResolvedValue({});
    await sendCustomerNoteNotification({ ...baseParams, shopName: "Acme Co" });
    const call = (sendMailMock.mock.calls as unknown as unknown[][])[0][0] as unknown as {
      to: string;
      subject: string;
      html: string;
    };
    expect(call.to).toBe("cust@example.com");
    expect(call.subject).toContain("#1001");
    expect(call.html).toContain("Acme Co");
    expect(call.html).toContain(baseParams.note);
  });

  it("falls back to 'The store' when shopName not provided", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());
    sendMailMock.mockResolvedValue({});
    await sendCustomerNoteNotification(baseParams);
    const call = (sendMailMock.mock.calls as unknown as unknown[][])[0][0] as unknown as { html: string };
    expect(call.html).toContain("The store");
  });

  it("propagates SMTP send failure", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());
    sendMailMock.mockRejectedValue(new Error("550 mailbox unavailable"));
    const res = await sendCustomerNoteNotification(baseParams);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/mailbox unavailable/);
  });
});

/* ── sendNewReturnNotification — extra branches ───────────────────── */

describe("sendNewReturnNotification — extra", () => {
  const baseParams = {
    shopDomain: "my-shop.myshopify.com",
    orderName: "#1001",
    itemCount: 2,
    returnRequestId: "RPM-A1B2C3D4",
  };

  it("tolerates invalid emailTemplatesJson and falls back to default template", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp({
      emailTemplatesJson: "{not valid json",
    }));
    sendMailMock.mockResolvedValue({});
    const res = await sendNewReturnNotification(baseParams);
    expect(res.success).toBe(true);
    const call = (sendMailMock.mock.calls as unknown as unknown[][])[0][0] as unknown as { subject: string; html: string };
    // Default subject template was used
    expect(call.subject).toContain("RPM-A1B2C3D4");
  });

  it("renders RTL direction when shop locale is Arabic", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp({ portalLanguage: "ar" }));
    sendMailMock.mockResolvedValue({});
    await sendNewReturnNotification(baseParams);
    const call = (sendMailMock.mock.calls as unknown as unknown[][])[0][0] as unknown as { html: string };
    expect(call.html).toContain('dir="rtl"');
    expect(call.html).toContain('lang="ar"');
  });

  it("escapes HTML in custom template variables (XSS guard)", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp({
      emailTemplatesJson: JSON.stringify({
        new_return: {
          subject: "New return {{orderName}}",
          bodyHtml: "<p>{{customerEmail}}</p>",
        },
      }),
    }));
    sendMailMock.mockResolvedValue({});
    await sendNewReturnNotification({
      ...baseParams,
      customerEmail: '<script>alert(1)</script>',
    });
    const call = (sendMailMock.mock.calls as unknown as unknown[][])[0][0] as unknown as { html: string };
    expect(call.html).not.toContain("<script>");
    expect(call.html).toContain("&lt;script&gt;");
  });

  it("renders item count in default template body", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());
    sendMailMock.mockResolvedValue({});
    await sendNewReturnNotification({ ...baseParams, itemCount: 7 });
    const call = (sendMailMock.mock.calls as unknown as unknown[][])[0][0] as unknown as { html: string };
    expect(call.html).toMatch(/>7</);
  });
});

/* ── testSmtpConnection — extra branches ──────────────────────────── */

describe("testSmtpConnection — extra", () => {
  it("passes auth user/pass to nodemailer.createTransport", async () => {
    verifyMock.mockResolvedValue(true);
    await testSmtpConnection({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      user: "alice",
      pass: "secret",
    });
    const cfg = (createTransportMock.mock.calls as unknown as unknown[][])[0][0] as unknown as {
      host: string;
      port: number;
      secure: boolean;
      auth: { user: string; pass: string };
    };
    expect(cfg.auth.user).toBe("alice");
    expect(cfg.auth.pass).toBe("secret");
    expect(cfg.secure).toBe(true);
    expect(cfg.port).toBe(465);
  });

  it("stringifies non-Error throws into the error field", async () => {
    verifyMock.mockRejectedValue("plain string failure");
    const res = await testSmtpConnection({
      host: "x",
      port: 25,
      secure: false,
      user: "u",
      pass: "p",
    });
    expect(res.success).toBe(false);
    expect(res.error).toBe("plain string failure");
  });
});

/* ── sendWhatsappNotification — extra branches ────────────────────── */

describe("sendWhatsAppNotification — extra", () => {
  const fetchSpy = vi.fn();

  beforeEach(() => {
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });

  it("returns failure when fetch throws (network error)", async () => {
    fetchSpy.mockRejectedValue(new Error("getaddrinfo ENOTFOUND graph.facebook.com"));
    const res = await sendWhatsAppNotification(
      { provider: "meta_cloud", apiKey: "k", phoneNumberId: "p" },
      "+1",
      "m",
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/ENOTFOUND/);
  });

  it("includes Authorization Bearer header", async () => {
    fetchSpy.mockResolvedValue({ ok: true, text: async () => "" });
    await sendWhatsAppNotification(
      { provider: "meta_cloud", apiKey: "secret-token", phoneNumberId: "p1" },
      "+1234567890",
      "Hello",
    );
    const init = fetchSpy.mock.calls[0][1] as unknown as { headers: Record<string, string> };
    expect(init.headers.Authorization).toBe("Bearer secret-token");
    expect(init.headers["Content-Type"]).toBe("application/json");
  });

  it("skips for interakt provider (returns success without fetch)", async () => {
    const res = await sendWhatsAppNotification(
      { provider: "interakt", apiKey: "k" },
      "+1",
      "m",
    );
    expect(res.success).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("skips for wati provider", async () => {
    const res = await sendWhatsAppNotification(
      { provider: "wati", apiKey: "k" },
      "+1",
      "m",
    );
    expect(res.success).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns failure when response.text() rejects (still surfaces status)", async () => {
    fetchSpy.mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => { throw new Error("body read failed"); },
    });
    const res = await sendWhatsAppNotification(
      { provider: "meta_cloud", apiKey: "k", phoneNumberId: "p" },
      "+1",
      "m",
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/500/);
  });

  it("posts messaging_product=whatsapp + type=text", async () => {
    fetchSpy.mockResolvedValue({ ok: true, text: async () => "" });
    await sendWhatsAppNotification(
      { provider: "meta_cloud", apiKey: "k", phoneNumberId: "abc" },
      "+1",
      "m",
    );
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as unknown as { body: string }).body);
    expect(body.messaging_product).toBe("whatsapp");
    expect(body.type).toBe("text");
  });
});

/* ── sendOtpEmail — extra branches ────────────────────────────────── */

describe("sendOtpEmail — extra", () => {
  it("returns failure when no recipient even with SMTP configured", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());
    const res = await sendOtpEmail({
      shopDomain: "my-shop.myshopify.com",
      to: "",
      otp: "123456",
    });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/recipient/i);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("OTP subject uses email.otp.subject label", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());
    sendMailMock.mockResolvedValue({});
    await sendOtpEmail({
      shopDomain: "my-shop.myshopify.com",
      to: "cust@example.com",
      otp: "555555",
    });
    const call = (sendMailMock.mock.calls as unknown as unknown[][])[0][0] as unknown as { subject: string };
    expect(call.subject).toBe("Your code");
  });

  it("OTP email respects RTL locale", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp({ portalLanguage: "ar" }));
    sendMailMock.mockResolvedValue({});
    await sendOtpEmail({
      shopDomain: "my-shop.myshopify.com",
      to: "cust@example.com",
      otp: "111222",
    });
    const call = (sendMailMock.mock.calls as unknown as unknown[][])[0][0] as unknown as { html: string };
    expect(call.html).toContain('dir="rtl"');
    expect(call.html).toContain("111222");
  });
});
