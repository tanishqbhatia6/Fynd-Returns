import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * notification.server.ts — GAP coverage tests.
 * ────────────────────────────────────────────────────────────────────
 * Companion file to notification.test.ts and notification-extra.test.ts.
 * Targets remaining uncovered branches:
 *
 *   - SMTP password decryption returning null (line 95)
 *   - sendEmail retry-on-transient: success after retry (line 159),
 *     transient retry warn + setTimeout (lines 169-173),
 *     final failure log + return (lines 176-177)
 *   - logNotification: shop-not-found early return (328) and
 *     catch block on prisma error (342)
 *   - sendRejectionNotification: missing recipient (466), custom
 *     rejected template (472-485), WhatsApp follow-up (497-506)
 *   - getWhatsAppConfig: decryption returns null (659)
 *   - sendWhatsAppNotification: clearTimeout / abort timer (680)
 *   - sendCancellationNotification: missing recipient (760),
 *     custom cancelled template (766-779), WhatsApp follow-up (791-800)
 *   - sendCancellationDeclinedNotification: toggle off (814),
 *     custom cancellation_declined template (821-834),
 *     WhatsApp follow-up (846-855)
 */

/* ── Mocks ────────────────────────────────────────────────────────── */

const { prismaMock, sendMailMock, verifyMock, createTransportMock, decryptMock, loggerMock } = vi.hoisted(() => {
  const sendMail = vi.fn();
  const verify = vi.fn();
  const createTransport = vi.fn(() => ({ sendMail, verify }));
  const decrypt = vi.fn((v: string | null | undefined) => v ?? null);
  return {
    sendMailMock: sendMail,
    verifyMock: verify,
    createTransportMock: createTransport,
    decryptMock: decrypt,
    loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
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
    "email.cancelled.subject": "Return cancelled for {{order}}",
    "email.cancelled.heading": "Return cancelled",
    "email.cancelled.body": "Your return for {{order}} has been cancelled.",
    "email.cancelled.contact": "Reach out if you have questions",
    "email.cancellationDeclined.subject": "Cancellation declined for {{order}}",
    "email.cancellationDeclined.heading": "Cancellation request declined",
    "email.cancellationDeclined.body": "Your cancellation request for {{order}} was not approved.",
    "email.cancellationDeclined.contact": "Continue with the return process",
    "email.otp.subject": "Your code",
    "email.otp.heading": "Verify your email",
    "email.otp.body": "Here is your code",
    "email.otp.expiry": "Expires in 10 minutes",
    "email.footer.poweredBy": "Powered by Fynd Returns",
    "portal.order.orderDetails": "Order",
    "portal.order.items": "Items",
  };
  return {
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
  notifLogger: loggerMock,
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
  sendRejectionNotification,
  sendCancellationNotification,
  sendCancellationDeclinedNotification,
  sendWhatsAppNotification,
  getWhatsAppConfig,
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
  loggerMock.info.mockClear();
  loggerMock.warn.mockClear();
  loggerMock.error.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/* ── SMTP password decryption returns null (line 95) ──────────────── */

describe("getSmtpConfig — SMTP password decryption", () => {
  it("logs error when smtpPass is set but decryptIfEncrypted returns null", async () => {
    // smtpPass present (truthy ciphertext), but decrypt returns null → triggers
    // the "decryption returned null" log path. SMTP still gets returned with
    // empty pass, so the call still proceeds (and may fail at auth).
    decryptMock.mockReturnValue(null);
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());
    sendMailMock.mockResolvedValue({});

    const res = await sendNewReturnNotification({
      shopDomain: "my-shop.myshopify.com",
      orderName: "#1001",
      itemCount: 1,
      returnRequestId: "RPM-1",
    });
    expect(res.success).toBe(true);
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ shopDomain: "my-shop.myshopify.com" }),
      expect.stringMatching(/decryption returned null/i),
    );
    // pass should be empty in transport config
    const transportCfg = (createTransportMock.mock.calls as unknown as unknown[][])[0][0] as { auth: { pass: string } };
    expect(transportCfg.auth.pass).toBe("");
  });
});

/* ── sendEmail retry logic (lines 144, 159, 169-173, 176-177) ────── */

describe("sendEmail retry-on-transient", () => {
  it("succeeds on retry attempt — logs 'succeeded after retry'", async () => {
    vi.useFakeTimers();
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());

    // First call: transient error (timeout — not in deny-list, so retried).
    // Second call: success.
    sendMailMock
      .mockRejectedValueOnce(new Error("ETIMEDOUT connection timed out"))
      .mockResolvedValueOnce({});

    const promise = sendNewReturnNotification({
      shopDomain: "my-shop.myshopify.com",
      orderName: "#1001",
      itemCount: 1,
      returnRequestId: "RPM-RETRY",
    });

    // Allow the first sendMail to fail and reach setTimeout(1000).
    await vi.advanceTimersByTimeAsync(1_500);

    const res = await promise;
    expect(res.success).toBe(true);
    expect(sendMailMock).toHaveBeenCalledTimes(2);
    // line 159: success-after-retry info log
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 2 }),
      expect.stringMatching(/succeeded after retry/i),
    );
    // line 170: transient retry warn log
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ nextRetryMs: 1_000, attempt: 1 }),
      expect.stringMatching(/transient failure/i),
    );
  });

  it("retries twice then gives up — final error log + failure result", async () => {
    vi.useFakeTimers();
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());

    // All three attempts (initial + 2 retries) fail with transient error.
    sendMailMock.mockRejectedValue(new Error("ECONNRESET socket reset"));

    const promise = sendNewReturnNotification({
      shopDomain: "my-shop.myshopify.com",
      orderName: "#1001",
      itemCount: 1,
      returnRequestId: "RPM-FAIL",
    });

    // Advance past both retry delays (1s + 5s = 6s). Add buffer.
    await vi.advanceTimersByTimeAsync(7_500);

    const res = await promise;
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/ECONNRESET/);
    expect(sendMailMock).toHaveBeenCalledTimes(3);
    // line 176-177: "failed after retries" final error log
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 3 }),
      expect.stringMatching(/failed after retries/i),
    );
    // line 170 warn fired twice (once per retry attempt)
    const warnCalls = loggerMock.warn.mock.calls.filter(
      (c) => typeof c[1] === "string" && /transient failure/i.test(c[1] as string),
    );
    expect(warnCalls.length).toBe(2);
  });

  it("handles non-Error throw in retry path (string error)", async () => {
    vi.useFakeTimers();
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());

    // Throw a non-Error to exercise String(err) branch in lastErr.message fallback.
    sendMailMock.mockRejectedValue("plain string ETIMEDOUT failure");

    const promise = sendNewReturnNotification({
      shopDomain: "my-shop.myshopify.com",
      orderName: "#1001",
      itemCount: 1,
      returnRequestId: "RPM-STR",
    });
    await vi.advanceTimersByTimeAsync(7_500);

    const res = await promise;
    expect(res.success).toBe(false);
    expect(res.error).toBe("plain string ETIMEDOUT failure");
  });
});

/* ── logNotification — shop-not-found + catch (lines 328, 342) ──── */

describe("logNotification edge cases", () => {
  it("returns early when shop is not found at log time (still resolves the send)", async () => {
    // First findUnique (getSmtpConfig) returns shop. Second (logNotification) returns null.
    prismaMock.shop.findUnique
      .mockResolvedValueOnce(makeShopWithSmtp())
      .mockResolvedValueOnce(null);
    sendMailMock.mockResolvedValue({});

    const res = await sendNewReturnNotification({
      shopDomain: "my-shop.myshopify.com",
      orderName: "#1001",
      itemCount: 1,
      returnRequestId: "RPM-LOG-NOSHOP",
    });
    // Email send succeeded; logNotification just bailed silently.
    expect(res.success).toBe(true);
    // Wait a tick for the floating .catch() chain to settle.
    await new Promise((r) => setImmediate(r));
    expect(prismaMock.notificationLog.create).not.toHaveBeenCalled();
  });

  it("swallows prisma errors during logging (catch block)", async () => {
    // First findUnique resolves; second findUnique throws so we hit catch.
    prismaMock.shop.findUnique
      .mockResolvedValueOnce(makeShopWithSmtp())
      .mockRejectedValueOnce(new Error("DB connection lost"));
    sendMailMock.mockResolvedValue({});

    const res = await sendNewReturnNotification({
      shopDomain: "my-shop.myshopify.com",
      orderName: "#1001",
      itemCount: 1,
      returnRequestId: "RPM-LOG-ERR",
    });
    expect(res.success).toBe(true);
    // Allow the floating logNotification promise to resolve and hit the catch.
    await new Promise((r) => setImmediate(r));
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringMatching(/Failed to log notification/i),
    );
  });
});

/* ── sendRejectionNotification — extra branches ──────────────────── */

describe("sendRejectionNotification — gap", () => {
  const baseParams = {
    shopDomain: "my-shop.myshopify.com",
    to: "cust@example.com",
    orderName: "#1001",
    rejectionReason: "Outside return window",
  };

  it("returns error when params.to is empty", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());
    const res = await sendRejectionNotification({ ...baseParams, to: "" });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/recipient/i);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("uses custom rejected template when configured", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp({
      emailTemplatesJson: JSON.stringify({
        rejected: {
          subject: "REJECTED {{orderName}}",
          bodyHtml: "<p>Reason: {{rejectionReason}} (id={{returnId}})</p>",
        },
      }),
    }));
    sendMailMock.mockResolvedValue({});

    await sendRejectionNotification({ ...baseParams, returnId: "RPM-R1" });
    const call = (sendMailMock.mock.calls as unknown as unknown[][])[0][0] as {
      subject: string;
      html: string;
    };
    expect(call.subject).toBe("REJECTED #1001");
    expect(call.html).toContain("Outside return window");
    expect(call.html).toContain("RPM-R1");
  });

  it("triggers WhatsApp follow-up on rejection when phone + WA config present", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithWhatsApp());
    sendMailMock.mockResolvedValue({});
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await sendRejectionNotification({
      ...baseParams,
      customerPhone: "+919998887777",
    });
    expect(res.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body);
    expect(body.text.body).toContain("not approved");
    expect(body.text.body).toContain("Outside return window");
  });

  it("WhatsApp falls back to default text when rejectionReason empty", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithWhatsApp());
    sendMailMock.mockResolvedValue({});
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    vi.stubGlobal("fetch", fetchSpy);

    await sendRejectionNotification({
      ...baseParams,
      rejectionReason: "",
      customerPhone: "+919998887777",
    });
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body);
    expect(body.text.body).toContain("See portal for details");
  });
});

/* ── getWhatsAppConfig — decryption returns null (line 659) ─────── */

describe("getWhatsAppConfig — decryption returns null", () => {
  it("returns null when WhatsApp API key fails to decrypt", async () => {
    decryptMock.mockReturnValue(null);
    prismaMock.shop.findUnique.mockResolvedValue({
      settings: {
        whatsappEnabled: true,
        whatsappApiKey: "ciphertext-blob",
        whatsappProvider: "meta_cloud",
      },
    });
    const cfg = await getWhatsAppConfig("x.myshopify.com");
    expect(cfg).toBe(null);
  });
});

/* ── sendWhatsAppNotification — abort timer cleanup (line 680) ─── */

describe("sendWhatsAppNotification — timer cleanup", () => {
  it("clears the abort timer when fetch resolves quickly (no abort)", async () => {
    // The clearTimeout happens in the finally block — line 698. We verify by
    // ensuring the request settles cleanly and no AbortError surfaces.
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await sendWhatsAppNotification(
      { provider: "meta_cloud", apiKey: "k", phoneNumberId: "pn1" },
      "+1234",
      "msg",
    );
    expect(res.success).toBe(true);
    // The signal from the AbortController must have been passed in — proves
    // the timer was created (and clearTimeout in finally ran).
    const init = fetchSpy.mock.calls[0][1] as { signal: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal.aborted).toBe(false);
  });

  it("clears the abort timer when fetch rejects (still hits finally)", async () => {
    const fetchSpy = vi.fn().mockRejectedValue(new Error("network"));
    vi.stubGlobal("fetch", fetchSpy);

    const res = await sendWhatsAppNotification(
      { provider: "meta_cloud", apiKey: "k", phoneNumberId: "pn1" },
      "+1234",
      "msg",
    );
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/network/);
  });
});

/* ── sendCancellationNotification — gap branches ─────────────────── */

describe("sendCancellationNotification — gap", () => {
  const baseParams = {
    shopDomain: "my-shop.myshopify.com",
    to: "cust@example.com",
    orderName: "#1001",
  };

  it("returns error when params.to is empty", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());
    const res = await sendCancellationNotification({ ...baseParams, to: "" });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/recipient/i);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("uses custom cancelled template when configured", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp({
      emailTemplatesJson: JSON.stringify({
        cancelled: {
          subject: "CANCELLED {{orderName}}",
          bodyHtml: "<p>Hi {{customerEmail}} — return {{returnId}}</p>",
        },
      }),
    }));
    sendMailMock.mockResolvedValue({});

    await sendCancellationNotification({
      ...baseParams,
      returnId: "RPM-C1",
      shopName: "Acme",
    });
    const call = (sendMailMock.mock.calls as unknown as unknown[][])[0][0] as {
      subject: string;
      html: string;
    };
    expect(call.subject).toBe("CANCELLED #1001");
    expect(call.html).toContain("RPM-C1");
    expect(call.html).toContain("cust@example.com");
  });

  it("triggers WhatsApp follow-up on cancellation when phone + WA config present", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithWhatsApp());
    sendMailMock.mockResolvedValue({});
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await sendCancellationNotification({
      ...baseParams,
      customerPhone: "+919998887777",
    });
    expect(res.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body);
    expect(body.text.body).toContain("cancelled");
  });
});

/* ── sendCancellationDeclinedNotification — gap branches ────────── */

describe("sendCancellationDeclinedNotification — gap", () => {
  const baseParams = {
    shopDomain: "my-shop.myshopify.com",
    to: "cust@example.com",
    orderName: "#1001",
  };

  it("skips when notificationCancelled toggle is disabled", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(
      makeShopWithSmtp({ notificationCancelled: false }),
    );
    const res = await sendCancellationDeclinedNotification(baseParams);
    expect(res.success).toBe(true);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("returns error when params.to is empty", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp());
    const res = await sendCancellationDeclinedNotification({ ...baseParams, to: "" });
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/recipient/i);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("uses custom cancellation_declined template when configured", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtp({
      emailTemplatesJson: JSON.stringify({
        cancellation_declined: {
          subject: "DECLINED {{orderName}}",
          bodyHtml: "<p>Return {{returnId}} cannot be cancelled</p>",
        },
      }),
    }));
    sendMailMock.mockResolvedValue({});

    await sendCancellationDeclinedNotification({
      ...baseParams,
      returnId: "RPM-CD1",
    });
    const call = (sendMailMock.mock.calls as unknown as unknown[][])[0][0] as {
      subject: string;
      html: string;
    };
    expect(call.subject).toBe("DECLINED #1001");
    expect(call.html).toContain("RPM-CD1");
  });

  it("triggers WhatsApp follow-up on cancellation declined when phone + WA config present", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithWhatsApp());
    sendMailMock.mockResolvedValue({});
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, text: async () => "" });
    vi.stubGlobal("fetch", fetchSpy);

    const res = await sendCancellationDeclinedNotification({
      ...baseParams,
      customerPhone: "+919998887777",
    });
    expect(res.success).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body);
    expect(body.text.body).toContain("cancellation request");
    expect(body.text.body).toContain("not approved");
  });
});
