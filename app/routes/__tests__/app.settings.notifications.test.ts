/**
 * Loader + action tests for app.settings.notifications.tsx — SMTP & WhatsApp
 * notification settings, password masking + encryption, test SMTP intent,
 * email-templates persistence, and notification-log filtering.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateMock,
  findOrCreateShopMock,
  testSmtpConnectionMock,
  encryptIfNeededMock,
  decryptIfEncryptedMock,
  looksEncryptedMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  findOrCreateShopMock: vi.fn(),
  testSmtpConnectionMock: vi.fn(),
  encryptIfNeededMock: vi.fn(),
  decryptIfEncryptedMock: vi.fn(),
  looksEncryptedMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../lib/shop.server", () => ({ findOrCreateShop: findOrCreateShopMock }));
vi.mock("../../lib/notification.server", () => ({
  testSmtpConnection: testSmtpConnectionMock,
}));
vi.mock("../../lib/encryption.server", () => ({
  encryptIfNeeded: encryptIfNeededMock,
  decryptIfEncrypted: decryptIfEncryptedMock,
  looksEncrypted: looksEncryptedMock,
}));

import { loader, action } from "../app.settings.notifications";

const SMTP_PASS_PLACEHOLDER = "__UNCHANGED__";

function formReq(form: Record<string, string>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) fd.append(k, v);
  return new Request("https://x", { method: "POST", body: fd });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  findOrCreateShopMock.mockReset();
  testSmtpConnectionMock.mockReset();
  encryptIfNeededMock.mockReset().mockImplementation((v: string) => `enc:${v}`);
  decryptIfEncryptedMock.mockReset().mockImplementation((v: string | null) => {
    if (v == null) return null;
    return v.startsWith("enc:") ? v.slice(4) : v;
  });
  looksEncryptedMock.mockReset().mockImplementation((v: string) => typeof v === "string" && v.startsWith("enc:"));
});

describe("loader", () => {
  it("returns defaults when settings are null", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1", settings: null });
    prismaMock.notificationLog.findMany.mockResolvedValueOnce([]);
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.notificationNewReturn).toBe(true);
    expect(data.notificationApproved).toBe(true);
    expect(data.notificationRejected).toBe(true);
    expect(data.notificationRefunded).toBe(true);
    expect(data.smtpHost).toBe("");
    expect(data.smtpPort).toBe(587);
    expect(data.smtpPass).toBe("");
    expect(data.smtpConfigured).toBe(false);
    expect(data.whatsappEnabled).toBe(false);
    expect(data.whatsappApiKey).toBe("");
    expect(data.emailTemplatesJson).toEqual({});
    expect(data.notificationLogs).toEqual([]);
  });

  it("returns sentinel placeholder for smtpPass when configured (never sends real value)", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({
      id: "shop-1",
      settings: {
        smtpHost: "smtp.example.com",
        smtpUser: "alice",
        smtpPass: "enc:secret",
        smtpFromEmail: "from@example.com",
      },
    });
    prismaMock.notificationLog.findMany.mockResolvedValueOnce([]);
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.smtpPass).toBe(SMTP_PASS_PLACEHOLDER);
    expect(data.smtpConfigured).toBe(true);
    expect(data.smtpHost).toBe("smtp.example.com");
  });

  it("masks whatsappApiKey with the same sentinel when configured", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({
      id: "shop-1",
      settings: { whatsappEnabled: true, whatsappApiKey: "enc:wa-key" },
    });
    prismaMock.notificationLog.findMany.mockResolvedValueOnce([]);
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.whatsappApiKey).toBe(SMTP_PASS_PLACEHOLDER);
    expect(data.whatsappEnabled).toBe(true);
  });

  it("parses emailTemplatesJson; tolerates malformed JSON", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({
      id: "shop-1",
      settings: { emailTemplatesJson: "{not json" },
    });
    prismaMock.notificationLog.findMany.mockResolvedValueOnce([]);
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.emailTemplatesJson).toEqual({});
  });

  it("applies notification log filters (channel + status + q) into the prisma where clause", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1", settings: null });
    prismaMock.notificationLog.findMany.mockResolvedValueOnce([{ id: "n1" }]);
    const url = "https://x?logChannel=email&logStatus=failed&logQ=alice";
    const data = await loader({ request: new Request(url), params: {}, context: {} } as never);
    expect(data.notificationLogs).toEqual([{ id: "n1" }]);
    const arg = prismaMock.notificationLog.findMany.mock.calls[0][0];
    expect(arg.where.shopId).toBe("shop-1");
    expect(arg.where.channel).toBe("email");
    expect(arg.where.status).toBe("failed");
    expect(arg.where.OR).toEqual([
      { recipient: { contains: "alice", mode: "insensitive" } },
      { subject: { contains: "alice", mode: "insensitive" } },
    ]);
    expect(arg.take).toBe(200);
  });

  it("ignores invalid logChannel/logStatus values", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1", settings: null });
    prismaMock.notificationLog.findMany.mockResolvedValueOnce([]);
    await loader({ request: new Request("https://x?logChannel=carrier-pigeon&logStatus=maybe"), params: {}, context: {} } as never);
    const arg = prismaMock.notificationLog.findMany.mock.calls[0][0];
    expect(arg.where.channel).toBeUndefined();
    expect(arg.where.status).toBeUndefined();
  });
});

describe("action — save", () => {
  it("encrypts a freshly typed smtpPass and persists settings", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1", settings: null });
    const res = await action({
      request: formReq({
        smtpHost: "smtp.example.com",
        smtpPort: "465",
        smtpUser: "alice",
        smtpPass: "supersecret",
        smtpFromEmail: "from@example.com",
        smtpFromName: "Store",
        smtpSecure: "on",
        notificationNewReturn: "on",
      }),
      params: {}, context: {},
    } as never);
    expect(res).toEqual({ success: true });
    expect(encryptIfNeededMock).toHaveBeenCalledWith("supersecret");
    const upsertArg = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(upsertArg.where).toEqual({ shopId: "shop-1" });
    expect(upsertArg.update.smtpPass).toBe("enc:supersecret");
    expect(upsertArg.update.smtpHost).toBe("smtp.example.com");
    expect(upsertArg.update.smtpPort).toBe(465);
    expect(upsertArg.update.smtpSecure).toBe(true);
    expect(upsertArg.update.notificationNewReturn).toBe(true);
    expect(upsertArg.update.notificationApproved).toBe(false);
  });

  it("preserves existing encrypted smtpPass when placeholder is submitted", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({
      id: "shop-1",
      settings: { smtpPass: "enc:old-secret" },
    });
    await action({
      request: formReq({
        smtpHost: "smtp.example.com",
        smtpUser: "alice",
        smtpPass: SMTP_PASS_PLACEHOLDER,
      }),
      params: {}, context: {},
    } as never);
    expect(encryptIfNeededMock).not.toHaveBeenCalledWith(SMTP_PASS_PLACEHOLDER);
    const upsertArg = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(upsertArg.update.smtpPass).toBe("enc:old-secret");
  });

  it("clears smtpPass to null when an empty string is submitted", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({
      id: "shop-1",
      settings: { smtpPass: "enc:old" },
    });
    await action({
      request: formReq({ smtpPass: "" }),
      params: {}, context: {},
    } as never);
    const upsertArg = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(upsertArg.update.smtpPass).toBeNull();
  });

  it("preserves existing whatsappApiKey when placeholder submitted", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({
      id: "shop-1",
      settings: { whatsappApiKey: "enc:wa-old" },
    });
    await action({
      request: formReq({
        whatsappEnabled: "on",
        whatsappApiKey: SMTP_PASS_PLACEHOLDER,
        whatsappPhoneNumberId: "12345",
      }),
      params: {}, context: {},
    } as never);
    const upsertArg = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(upsertArg.update.whatsappApiKey).toBe("enc:wa-old");
    expect(upsertArg.update.whatsappEnabled).toBe(true);
    expect(upsertArg.update.whatsappPhoneNumberId).toBe("12345");
  });

  it("encrypts a freshly typed whatsappApiKey", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1", settings: null });
    await action({
      request: formReq({ whatsappApiKey: "wa-new-key" }),
      params: {}, context: {},
    } as never);
    expect(encryptIfNeededMock).toHaveBeenCalledWith("wa-new-key");
    const upsertArg = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(upsertArg.update.whatsappApiKey).toBe("enc:wa-new-key");
  });

  it("returns success:false with the error message when DB throws", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1", settings: null });
    prismaMock.shopSettings.upsert.mockRejectedValueOnce(new Error("DB unavailable"));
    const res = await action({ request: formReq({}), params: {}, context: {} } as never);
    expect(res).toEqual({ success: false, error: "DB unavailable" });
  });
});

describe("action — test_smtp", () => {
  it("decrypts the stored password when placeholder is submitted", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({
      id: "shop-1",
      settings: { smtpPass: "enc:real-secret" },
    });
    testSmtpConnectionMock.mockResolvedValueOnce({ success: true });
    const res = await action({
      request: formReq({
        intent: "test_smtp",
        smtpHost: "smtp.example.com",
        smtpPort: "587",
        smtpUser: "alice",
        smtpPass: SMTP_PASS_PLACEHOLDER,
        smtpSecure: "on",
      }),
      params: {}, context: {},
    } as never);
    expect(decryptIfEncryptedMock).toHaveBeenCalledWith("enc:real-secret");
    expect(testSmtpConnectionMock).toHaveBeenCalledWith({
      host: "smtp.example.com",
      port: 587,
      secure: true,
      user: "alice",
      pass: "real-secret",
    });
    expect(res).toEqual({ testResult: { success: true } });
  });

  it("falls back to '' when decryption returns null and rejects with validation error", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({
      id: "shop-1",
      settings: { smtpPass: "enc:corrupt" },
    });
    decryptIfEncryptedMock.mockReturnValueOnce(null);
    const res = await action({
      request: formReq({
        intent: "test_smtp",
        smtpHost: "smtp.example.com",
        smtpUser: "alice",
        smtpPass: SMTP_PASS_PLACEHOLDER,
      }),
      params: {}, context: {},
    } as never);
    expect(testSmtpConnectionMock).not.toHaveBeenCalled();
    expect(res).toEqual({
      testResult: { success: false, error: "Host, username, and password are required" },
    });
  });

  it("returns validation error when host/user/pass missing", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1", settings: null });
    const res = await action({
      request: formReq({ intent: "test_smtp", smtpHost: "", smtpUser: "", smtpPass: "" }),
      params: {}, context: {},
    } as never);
    expect(testSmtpConnectionMock).not.toHaveBeenCalled();
    expect(res).toEqual({
      testResult: { success: false, error: "Host, username, and password are required" },
    });
  });
});

describe("action — save_email_templates", () => {
  it("persists templates as canonical JSON", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1", settings: null });
    const tpl = { approved: { subject: "Hi", bodyHtml: "<p>x</p>" } };
    const res = await action({
      request: formReq({
        intent: "save_email_templates",
        emailTemplatesJson: JSON.stringify(tpl),
      }),
      params: {}, context: {},
    } as never);
    expect(res).toEqual({ templatesSaved: true });
    const upsertArg = prismaMock.shopSettings.upsert.mock.calls[0][0];
    expect(JSON.parse(upsertArg.update.emailTemplatesJson)).toEqual(tpl);
  });

  it("rejects malformed JSON without writing", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1", settings: null });
    const res = await action({
      request: formReq({
        intent: "save_email_templates",
        emailTemplatesJson: "{not json",
      }),
      params: {}, context: {},
    } as never);
    expect(res).toEqual({ error: "Invalid template JSON" });
    expect(prismaMock.shopSettings.upsert).not.toHaveBeenCalled();
  });
});
