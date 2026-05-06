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
  resetPrismaMock(prismaMock);
  sendMailMock.mockReset().mockResolvedValue({ messageId: "x" });
  createTransportMock.mockReset().mockReturnValue({ sendMail: sendMailMock });
  decryptMock.mockReset().mockImplementation((v: string) => (v ?? "").replace(/^enc:/, ""));
});

afterEach(() => {
  process.env = { ...origEnv };
});

describe("GET /api/scheduled-report", () => {
  it("401 when CRON_SECRET set + header mismatches", async () => {
    process.env.CRON_SECRET = "secret";
    const res = await loader({
      request: mkReq({ "x-cron-secret": "wrong" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });

  it("allows when header matches CRON_SECRET", async () => {
    process.env.CRON_SECRET = "secret";
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([]);
    const res = await loader({
      request: mkReq({ "x-cron-secret": "secret" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });

  it("allows when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([]);
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
  });

  it("returns empty results when no scheduled reports enabled", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([]);
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.processed).toBe(0);
    expect(body.results).toEqual([]);
  });

  it("daily frequency always processes", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([
      baseSetting({ scheduledReportFrequency: "daily" }),
    ]);
    prismaMock.returnCase.count.mockResolvedValueOnce(5);
    prismaMock.returnCase.groupBy.mockResolvedValue([]);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(sendMailMock).toHaveBeenCalled();
  });

  it("weekly frequency skipped when dayOfWeek doesn't match", async () => {
    // Use a day that's not today — construct setting where scheduledReportDay=1 (Mon) but it's Sat
    const today = new Date().getDay() === 0 ? 7 : new Date().getDay();
    const otherDay = today === 1 ? 2 : 1;
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([
      baseSetting({
        scheduledReportFrequency: "weekly",
        scheduledReportDay: otherDay,
      }),
    ]);
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.results).toEqual([]);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("reports 'No recipients' when emails empty + no admin email", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([
      baseSetting({
        scheduledReportEmails: "",
        adminNotifyEmail: null,
      }),
    ]);
    prismaMock.returnCase.count.mockResolvedValueOnce(0);
    prismaMock.returnCase.groupBy.mockResolvedValue([]);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.results[0]).toEqual({
      shop: "store.myshopify.com",
      sent: false,
      error: "No recipients",
    });
  });

  it("reports 'SMTP not configured' when host/user missing", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([
      baseSetting({
        smtpHost: null,
        smtpUser: null,
      }),
    ]);
    prismaMock.returnCase.count.mockResolvedValueOnce(0);
    prismaMock.returnCase.groupBy.mockResolvedValue([]);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.results[0].error).toMatch(/SMTP not configured/);
  });

  it("falls back to adminNotifyEmail when scheduledReportEmails empty", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([
      baseSetting({
        scheduledReportEmails: "",
        adminNotifyEmail: "owner@shop.com",
      }),
    ]);
    prismaMock.returnCase.count.mockResolvedValueOnce(0);
    prismaMock.returnCase.groupBy.mockResolvedValue([]);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(sendMailMock).toHaveBeenCalledWith(expect.objectContaining({ to: "owner@shop.com" }));
  });

  it("decrypts encrypted SMTP password before passing to nodemailer", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([
      baseSetting({ smtpPass: "enc:secret-pw" }),
    ]);
    prismaMock.returnCase.count.mockResolvedValue(0);
    prismaMock.returnCase.groupBy.mockResolvedValue([]);
    prismaMock.returnCase.findMany.mockResolvedValue([]);
    await loader({ request: mkReq(), params: {}, context: {} } as never);
    // createTransport was called with the decrypted password
    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: expect.objectContaining({ pass: "secret-pw" }),
      }),
    );
  });

  it("captures per-shop sendMail errors without stopping the run", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([
      baseSetting({ shop: { shopDomain: "shop-a.myshopify.com" } }),
      baseSetting({ shop: { shopDomain: "shop-b.myshopify.com" } }),
    ]);
    prismaMock.returnCase.count.mockResolvedValue(0);
    prismaMock.returnCase.groupBy.mockResolvedValue([]);
    prismaMock.returnCase.findMany.mockResolvedValue([]);
    sendMailMock
      .mockRejectedValueOnce(new Error("smtp down"))
      .mockResolvedValueOnce({ messageId: "x" });

    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.processed).toBe(2);
    expect(body.results[0]).toEqual(
      expect.objectContaining({ sent: false, shop: "shop-a.myshopify.com" }),
    );
    expect(body.results[1]).toEqual(
      expect.objectContaining({ sent: true, shop: "shop-b.myshopify.com" }),
    );
  });

  it("skips unknown frequencies", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([
      baseSetting({ scheduledReportFrequency: "hourly" }),
    ]);
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.results).toEqual([]);
  });
});
