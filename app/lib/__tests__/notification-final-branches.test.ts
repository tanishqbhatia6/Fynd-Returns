import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * notification.server.ts — additional branch coverage.
 * Targets the customerPhone-truthy WA paths in approval/rejection/refund/cancellation
 * (lines 516, 578, 824, 881) and the cancellationDeclined path (881).
 */

const { prismaMock, sendMailMock, createTransportMock } = vi.hoisted(() => {
  const sendMail = vi.fn();
  const createTransport = vi.fn(() => ({ sendMail, verify: vi.fn() }));
  return {
    sendMailMock: sendMail,
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

vi.mock("../portal-i18n", () => ({
  getPortalLabels: () => ({}) as Record<string, string>,
  t: (k: string) => k,
}));

vi.mock("../i18n.server", () => ({
  formatMoney: (amt: string, cur: string) => `${cur} ${amt}`,
  isRtlLocale: () => false,
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

import {
  sendApprovalNotification,
  sendRejectionNotification,
  sendRefundNotification,
  sendCancellationDeclinedNotification,
} from "../notification.server";

function makeShopWithSmtpAndWa() {
  return {
    id: "shop-1",
    shopDomain: "wa-shop.myshopify.com",
    settings: {
      id: "s1",
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: "u",
      smtpPass: "p",
      smtpFromEmail: "from@example.com",
      smtpFromName: "Store",
      notificationApproved: true,
      notificationRejected: true,
      notificationRefunded: true,
      notificationCancelled: true,
      adminNotifyEmail: null,
      emailTemplatesJson: null,
      portalLanguage: "en",
      shopCurrency: "USD",
      whatsappEnabled: true,
      whatsappApiKey: "k1",
      whatsappProvider: "twilio", // not meta_cloud → goes to "skip" branch returning success
    },
  };
}

beforeEach(() => {
  prismaMock.shop.findUnique.mockReset();
  sendMailMock.mockReset().mockResolvedValue(undefined);
  createTransportMock.mockClear();
  prismaMock.notificationLog.create.mockReset().mockResolvedValue({});
});

describe("WhatsApp follow-up branches with customerPhone set", () => {
  it("sendApprovalNotification with customerPhone reaches WA branch", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtpAndWa());
    const r = await sendApprovalNotification({
      shopDomain: "wa-shop.myshopify.com",
      to: "c@example.com",
      orderName: "#1001",
      customerPhone: "+15551234567",
      notes: "ship soon",
    });
    expect(r.success).toBe(true);
  });

  it("sendRejectionNotification with customerPhone reaches WA branch", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtpAndWa());
    const r = await sendRejectionNotification({
      shopDomain: "wa-shop.myshopify.com",
      to: "c@example.com",
      orderName: "#1002",
      rejectionReason: "Outside window",
      customerPhone: "+15551234568",
    });
    expect(r.success).toBe(true);
  });

  it("sendRefundNotification with customerPhone + amount reaches WA branch", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtpAndWa());
    const r = await sendRefundNotification({
      shopDomain: "wa-shop.myshopify.com",
      to: "c@example.com",
      orderName: "#1003",
      amount: "10.00",
      currency: "USD",
      customerPhone: "+15551234569",
    });
    expect(r.success).toBe(true);
  });

  it("sendCancellationDeclinedNotification with customerPhone reaches WA branch", async () => {
    prismaMock.shop.findUnique.mockResolvedValue(makeShopWithSmtpAndWa());
    const r = await sendCancellationDeclinedNotification({
      shopDomain: "wa-shop.myshopify.com",
      to: "c@example.com",
      orderName: "#1004",
      customerPhone: "+15551234570",
    });
    expect(r.success).toBe(true);
  });
});
