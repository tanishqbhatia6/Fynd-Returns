/**
 * Extra coverage tests for /api/scheduled-report focused on:
 *   - timing-safe-equal across length mismatches (and equal-length mismatches)
 *   - weekly day-of-week filtering (match + skip + Sunday=7 wrap)
 *   - monthly day-of-month filtering (match + skip + default day)
 *   - SMTP send error handling (transport throws, sendMail rejects, decrypt throws)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  sendMailMock,
  createTransportMock,
  decryptMock,
} = vi.hoisted(() => {
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

/** Returns 1..7 day-of-week (Mon=1, Sun=7) for a given Date. */
function dow(d: Date): number {
  return d.getDay() === 0 ? 7 : d.getDay();
}

beforeEach(() => {
  process.env = { ...origEnv };
  resetPrismaMock(prismaMock);
  // resetPrismaMock only does .mockClear(), which preserves queued
  // mockResolvedValueOnce values across tests. Fully reset the mocks our
  // tests actually queue values onto so leftover once-values don't bleed.
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

describe("api.scheduled-report — timing-safe-equal length mismatches", () => {
  it("rejects when header is shorter than the secret", async () => {
    process.env.CRON_SECRET = "supersecretvalue";
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([]);
    const res = await loader({
      request: mkReq({ "x-cron-secret": "short" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });

  it("rejects when header is longer than the secret", async () => {
    process.env.CRON_SECRET = "abc";
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([]);
    const res = await loader({
      request: mkReq({ "x-cron-secret": "abc-extra-padding-bytes" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });

  it("rejects when header is missing entirely (length-0 vs non-zero secret)", async () => {
    process.env.CRON_SECRET = "secret-value";
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([]);
    const res = await loader({
      request: mkReq(),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });

  it("rejects equal-length header that differs by one byte", async () => {
    process.env.CRON_SECRET = "abcdef";
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([]);
    const res = await loader({
      request: mkReq({ "x-cron-secret": "abcdeg" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(401);
  });

  it("accepts matching header even when secret is single byte (edge length)", async () => {
    process.env.CRON_SECRET = "x";
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([]);
    const res = await loader({
      request: mkReq({ "x-cron-secret": "x" }),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
  });
});

describe("api.scheduled-report — weekly day filtering", () => {
  it("sends when weekly day matches today's day-of-week", async () => {
    const today = dow(new Date());
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([
      baseSetting({ scheduledReportFrequency: "weekly", scheduledReportDay: today }),
    ]);
    await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it("skips when weekly day does not match (and defaults to Mon=1 when null)", async () => {
    // Pin clock to a Tuesday (2026-05-05 is a Tuesday → dow=2). Default day = 1 (Mon).
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-05T12:00:00Z"));
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([
      baseSetting({ scheduledReportFrequency: "weekly", scheduledReportDay: null }),
    ]);
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.results).toEqual([]);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("treats Sunday as 7 (not 0) for weekly matching", async () => {
    // 2026-05-03 is a Sunday → loader should map dayOfWeek to 7.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-03T12:00:00Z"));
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([
      baseSetting({ scheduledReportFrequency: "weekly", scheduledReportDay: 7 }),
    ]);
    await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });
});

describe("api.scheduled-report — monthly day filtering", () => {
  it("sends when monthly day matches today's day-of-month", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([
      baseSetting({ scheduledReportFrequency: "monthly", scheduledReportDay: 15 }),
    ]);
    await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });

  it("skips when monthly day differs from today", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-15T12:00:00Z"));
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([
      baseSetting({ scheduledReportFrequency: "monthly", scheduledReportDay: 1 }),
    ]);
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.results).toEqual([]);
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it("defaults monthly day to 1 when scheduledReportDay is null", async () => {
    // Pin to the 1st so default-of-1 matches and we send.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00Z"));
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([
      baseSetting({ scheduledReportFrequency: "monthly", scheduledReportDay: null }),
    ]);
    await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(sendMailMock).toHaveBeenCalledTimes(1);
  });
});

describe("api.scheduled-report — SMTP send error handling", () => {
  it("captures sendMail rejection in per-shop error string", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([baseSetting()]);
    sendMailMock.mockReset().mockRejectedValueOnce(new Error("relay refused"));
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.processed).toBe(1);
    expect(body.results[0]).toEqual(
      expect.objectContaining({ shop: "store.myshopify.com", sent: false }),
    );
    expect(body.results[0].error).toMatch(/relay refused/);
  });

  it("captures createTransport throw without crashing the loop", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([
      baseSetting({ shop: { shopDomain: "a.myshopify.com" } }),
      baseSetting({ shop: { shopDomain: "b.myshopify.com" } }),
    ]);
    createTransportMock
      .mockReset()
      .mockImplementationOnce(() => {
        throw new Error("invalid SMTP config");
      })
      .mockImplementation(() => ({ sendMail: sendMailMock }));

    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.processed).toBe(2);
    expect(body.results[0]).toEqual(
      expect.objectContaining({ shop: "a.myshopify.com", sent: false }),
    );
    expect(body.results[0].error).toMatch(/invalid SMTP config/);
    expect(body.results[1]).toEqual(
      expect.objectContaining({ shop: "b.myshopify.com", sent: true }),
    );
  });

  it("captures decryptIfEncrypted throw as a per-shop error", async () => {
    prismaMock.shopSettings.findMany.mockResolvedValueOnce([baseSetting()]);
    decryptMock.mockReset().mockImplementationOnce(() => {
      throw new Error("decrypt failed");
    });
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const body = await res.json();
    expect(body.results[0]).toEqual(
      expect.objectContaining({ sent: false, shop: "store.myshopify.com" }),
    );
    expect(body.results[0].error).toMatch(/decrypt failed/);
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});
