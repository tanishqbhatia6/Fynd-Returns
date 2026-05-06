import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * notification.server.ts — FINAL coverage tests.
 * ────────────────────────────────────────────────────────────────────
 * Pushes the file from 99.13% statements → 100%. Covers the last three
 * unreached statements that the existing test files miss:
 *
 *   - Line 466: `if (!smtp) return { success: true }` inside
 *     sendRejectionNotification — fires when the rejected toggle is on
 *     but SMTP is unconfigured. Existing tests only hit toggle-off or
 *     SMTP-on paths in this function, so the SMTP-missing branch is
 *     untouched.
 *   - Line 680: the AbortController callback body `ctrl.abort()` inside
 *     setTimeout(...) — only the setTimeout call itself was previously
 *     reached; the inner callback never executed because real timers
 *     and a fast-resolving fetch left it pending. We trigger it by
 *     making fetch hang and using fake timers to advance past 15s.
 *   - Line 760: `if (!smtp) return { success: true }` inside
 *     sendCancellationNotification — symmetric to line 466 above.
 *
 * Source not modified. Existing tests not modified. tracing-mock here
 * runs the inner span callback (same as siblings) so withSpan inner
 * statements are reached via the calls that flow through them.
 */

/* ── Mocks (same shape as siblings) ──────────────────────────────── */

const { prismaMock, sendMailMock, verifyMock, createTransportMock, decryptMock, loggerMock } =
  vi.hoisted(() => {
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
  const LABELS: Record<string, string> = {};
  return {
    getPortalLabels: () => LABELS,
    t: (key: string, _labels: Record<string, string>, vars?: Record<string, string>) => {
      let v = key;
      if (vars) for (const [k, val] of Object.entries(vars)) v = v.replace(`{{${k}}}`, val);
      return v;
    },
  };
});

vi.mock("../i18n.server", () => ({
  formatMoney: (amt: string, cur: string) => `${cur} ${amt}`,
  isRtlLocale: () => false,
}));

vi.mock("../observability/logger.server", () => ({
  notifLogger: loggerMock,
}));

// tracing-mock — actually invokes the span callback so the inner body
// (sendEmail + addBusinessEvent) runs and contributes to coverage.
vi.mock("../observability/tracing.server", () => ({
  withSpan: async <T>(_n: string, _a: unknown, fn: (s: unknown) => Promise<T>) =>
    fn({ setAttribute: () => {}, end: () => {} }),
  addBusinessEvent: vi.fn(),
}));

vi.mock("../encryption.server", () => ({
  decryptIfEncrypted: (v: string | null | undefined) => decryptMock(v),
}));

/* ── SUT imports (must come after vi.mock) ────────────────────────── */

import {
  sendRejectionNotification,
  sendCancellationNotification,
  sendWhatsAppNotification,
} from "../notification.server";

/* ── Fixtures ─────────────────────────────────────────────────────── */

function makeShopWithoutSmtp(overrides: Record<string, unknown> = {}) {
  // SMTP host/user/pass missing → getSmtpConfig returns smtp: null while
  // toggles still come from the settings row (so we keep them ON to
  // reach the `if (!smtp)` line that the toggle-off path skips past).
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
      ...overrides,
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

/* ── Line 466: sendRejectionNotification SMTP-missing branch ─────── */

describe("sendRejectionNotification — SMTP missing (line 466)", () => {
  it("returns success when toggle is on but SMTP is not configured", async () => {
    // Toggle ON + SMTP NULL → reaches `if (!smtp) return { success: true }`.
    // The existing test suite only covers toggle-off in this branch.
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithoutSmtp());
    const res = await sendRejectionNotification({
      shopDomain: "my-shop.myshopify.com",
      to: "cust@example.com",
      orderName: "#1001",
      rejectionReason: "Outside window",
    });
    expect(res.success).toBe(true);
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});

/* ── Line 760: sendCancellationNotification SMTP-missing branch ──── */

describe("sendCancellationNotification — SMTP missing (line 760)", () => {
  it("returns success when toggle is on but SMTP is not configured", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithoutSmtp());
    const res = await sendCancellationNotification({
      shopDomain: "my-shop.myshopify.com",
      to: "cust@example.com",
      orderName: "#1001",
    });
    expect(res.success).toBe(true);
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});

/* ── Line 680: AbortController timeout callback body ──────────────── */

describe("sendWhatsAppNotification — abort timer fires (line 680)", () => {
  it("invokes ctrl.abort() when fetch hangs past the 15s deadline", async () => {
    // The 15s timer's inner arrow `() => ctrl.abort()` only runs when the
    // request outlives the deadline. Fast-resolving fetch (covered
    // elsewhere) just hits clearTimeout in the finally block — never the
    // callback itself. We set up a fetch that respects AbortSignal but
    // does not resolve on its own, then advance fake timers past 15s so
    // the setTimeout callback runs and aborts the controller, which
    // rejects the fetch with an AbortError → caught path returns failure.
    vi.useFakeTimers();

    let abortCb: (() => void) | null = null;
    const fetchSpy = vi.fn((_url: string, init: { signal: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        abortCb = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        init.signal.addEventListener("abort", () => abortCb && abortCb());
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const promise = sendWhatsAppNotification(
      { provider: "meta_cloud", apiKey: "k", phoneNumberId: "pn1" },
      "+1234",
      "msg",
    );

    // Advance past the 15s timer — fires the inner ctrl.abort() arrow.
    await vi.advanceTimersByTimeAsync(15_001);

    const res = await promise;
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/abort/i);
    // Confirm fetch was actually invoked with a real AbortSignal that
    // is now in the aborted state.
    const init = fetchSpy.mock.calls[0][1] as { signal: AbortSignal };
    expect(init.signal.aborted).toBe(true);
  });
});
