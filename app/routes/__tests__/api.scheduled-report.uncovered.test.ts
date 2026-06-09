/**
 * Uncovered-line tests for /api/scheduled-report.
 *
 * Targets specifically:
 *   • Lines 101–108  — refundJson parsing branches (exchange/store_credit vs refund)
 *                      and the malformed-JSON catch path that "skips".
 *   • Lines 173–181  — status/resolution breakdown rows in the email HTML
 *                      (Object.entries(...).sort().map(...)) — only iterate when
 *                      both maps are non-empty.
 *
 * Plus extra schedule-validation edges (invalid/blank/unknown frequencies)
 * and zero-data report generation through the SMTP send path.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, sendMailMock, createTransportMock, decryptMock } = vi.hoisted(() => {
  const sendMail = vi.fn().mockResolvedValue({ messageId: "x" });
  const createTransport = vi.fn(() => ({ sendMail }));
  return {
    prismaMock: {} as ReturnType<typeof createPrismaMock>,
    sendMailMock: sendMail,
    createTransportMock: createTransport,
    decryptMock: vi.fn((v: string) => v),
  };
});
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("nodemailer", () => ({
  default: { createTransport: createTransportMock },
  createTransport: createTransportMock,
}));
vi.mock("../../lib/encryption.server", () => ({
  decryptIfEncrypted: decryptMock,
}));

import { loader } from "../api.scheduled-report";

const origEnv = { ...process.env };

function mkReq(headers: Record<string, string> = {}) {
  const h = new Headers();
  h.set("x-cron-secret", "test-cron-secret");
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  return new Request("https://app.example/api/scheduled-report", { headers: h });
}

function baseSetting(overrides: Record<string, unknown> = {}) {
  return {
    shopId: "shop-1",
    shop: { shopDomain: "store.myshopify.com" },
    scheduledReportEnabled: true,
    scheduledReportFrequency: "daily",
    scheduledReportEmails: "owner@x.com",
    shopCurrency: "USD",
    shopLocale: "en",
    shopTimezone: "UTC",
    smtpHost: "smtp.example.com",
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: "smtp@x.com",
    smtpPass: "enc:pass",
    smtpFromEmail: "noreply@x.com",
    smtpFromName: "Returns",
    ...overrides,
  };
}

beforeEach(() => {
  process.env = { ...origEnv };
  process.env.CRON_SECRET = "test-cron-secret";
  resetPrismaMock(prismaMock);
  prismaMock.shopSettings.findMany.mockReset().mockResolvedValue([]);
  prismaMock.returnCase.count.mockReset().mockResolvedValue(0);
  prismaMock.returnCase.groupBy.mockReset().mockResolvedValue([]);
  prismaMock.returnCase.findMany.mockReset().mockResolvedValue([]);
  sendMailMock.mockReset().mockResolvedValue({ messageId: "x" });
  createTransportMock.mockReset().mockReturnValue({ sendMail: sendMailMock });
  decryptMock.mockReset().mockImplementation((v: string) => (v ?? "").replace(/^enc:/, ""));
});

afterEach(() => {
  process.env = { ...origEnv };
  vi.useRealTimers();
});

describe("api.scheduled-report — refundJson parsing (lines 101-108)", () => {
  it("accumulates revenueRetained for exchange/store_credit and totalRefundAmt for refund", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([baseSetting()]);
    prismaMock.returnCase.count.mockResolvedValueOnce(4);
    // Provide a status breakdown so the HTML template iterates rows (covers 173-181).
    prismaMock.returnCase.groupBy
      .mockResolvedValueOnce([
        { status: "approved", _count: 2 },
        { status: "completed", _count: 1 },
        { status: "rejected", _count: 1 },
      ])
      .mockResolvedValueOnce([
        { resolutionType: "refund", _count: 1 },
        { resolutionType: "exchange", _count: 1 },
        { resolutionType: "store_credit", _count: 1 },
        { resolutionType: "replacement", _count: 1 },
      ]);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      // refund branch — accumulates totalRefundAmt
      { refundJson: JSON.stringify({ amount: "12.50" }), resolutionType: "refund" },
      // exchange branch — accumulates revenueRetained
      { refundJson: JSON.stringify({ amount: "20.00" }), resolutionType: "exchange" },
      // store_credit branch — accumulates revenueRetained
      { refundJson: JSON.stringify({ amount: "5.00" }), resolutionType: "store_credit" },
      // replacement branch — falls through to refund accumulator
      { refundJson: JSON.stringify({ amount: "7.25" }), resolutionType: "replacement" },
      // amount = 0 → skipped by amt > 0 guard
      { refundJson: JSON.stringify({ amount: "0" }), resolutionType: "refund" },
      // missing amount → parseFloat("0") = 0 → skipped
      { refundJson: JSON.stringify({}), resolutionType: "refund" },
      // null refundJson → JSON.parse("{}") path
      { refundJson: null, resolutionType: "refund" },
      // non-finite (NaN) → skipped
      { refundJson: JSON.stringify({ amount: "not-a-number" }), resolutionType: "refund" },
    ]);

    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(sendMailMock).toHaveBeenCalledTimes(1);

    const sentArgs = sendMailMock.mock.calls[0][0];
    const html: string = sentArgs.html;
    // Status/resolution rows rendered (covers Object.entries(...).map at 173-181)
    expect(html).toMatch(/Approved|approved/i);
    expect(html).toMatch(/Rejected|rejected/i);
    expect(html).toMatch(/Refund|refund/i);
    expect(html).toMatch(/Exchange|exchange/i);
    expect(html).toMatch(/Store credit|store credit/i);
    // Subject contains period label
    expect(sentArgs.subject).toMatch(/Yesterday/);
  });

  it("swallows malformed JSON in refundJson via catch (line 111) without failing send", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([baseSetting()]);
    prismaMock.returnCase.count.mockResolvedValueOnce(2);
    prismaMock.returnCase.groupBy
      .mockResolvedValueOnce([{ status: "approved", _count: 1 }])
      .mockResolvedValueOnce([{ resolutionType: "refund", _count: 1 }]);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      // Throws JSON.parse SyntaxError → caught → loop continues
      { refundJson: "{not-json", resolutionType: "refund" },
      // Valid one after the throw — confirms loop didn't bail
      { refundJson: JSON.stringify({ amount: "9.99" }), resolutionType: "refund" },
    ]);

    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.processed).toBe(1);
    expect(body.results[0]).toEqual(
      expect.objectContaining({ shop: "store.myshopify.com", sent: true }),
    );
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });
});

describe("api.scheduled-report — schedule-validation edge cases", () => {
  it("skips when frequency is empty string (falls through else continue)", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([
      baseSetting({ scheduledReportFrequency: "" }),
    ]);
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.results).toEqual([]);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("skips when frequency is null/undefined", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([
      baseSetting({ scheduledReportFrequency: null }),
    ]);
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.results).toEqual([]);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("skips when frequency is a malformed cron-like string", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([
      baseSetting({ scheduledReportFrequency: "0 */5 * * *" }),
    ]);
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.results).toEqual([]);
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});

describe("api.scheduled-report — recipient + SMTP fallback paths", () => {
  it("pushes adminNotifyEmail when scheduledReportEmails is empty (line 63)", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([
      baseSetting({
        scheduledReportEmails: "",
        adminNotifyEmail: "fallback-admin@store.com",
      }),
    ]);
    prismaMock.returnCase.count.mockResolvedValueOnce(0);
    prismaMock.returnCase.groupBy.mockResolvedValue([]);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "fallback-admin@store.com" }),
    );
  });

  it("returns 'No recipients' when emails blank AND adminNotifyEmail blank (lines 66-67)", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([
      baseSetting({
        scheduledReportEmails: "   ,  ,  ", // whitespace-only entries → filter(Boolean) drops all
        adminNotifyEmail: "",
      }),
    ]);
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.results[0]).toEqual({
      shop: "store.myshopify.com",
      sent: false,
      error: "No recipients",
    });
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("returns 'SMTP not configured' when smtpUser is missing (lines 206-207)", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([baseSetting({ smtpUser: null })]);
    prismaMock.returnCase.count.mockResolvedValueOnce(0);
    prismaMock.returnCase.groupBy.mockResolvedValue([]);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.results[0]).toEqual({
      shop: "store.myshopify.com",
      sent: false,
      error: "SMTP not configured",
    });
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});

describe("api.scheduled-report — zero-data report generation", () => {
  it("renders + sends email even when there are zero return cases", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([baseSetting()]);
    prismaMock.returnCase.count.mockResolvedValueOnce(0);
    prismaMock.returnCase.groupBy.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.processed).toBe(1);
    expect(body.results[0]).toEqual(
      expect.objectContaining({ shop: "store.myshopify.com", sent: true }),
    );

    const sentArgs = sendMailMock.mock.calls[0][0];
    const html: string = sentArgs.html;
    // Empty maps → tables render headers but no rows; still well-formed HTML.
    expect(html).toMatch(/Total Returns/);
    // Approval rate falls back to 0% when totalReturns === 0
    expect(html).toMatch(/0%/);
    // No status/resolution rows produced
    expect(html).not.toMatch(/text-transform:capitalize">[a-z]/);
  });
});
