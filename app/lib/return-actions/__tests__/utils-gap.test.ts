/**
 * Utils gap-coverage tests — targets remaining uncovered branches in
 * the helper modules that back the return-action handlers:
 *
 *   - app/lib/notification.server.ts        (SMTP / WhatsApp / OTP / custom-note)
 *   - app/lib/return-actions/update-label.server.ts
 *   - app/lib/return-actions/update-status.server.ts
 *
 * Tests in this file are deliberately narrow: each one drives one
 * uncovered branch (or a small cluster of related branches) without
 * touching real I/O. All mocks are hoisted at the top of the file so
 * the same module path resolves consistently across describe-blocks.
 *
 * NEVER modifies source.
 */
// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

/* ── Hoisted mocks shared across the file ─────────────────────────── */
const {
  prismaMock,
  sendMailMock,
  verifyMock,
  createTransportMock,
  decryptMock,
  closeBestEffortMock,
  loggerMock,
} = vi.hoisted(() => {
  const sendMail = vi.fn();
  const verify = vi.fn();
  const createTransport = vi.fn(() => ({ sendMail, verify }));
  const decrypt = vi.fn((v: string | null | undefined) => v ?? null);
  const closeBestEffort = vi.fn();
  return {
    sendMailMock: sendMail,
    verifyMock: verify,
    createTransportMock: createTransport,
    decryptMock: decrypt,
    closeBestEffortMock: closeBestEffort,
    loggerMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    prismaMock: {
      shop: { findUnique: vi.fn() },
      notificationLog: { create: vi.fn() },
      returnCase: { update: vi.fn() },
      returnEvent: { create: vi.fn() },
    },
  };
});

vi.mock("nodemailer", () => ({
  default: { createTransport: createTransportMock },
  createTransport: createTransportMock,
}));
vi.mock("../../../db.server", () => ({ default: prismaMock }));
vi.mock("../../encryption.server", () => ({
  decryptIfEncrypted: decryptMock,
}));
vi.mock("../../portal-i18n", () => {
  const labels: Record<string, string> = {
    "email.otp.subject": "Your verification code",
    "email.otp.heading": "OTP",
    "email.otp.body": "Use this code",
    "email.otp.expiry": "Expires in 5 min",
    "email.footer.poweredBy": "Powered by Test",
  };
  return {
    getPortalLabels: () => labels,
    t: (key: string, _l: Record<string, string>, vars: Record<string, string> = {}) => {
      let s = labels[key] ?? key;
      for (const [k, v] of Object.entries(vars)) s = s.replace(`{{${k}}}`, v);
      return s;
    },
  };
});
vi.mock("../../i18n.server", () => ({
  formatMoney: (a: string, c?: string) => `${c ?? "USD"} ${a}`,
  isRtlLocale: () => false,
}));
vi.mock("../../observability/logger.server", () => ({
  notifLogger: loggerMock,
  refundLogger: loggerMock,
}));
vi.mock("../../observability/tracing.server", () => ({
  withSpan: async (_n: string, _a: Record<string, unknown>, fn: (s: unknown) => unknown) => fn({}),
  addBusinessEvent: vi.fn(),
  startTimer: () => () => 1,
}));
vi.mock("../../observability/metrics.server", () => ({
  returnActionCounter: { add: vi.fn() },
  returnActionDuration: { record: vi.fn() },
  appErrorCounter: { add: vi.fn() },
  refundCounter: { add: vi.fn() },
  refundAmountHistogram: { record: vi.fn() },
  returnsCompletedCounter: { add: vi.fn() },
  fyndSyncCounter: { add: vi.fn() },
}));
vi.mock("../../observability/slo.server", () => ({
  annotateSLO: vi.fn(),
}));
vi.mock("../../shopify-admin.server", () => ({
  closeShopifyReturnBestEffort: closeBestEffortMock,
}));

/* ───────────────────────────────────────────────────────────────────
 *  Section 1 — notification.server.ts
 * ─────────────────────────────────────────────────────────────────── */
describe("notification.server.ts — utils gap coverage", () => {
  beforeEach(() => {
    sendMailMock.mockReset().mockResolvedValue({ messageId: "m" });
    verifyMock.mockReset().mockResolvedValue(true);
    createTransportMock.mockClear();
    decryptMock.mockReset().mockImplementation((v: string | null | undefined) => v ?? null);
    prismaMock.shop.findUnique.mockReset();
    prismaMock.notificationLog.create.mockReset().mockResolvedValue({});
  });

  // ── testSmtpConnection paths
  it("testSmtpConnection: returns success on transport.verify() pass", async () => {
    const { testSmtpConnection } = await import("../../notification.server");
    const r = await testSmtpConnection({
      host: "smtp.example.com", port: 587, secure: false,
      user: "u@example.com", pass: "p",
    });
    expect(r.success).toBe(true);
    expect(verifyMock).toHaveBeenCalled();
  });

  it("testSmtpConnection: returns error on verify() throw (Error instance)", async () => {
    verifyMock.mockRejectedValueOnce(new Error("auth failed"));
    const { testSmtpConnection } = await import("../../notification.server");
    const r = await testSmtpConnection({
      host: "smtp.example.com", port: 587, secure: true,
      user: "u@example.com", pass: "p",
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("auth failed");
  });

  it("testSmtpConnection: returns error.toString fallback for non-Error throws", async () => {
    verifyMock.mockRejectedValueOnce("plain string error");
    const { testSmtpConnection } = await import("../../notification.server");
    const r = await testSmtpConnection({
      host: "h", port: 25, secure: false, user: "u", pass: "p",
    });
    expect(r.success).toBe(false);
    expect(r.error).toBe("plain string error");
  });

  // ── sendOtpEmail
  it("sendOtpEmail: returns success when SMTP not configured (skip silently)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "s1", settings: null });
    const { sendOtpEmail } = await import("../../notification.server");
    const r = await sendOtpEmail({ shopDomain: "x.myshopify.com", to: "u@example.com", otp: "1234" });
    expect(r.success).toBe(true);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("sendOtpEmail: returns error when no recipient even with SMTP configured", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "s1",
      settings: { smtpHost: "h", smtpUser: "u", smtpPass: "p" },
    });
    const { sendOtpEmail } = await import("../../notification.server");
    const r = await sendOtpEmail({ shopDomain: "x.myshopify.com", to: "", otp: "1234" });
    expect(r.success).toBe(false);
    expect(r.error).toContain("No recipient");
  });

  it("sendOtpEmail: sends mail when SMTP + recipient configured", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "s1",
      settings: { smtpHost: "h", smtpUser: "u@example.com", smtpPass: "ciphertext" },
    });
    // Mock the second findUnique call for logNotification
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "s1" });
    const { sendOtpEmail } = await import("../../notification.server");
    const r = await sendOtpEmail({ shopDomain: "x.myshopify.com", to: "to@example.com", otp: "987654" });
    expect(r.success).toBe(true);
    expect(sendMailMock).toHaveBeenCalledOnce();
    const call = sendMailMock.mock.calls[0][0];
    expect(call.html).toContain("987654");
  });

  // ── sendCustomerNoteNotification
  it("sendCustomerNoteNotification: returns success when SMTP not configured", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "s1", settings: null });
    const { sendCustomerNoteNotification } = await import("../../notification.server");
    const r = await sendCustomerNoteNotification({
      shopDomain: "x.myshopify.com", to: "u@example.com",
      orderName: "#1001", note: "hi",
    });
    expect(r.success).toBe(true);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("sendCustomerNoteNotification: returns error when SMTP set but no recipient", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "s1",
      settings: { smtpHost: "h", smtpUser: "u@example.com", smtpPass: "p" },
    });
    const { sendCustomerNoteNotification } = await import("../../notification.server");
    const r = await sendCustomerNoteNotification({
      shopDomain: "x.myshopify.com", to: "",
      orderName: "#1001", note: "hi",
    });
    expect(r.success).toBe(false);
    expect(r.error).toContain("No recipient");
  });

  it("sendCustomerNoteNotification: sends correctly with shopName branding", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "s1",
      settings: { smtpHost: "h", smtpUser: "u@example.com", smtpPass: "p" },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "s1" });
    const { sendCustomerNoteNotification } = await import("../../notification.server");
    const r = await sendCustomerNoteNotification({
      shopDomain: "x.myshopify.com", to: "to@example.com",
      orderName: "#1001", note: "Quick update", shopName: "Acme",
    });
    expect(r.success).toBe(true);
    const html = sendMailMock.mock.calls[0][0].html;
    expect(html).toContain("Acme");
    expect(html).toContain("#1001");
    expect(html).toContain("Quick update");
  });

  it("sendCustomerNoteNotification: falls back to 'The store' when shopName omitted", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "s1",
      settings: { smtpHost: "h", smtpUser: "u@example.com", smtpPass: "p" },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "s1" });
    const { sendCustomerNoteNotification } = await import("../../notification.server");
    await sendCustomerNoteNotification({
      shopDomain: "x.myshopify.com", to: "to@example.com",
      orderName: "#1001", note: "Hi",
    });
    const html = sendMailMock.mock.calls[0][0].html;
    expect(html).toContain("The store");
  });

  // ── sendWhatsAppNotification
  it("sendWhatsAppNotification: missing recipient returns error", async () => {
    const { sendWhatsAppNotification } = await import("../../notification.server");
    const r = await sendWhatsAppNotification(
      { provider: "meta_cloud", apiKey: "k", phoneNumberId: "pn1" },
      "", "msg",
    );
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/missing/i);
  });

  it("sendWhatsAppNotification: missing message returns error", async () => {
    const { sendWhatsAppNotification } = await import("../../notification.server");
    const r = await sendWhatsAppNotification(
      { provider: "meta_cloud", apiKey: "k", phoneNumberId: "pn1" },
      "+9112345", "",
    );
    expect(r.success).toBe(false);
  });

  it("sendWhatsAppNotification: meta_cloud success path normalizes phone with leading +", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, text: async () => "" }) as never;
    try {
      const { sendWhatsAppNotification } = await import("../../notification.server");
      const r = await sendWhatsAppNotification(
        { provider: "meta_cloud", apiKey: "k", phoneNumberId: "pn1" },
        "9112345", "Hi",
      );
      expect(r.success).toBe(true);
      const callArgs = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
      const body = JSON.parse((callArgs[1] as { body: string }).body);
      expect(body.to).toBe("+9112345");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("sendWhatsAppNotification: meta_cloud non-OK response surfaces error message", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false, status: 401, text: async () => "Invalid token",
    }) as never;
    try {
      const { sendWhatsAppNotification } = await import("../../notification.server");
      const r = await sendWhatsAppNotification(
        { provider: "meta_cloud", apiKey: "bad", phoneNumberId: "pn1" },
        "+19998887777", "Hi",
      );
      expect(r.success).toBe(false);
      expect(r.error).toContain("401");
      expect(r.error).toContain("Invalid token");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("sendWhatsAppNotification: meta_cloud non-OK with text() failure still returns error", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: false, status: 500, text: async () => { throw new Error("boom"); },
    }) as never;
    try {
      const { sendWhatsAppNotification } = await import("../../notification.server");
      const r = await sendWhatsAppNotification(
        { provider: "meta_cloud", apiKey: "k", phoneNumberId: "pn1" },
        "+1", "x",
      );
      expect(r.success).toBe(false);
      expect(r.error).toContain("500");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("sendWhatsAppNotification: fetch throws → caught + returns error", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValueOnce(new Error("network down")) as never;
    try {
      const { sendWhatsAppNotification } = await import("../../notification.server");
      const r = await sendWhatsAppNotification(
        { provider: "meta_cloud", apiKey: "k", phoneNumberId: "pn1" },
        "+1", "Hi",
      );
      expect(r.success).toBe(false);
      expect(r.error).toContain("network down");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  it("sendWhatsAppNotification: non-meta provider returns success with skipped log", async () => {
    const { sendWhatsAppNotification } = await import("../../notification.server");
    const r = await sendWhatsAppNotification(
      { provider: "twilio", apiKey: "k" }, "+1", "Hi",
    );
    expect(r.success).toBe(true);
  });

  it("sendWhatsAppNotification: meta_cloud without phoneNumberId falls through to skipped-provider branch", async () => {
    const { sendWhatsAppNotification } = await import("../../notification.server");
    const r = await sendWhatsAppNotification(
      { provider: "meta_cloud", apiKey: "k" }, "+1", "Hi",
    );
    expect(r.success).toBe(true);
  });

  // ── getWhatsAppConfig
  it("getWhatsAppConfig: returns null when whatsappEnabled=false", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "s1",
      settings: { whatsappEnabled: false, whatsappApiKey: "k", whatsappProvider: "meta_cloud" },
    });
    const { getWhatsAppConfig } = await import("../../notification.server");
    const cfg = await getWhatsAppConfig("x.myshopify.com");
    expect(cfg).toBeNull();
  });

  it("getWhatsAppConfig: returns null when apiKey decryption returns null", async () => {
    decryptMock.mockReturnValueOnce(null);
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "s1",
      settings: {
        whatsappEnabled: true,
        whatsappApiKey: "ciphertext",
        whatsappProvider: "meta_cloud",
        whatsappPhoneNumberId: "p1",
        whatsappFromNumber: null,
      },
    });
    const { getWhatsAppConfig } = await import("../../notification.server");
    const cfg = await getWhatsAppConfig("x.myshopify.com");
    expect(cfg).toBeNull();
  });

  it("getWhatsAppConfig: returns config when fully configured", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "s1",
      settings: {
        whatsappEnabled: true,
        whatsappApiKey: "plaintext",
        whatsappProvider: "meta_cloud",
        whatsappPhoneNumberId: "p1",
        whatsappFromNumber: "+10",
      },
    });
    const { getWhatsAppConfig } = await import("../../notification.server");
    const cfg = await getWhatsAppConfig("x.myshopify.com");
    expect(cfg).toEqual({
      provider: "meta_cloud",
      apiKey: "plaintext",
      phoneNumberId: "p1",
      fromNumber: "+10",
    });
  });

  it("getWhatsAppConfig: returns null when no settings record at all", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const { getWhatsAppConfig } = await import("../../notification.server");
    const cfg = await getWhatsAppConfig("x.myshopify.com");
    expect(cfg).toBeNull();
  });
});

/* ───────────────────────────────────────────────────────────────────
 *  Section 2 — handleUpdateLabel (gap branches)
 * ─────────────────────────────────────────────────────────────────── */
describe("update-label.server.ts — utils gap coverage", () => {
  beforeEach(() => {
    prismaMock.returnCase.update.mockReset().mockResolvedValue({});
    prismaMock.returnEvent.create.mockReset().mockResolvedValue({});
  });

  function mkCtx(overrides: Record<string, unknown> = {}) {
    return {
      id: "rc-1",
      returnCase: {
        id: "rc-1",
        adminNotes: null,
        returnRequestNo: "RQ-1",
        items: [],
      } as never,
      shop: { id: "s1", shopDomain: "x.myshopify.com", settings: null },
      admin: { graphql: vi.fn() } as never,
      shopDomain: "x.myshopify.com",
      sessionEmail: "admin@example.com",
      isTerminal: false,
      elapsed: () => 1,
      logShopifyReturnEvent: vi.fn(),
      ...overrides,
    };
  }

  async function expectRedirect(p: Promise<unknown>) {
    try { await p; throw new Error("expected redirect"); }
    catch (err) {
      expect(err).toBeInstanceOf(Response);
      expect((err as Response).status).toBeGreaterThanOrEqual(300);
    }
  }

  it("nulls every field when payload is fully empty (string trim → null)", async () => {
    const { handleUpdateLabel } = await import("../update-label.server");
    await expectRedirect(handleUpdateLabel(
      mkCtx() as never,
      { action: "update_label" } as never,
    ));
    const args = prismaMock.returnCase.update.mock.calls[0][0];
    expect(args.data.returnLabelUrl).toBeNull();
    const labelJson = JSON.parse(args.data.returnLabelJson);
    expect(labelJson.carrier).toBeNull();
    expect(labelJson.trackingNumber).toBeNull();
    expect(labelJson.labelUrl).toBeNull();
    expect(labelJson.qrCodeUrl).toBeNull();
    expect(labelJson.adminEmail).toBe("admin@example.com");
  });

  it("trims whitespace from every label field", async () => {
    const { handleUpdateLabel } = await import("../update-label.server");
    await expectRedirect(handleUpdateLabel(
      mkCtx() as never,
      {
        action: "update_label",
        carrier: "  UPS  ",
        trackingNumber: "  T1  ",
        labelUrl: "  https://l/  ",
        qrCodeUrl: "  https://q/  ",
      } as never,
    ));
    const args = prismaMock.returnCase.update.mock.calls[0][0];
    const labelJson = JSON.parse(args.data.returnLabelJson);
    expect(labelJson.carrier).toBe("UPS");
    expect(labelJson.trackingNumber).toBe("T1");
    expect(args.data.returnLabelUrl).toBe("https://l/");
  });

  it("propagates non-redirect prisma errors through the catch block", async () => {
    prismaMock.returnCase.update.mockRejectedValueOnce(new Error("db locked"));
    const { handleUpdateLabel } = await import("../update-label.server");
    await expect(
      handleUpdateLabel(mkCtx() as never, { action: "update_label", carrier: "X" } as never),
    ).rejects.toThrow(/db locked/);
  });

  it("rethrows a Response thrown from the inner block (not wrapped)", async () => {
    prismaMock.returnCase.update.mockImplementationOnce(async () => {
      throw new Response("custom", { status: 422 });
    });
    const { handleUpdateLabel } = await import("../update-label.server");
    try {
      await handleUpdateLabel(mkCtx() as never, { action: "update_label" } as never);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Response);
      expect((err as Response).status).toBe(422);
    }
  });

  it("writes a returnEvent of source=admin/eventType=label_updated", async () => {
    const { handleUpdateLabel } = await import("../update-label.server");
    await expectRedirect(handleUpdateLabel(
      mkCtx() as never,
      { action: "update_label", carrier: "DHL", trackingNumber: "TN1" } as never,
    ));
    const evt = prismaMock.returnEvent.create.mock.calls[0][0];
    expect(evt.data.source).toBe("admin");
    expect(evt.data.eventType).toBe("label_updated");
    expect(evt.data.returnCaseId).toBe("rc-1");
  });
});

/* ───────────────────────────────────────────────────────────────────
 *  Section 3 — handleUpdateStatus (gap branches)
 * ─────────────────────────────────────────────────────────────────── */
describe("update-status.server.ts — utils gap coverage", () => {
  beforeEach(() => {
    prismaMock.returnCase.update.mockReset().mockResolvedValue({});
    prismaMock.returnEvent.create.mockReset().mockResolvedValue({});
    closeBestEffortMock.mockReset().mockResolvedValue({ ok: true });
  });

  function mkCtx(overrides: Record<string, unknown> = {}) {
    return {
      id: "rc-1",
      returnCase: { id: "rc-1", adminNotes: "old", status: "pending", returnRequestNo: "RQ-1" } as never,
      shop: { id: "s1", shopDomain: "x.myshopify.com", settings: null },
      admin: { graphql: vi.fn() } as never,
      shopDomain: "x.myshopify.com",
      sessionEmail: "a@e.com",
      isTerminal: false,
      elapsed: () => 1,
      logShopifyReturnEvent: vi.fn(),
      ...overrides,
    };
  }

  async function expectRedirect(p: Promise<unknown>) {
    try { await p; throw new Error("expected redirect"); }
    catch (err) {
      expect(err).toBeInstanceOf(Response);
      expect((err as Response).status).toBeGreaterThanOrEqual(300);
    }
  }

  it("calls close action on terminal cancelled status (not decline)", async () => {
    const { handleUpdateStatus } = await import("../update-status.server");
    await expectRedirect(handleUpdateStatus(
      mkCtx() as never,
      { action: "update_status", status: "cancelled" } as never,
    ));
    expect(closeBestEffortMock).toHaveBeenCalledOnce();
    const args = closeBestEffortMock.mock.calls[0][2];
    expect(args.action).toBe("close");
    expect(args.declineReason).toBeUndefined();
  });

  it("accepts mixed-case 'In Progress' status as valid", async () => {
    const { handleUpdateStatus } = await import("../update-status.server");
    await expectRedirect(handleUpdateStatus(
      mkCtx() as never,
      { action: "update_status", status: "In Progress" } as never,
    ));
    expect(prismaMock.returnCase.update).toHaveBeenCalled();
  });

  it("preserves existing adminNotes when body.note is empty", async () => {
    const { handleUpdateStatus } = await import("../update-status.server");
    await expectRedirect(handleUpdateStatus(
      mkCtx() as never,
      { action: "update_status", status: "approved", note: "" } as never,
    ));
    const upd = prismaMock.returnCase.update.mock.calls[0][0];
    expect(upd.data.adminNotes).toBe("old");
  });

  it("uses provided declineReason for rejected status (note → declineReason)", async () => {
    const { handleUpdateStatus } = await import("../update-status.server");
    await expectRedirect(handleUpdateStatus(
      mkCtx() as never,
      { action: "update_status", status: "rejected", note: "fraud detected" } as never,
    ));
    expect(closeBestEffortMock).toHaveBeenCalled();
    const args = closeBestEffortMock.mock.calls[0][2];
    expect(args.action).toBe("decline");
    expect(args.declineReason).toBe("fraud detected");
  });

  it("uses default decline reason when note empty for rejected", async () => {
    const { handleUpdateStatus } = await import("../update-status.server");
    await expectRedirect(handleUpdateStatus(
      mkCtx() as never,
      { action: "update_status", status: "rejected" } as never,
    ));
    const args = closeBestEffortMock.mock.calls[0][2];
    expect(args.declineReason).toBe("Return rejected");
  });

  it("propagates non-redirect prisma error through outer catch", async () => {
    prismaMock.returnCase.update.mockRejectedValueOnce(new Error("db down"));
    const { handleUpdateStatus } = await import("../update-status.server");
    await expect(
      handleUpdateStatus(mkCtx() as never, { action: "update_status", status: "approved" } as never),
    ).rejects.toThrow(/db down/);
  });

  it("non-terminal status doesn't call close best-effort", async () => {
    const { handleUpdateStatus } = await import("../update-status.server");
    await expectRedirect(handleUpdateStatus(
      mkCtx() as never,
      { action: "update_status", status: "processing" } as never,
    ));
    expect(closeBestEffortMock).not.toHaveBeenCalled();
  });

  it("writes status_updated event with from/to/note/adminEmail in payload", async () => {
    const { handleUpdateStatus } = await import("../update-status.server");
    await expectRedirect(handleUpdateStatus(
      mkCtx({ returnCase: { id: "rc-1", adminNotes: null, status: "pending", returnRequestNo: "RQ-1" } as never }) as never,
      { action: "update_status", status: "approved", note: "ok" } as never,
    ));
    const evt = prismaMock.returnEvent.create.mock.calls[0][0];
    const payload = JSON.parse(evt.data.payloadJson);
    expect(payload.from).toBe("pending");
    expect(payload.to).toBe("approved");
    expect(payload.note).toBe("ok");
    expect(payload.adminEmail).toBe("a@e.com");
  });

  it("returns 400 when status field missing from body", async () => {
    const { handleUpdateStatus } = await import("../update-status.server");
    const res = await handleUpdateStatus(
      mkCtx() as never,
      { action: "update_status" } as never,
    );
    expect(res).toBeInstanceOf(Response);
    expect((res as Response).status).toBe(400);
  });

  it("returns 400 for an unrecognised status value", async () => {
    const { handleUpdateStatus } = await import("../update-status.server");
    const res = await handleUpdateStatus(
      mkCtx() as never,
      { action: "update_status", status: "wibble" } as never,
    );
    expect((res as Response).status).toBe(400);
    const json = await (res as Response).json();
    expect(json.error).toContain("Invalid status");
  });
});
