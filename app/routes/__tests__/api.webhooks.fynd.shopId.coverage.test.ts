/**
 * Extra coverage tests for the per-shop Fynd webhook receiver.
 *
 * These tests focus on three cross-cutting concerns the original spec did
 * not exhaustively cover:
 *
 *   1. Per-shop secret lookup — the route must `findUnique` on Shop *by
 *      its ID from the URL* and include `settings`, then read
 *      `settings.fyndWebhookSecret`. We assert call shape, isolation, and
 *      that the decrypted secret is what's handed to authenticateWebhook.
 *   2. Shop not found — `findUnique` returns `null`. We must respond 401
 *      with the SAME generic body as "secret missing", to prevent
 *      shopId-enumeration via timing or response diffing.
 *   3. Secret missing in DB — shop exists but `settings` is null,
 *      `settings.fyndWebhookSecret` is null/empty, or `decryptIfEncrypted`
 *      yields `null` (corrupt ciphertext). All four shapes must 401.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  processFyndWebhookMock,
  unwrapFyndWebhookPayloadMock,
  readBoundedBodyMock,
  authenticateWebhookMock,
  decryptMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  processFyndWebhookMock: vi.fn(),
  unwrapFyndWebhookPayloadMock: vi.fn(),
  readBoundedBodyMock: vi.fn(),
  authenticateWebhookMock: vi.fn(),
  decryptMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/fynd-webhook.server", () => ({
  processFyndWebhook: processFyndWebhookMock,
  unwrapFyndWebhookPayload: unwrapFyndWebhookPayloadMock,
}));
vi.mock("../../lib/fynd-webhook-verify.server", () => ({
  readBoundedBody: readBoundedBodyMock,
  authenticateWebhook: authenticateWebhookMock,
}));
vi.mock("../../lib/encryption.server", () => ({
  decryptIfEncrypted: decryptMock,
}));

import { action } from "../api.webhooks.fynd.$shopId";

function mkReq(body: string, shopId = "shop-1", headers: Record<string, string> = {}) {
  return {
    request: new Request(`https://app.example/api/webhooks/fynd/${shopId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    }),
    params: { shopId },
    context: {},
  } as never;
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  processFyndWebhookMock.mockReset().mockResolvedValue({ ok: true, action: "noop", returnCaseId: null });
  unwrapFyndWebhookPayloadMock.mockReset().mockImplementation((raw: string) => ({
    payload: JSON.parse(raw),
    eventType: "shipment.updated",
  }));
  readBoundedBodyMock.mockReset().mockImplementation(async (req: Request) => ({ body: await req.text() }));
  authenticateWebhookMock.mockReset().mockReturnValue({ ok: true });
  decryptMock.mockReset().mockImplementation((v: string | null | undefined) =>
    v ? String(v).replace(/^enc:/, "") : null,
  );
});

// ─────────────────────────────────────────────────────────────────────────
// 1. Per-shop secret lookup
// ─────────────────────────────────────────────────────────────────────────

describe("per-shop secret lookup", () => {
  it("calls prisma.shop.findUnique with the URL shopId and includes settings", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-abc",
      shopDomain: "abc.myshopify.com",
      settings: { fyndWebhookSecret: "enc:s1" },
    });
    await action(mkReq(JSON.stringify({ shipment_id: "S-1", status: "delivered" }), "shop-abc"));

    expect(prismaMock.shop.findUnique).toHaveBeenCalledTimes(1);
    expect(prismaMock.shop.findUnique).toHaveBeenCalledWith({
      where: { id: "shop-abc" },
      include: { settings: true },
    });
  });

  it("passes the decrypted secret (not the stored ciphertext) to authenticateWebhook", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: "enc:plaintext-key" },
    });
    await action(mkReq(JSON.stringify({ shipment_id: "S-1", status: "delivered" })));

    expect(decryptMock).toHaveBeenCalledWith("enc:plaintext-key");
    // 3rd arg of authenticateWebhook is the secret.
    const [, , secretArg] = authenticateWebhookMock.mock.calls[0];
    expect(secretArg).toBe("plaintext-key");
  });

  it("uses each shop's own secret — two shops in sequence don't cross-contaminate", async () => {
    prismaMock.shop.findUnique
      .mockResolvedValueOnce({
        id: "shop-A",
        shopDomain: "a.myshopify.com",
        settings: { fyndWebhookSecret: "enc:secret-A" },
      })
      .mockResolvedValueOnce({
        id: "shop-B",
        shopDomain: "b.myshopify.com",
        settings: { fyndWebhookSecret: "enc:secret-B" },
      });

    await action(mkReq(JSON.stringify({ shipment_id: "S-1", status: "delivered" }), "shop-A"));
    await action(mkReq(JSON.stringify({ shipment_id: "S-2", status: "delivered" }), "shop-B"));

    expect(authenticateWebhookMock.mock.calls[0][2]).toBe("secret-A");
    expect(authenticateWebhookMock.mock.calls[1][2]).toBe("secret-B");
  });

  it("does NOT consult any global FYND_WEBHOOK_SECRET env var", async () => {
    const prevEnv = process.env.FYND_WEBHOOK_SECRET;
    process.env.FYND_WEBHOOK_SECRET = "GLOBAL_SHOULD_NOT_BE_USED";
    try {
      prismaMock.shop.findUnique.mockResolvedValueOnce({
        id: "shop-1",
        shopDomain: "store.myshopify.com",
        settings: { fyndWebhookSecret: "enc:per-shop" },
      });
      await action(mkReq(JSON.stringify({ shipment_id: "S-1", status: "delivered" })));

      const [, , secretArg] = authenticateWebhookMock.mock.calls[0];
      expect(secretArg).toBe("per-shop");
      expect(secretArg).not.toBe("GLOBAL_SHOULD_NOT_BE_USED");
    } finally {
      if (prevEnv === undefined) delete process.env.FYND_WEBHOOK_SECRET;
      else process.env.FYND_WEBHOOK_SECRET = prevEnv;
    }
  });

  it("injects the looked-up shopDomain into the payload (not the URL shopId)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-xyz",
      shopDomain: "real-domain.myshopify.com",
      settings: { fyndWebhookSecret: "enc:k" },
    });
    processFyndWebhookMock.mockResolvedValueOnce({ ok: true, action: "updated", returnCaseId: "rc" });

    await action(mkReq(JSON.stringify({ shipment_id: "S-1", status: "delivered" }), "shop-xyz"));

    const [payloadArg] = processFyndWebhookMock.mock.calls[0];
    expect(payloadArg._shop_domain).toBe("real-domain.myshopify.com");
    expect(payloadArg._shop_domain).not.toBe("shop-xyz");
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. Shop not found
// ─────────────────────────────────────────────────────────────────────────

describe("shop not found", () => {
  it("returns 401 with generic error body (no 'shop not found' leak)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const res = await action(mkReq(JSON.stringify({ shipment_id: "S-1" }), "ghost-shop"));
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toEqual({ error: "Webhook authentication failed" });
    expect(JSON.stringify(body).toLowerCase()).not.toContain("not found");
    expect(JSON.stringify(body).toLowerCase()).not.toContain("shop");
  });

  it("does NOT call authenticateWebhook when shop is missing", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    await action(mkReq(JSON.stringify({ shipment_id: "S-1" }), "ghost-shop"));
    expect(authenticateWebhookMock).not.toHaveBeenCalled();
    expect(processFyndWebhookMock).not.toHaveBeenCalled();
  });

  it("anti-enumeration: same status + body whether shop is missing OR secret is missing", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    const a = await action(mkReq(JSON.stringify({ shipment_id: "S-1" }), "missing-shop"));
    const aBody = await a.json();

    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "real-shop",
      shopDomain: "real.myshopify.com",
      settings: { fyndWebhookSecret: null },
    });
    const b = await action(mkReq(JSON.stringify({ shipment_id: "S-1" }), "real-shop"));
    const bBody = await b.json();

    expect(a.status).toBe(b.status);
    expect(a.status).toBe(401);
    expect(aBody).toEqual(bBody);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. Secret missing in DB
// ─────────────────────────────────────────────────────────────────────────

describe("secret missing in DB", () => {
  it("401 when shop has no settings row at all", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: null,
    });
    const res = await action(mkReq(JSON.stringify({ shipment_id: "S-1" })));
    expect(res.status).toBe(401);
    expect(authenticateWebhookMock).not.toHaveBeenCalled();
  });

  it("401 when settings.fyndWebhookSecret is explicitly null", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: null },
    });
    const res = await action(mkReq(JSON.stringify({ shipment_id: "S-1" })));
    expect(res.status).toBe(401);
    expect(processFyndWebhookMock).not.toHaveBeenCalled();
  });

  it("401 when settings.fyndWebhookSecret is undefined (column never set)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: undefined },
    });
    const res = await action(mkReq(JSON.stringify({ shipment_id: "S-1" })));
    expect(res.status).toBe(401);
  });

  it("401 when settings.fyndWebhookSecret is an empty string", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: "" },
    });
    const res = await action(mkReq(JSON.stringify({ shipment_id: "S-1" })));
    expect(res.status).toBe(401);
    expect(authenticateWebhookMock).not.toHaveBeenCalled();
  });

  it("401 when decryptIfEncrypted returns null (corrupt/unreadable ciphertext)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: "enc:corrupt" },
    });
    decryptMock.mockReturnValueOnce(null);
    const res = await action(mkReq(JSON.stringify({ shipment_id: "S-1" })));
    expect(res.status).toBe(401);
    expect(authenticateWebhookMock).not.toHaveBeenCalled();
  });

  it("decryption is attempted before the 401 short-circuit (so we don't 401 on a valid-but-encrypted secret)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndWebhookSecret: "enc:abc" },
    });
    await action(mkReq(JSON.stringify({ shipment_id: "S-1", status: "delivered" })));
    expect(decryptMock).toHaveBeenCalledWith("enc:abc");
  });
});
