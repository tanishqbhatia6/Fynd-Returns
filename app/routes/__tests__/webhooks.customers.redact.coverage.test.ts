/**
 * Coverage-focused tests for webhooks.customers.redact.tsx.
 *
 * Existing webhooks.customers.redact.test.ts covers early returns + auth
 * propagation. This file targets the remaining uncovered branches:
 *   - normalizePhone: trim → empty → null path (lines 19-22)
 *   - normalizePhone: real phone string with separators
 *   - full happy path: returnCase.updateMany + lookupSession.deleteMany +
 *     notificationLog.deleteMany + fyndWebhookLog.findMany / updateMany
 *     (lines 80-151)
 *   - fyndWebhookLog.findMany returning [] (skip updateMany branch)
 *   - phone-only customer (no email) — exercises the `customerPhone` branch
 *     in conditions + lookupValues + fynd OR clause
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateWebhookMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateWebhookMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({
  authenticate: { webhook: authenticateWebhookMock },
}));

import { action } from "../webhooks.customers.redact";

function mkReq() {
  return new Request("https://app.example/webhooks/x", { method: "POST" });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateWebhookMock.mockReset();
});

describe("webhooks.customers.redact — coverage", () => {
  it("happy path: redacts return cases, deletes lookup sessions + notification logs, anonymizes fynd logs", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        customer: {
          id: 12345,
          email: "Customer@Example.COM",
          phone: "+1 (555) 123-4567",
        },
      },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([{ id: "rc-1" }, { id: "rc-2" }]);
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([{ id: "fl-1" }, { id: "fl-2" }]);

    const res = await action({
      request: mkReq(),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);

    // returnCase.updateMany called with all PII fields blanked
    expect(prismaMock.returnCase.updateMany).toHaveBeenCalledTimes(1);
    const rcCall = prismaMock.returnCase.updateMany.mock.calls[0]?.[0];
    expect(rcCall.where).toEqual({ id: { in: ["rc-1", "rc-2"] } });
    expect(rcCall.data.customerName).toBe("[redacted]");
    expect(rcCall.data.customerEmailNorm).toBeNull();
    expect(rcCall.data.customerPhoneNorm).toBeNull();
    expect(rcCall.data.giftRecipientEmail).toBeNull();

    // lookupSession.deleteMany got both normalized email + phone
    expect(prismaMock.lookupSession.deleteMany).toHaveBeenCalledTimes(1);
    const lsCall = prismaMock.lookupSession.deleteMany.mock.calls[0]?.[0];
    expect(lsCall.where.shopId).toBe("shop-1");
    expect(lsCall.where.lookupValueNorm.in).toEqual(["customer@example.com", "+15551234567"]);

    // notificationLog.deleteMany scoped to caseIds
    expect(prismaMock.notificationLog.deleteMany).toHaveBeenCalledWith({
      where: {
        shopId: "shop-1",
        returnCaseId: { in: ["rc-1", "rc-2"] },
      },
    });

    // fyndWebhookLog.updateMany hit because findMany returned 2 ids
    expect(prismaMock.fyndWebhookLog.updateMany).toHaveBeenCalledTimes(1);
    const flCall = prismaMock.fyndWebhookLog.updateMany.mock.calls[0]?.[0];
    expect(flCall.where).toEqual({ id: { in: ["fl-1", "fl-2"] } });
    expect(flCall.data).toEqual({
      customerName: null,
      customerEmail: null,
      customerPhone: null,
    });
  });

  it("skips fyndWebhookLog.updateMany when no fynd logs match", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { customer: { id: 1, email: "a@b.com" } },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([{ id: "rc-1" }]);
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([]);

    const res = await action({
      request: mkReq(),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.updateMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.fyndWebhookLog.updateMany).not.toHaveBeenCalled();
  });

  it("phone-only customer: still finds and redacts (covers normalizePhone trim + empty branches indirectly)", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        customer: {
          id: 7,
          // no email — only phone
          phone: "  +44 20 7946 0958  ",
        },
      },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([{ id: "rc-9" }]);
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([{ id: "fl-9" }]);

    const res = await action({
      request: mkReq(),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);

    // findMany conditions: only customerPhoneNorm (no email)
    const rcFind = prismaMock.returnCase.findMany.mock.calls[0]?.[0];
    expect(rcFind.where.OR).toEqual([{ customerPhoneNorm: "+442079460958" }]);

    // lookupSession: only the phone value
    const lsCall = prismaMock.lookupSession.deleteMany.mock.calls[0]?.[0];
    expect(lsCall.where.lookupValueNorm.in).toEqual(["+442079460958"]);

    // fynd findMany OR includes phone but NOT email
    const fyndFind = prismaMock.fyndWebhookLog.findMany.mock.calls[0]?.[0];
    expect(fyndFind.where.OR).toEqual([
      { customerPhone: "+442079460958" },
      { returnCaseId: { in: ["rc-9"] } },
    ]);
  });

  it("normalizePhone: whitespace-only phone is treated as no phone (skips when no email either)", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        customer: {
          id: 99,
          phone: "   ", // trims to empty → returns null (lines 19-20)
        },
      },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });

    const res = await action({
      request: mkReq(),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    // No identifiers ⇒ findMany on returnCase never called
    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
  });

  it("shop not found: early-returns 200 without touching returnCase tables", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "ghost.myshopify.com",
      payload: { customer: { id: 1, email: "x@y.com", phone: "+15551234567" } },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);

    const res = await action({
      request: mkReq(),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
    expect(prismaMock.returnCase.updateMany).not.toHaveBeenCalled();
    expect(prismaMock.fyndWebhookLog.findMany).not.toHaveBeenCalled();
  });

  it("swallows DB errors thrown deep in the redaction pipeline (catch block)", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: { customer: { id: 1, email: "a@b.com" } },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([{ id: "rc-1" }]);
    // Error thrown mid-pipeline — exercises the catch block
    prismaMock.returnCase.updateMany.mockRejectedValueOnce(new Error("constraint violation"));

    const res = await action({
      request: mkReq(),
      params: {},
      context: {},
    } as never);

    // Handler must still return 200 — Shopify retries otherwise
    expect(res.status).toBe(200);
    // Downstream operations after the throw should not have run
    expect(prismaMock.lookupSession.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.notificationLog.deleteMany).not.toHaveBeenCalled();
    expect(prismaMock.fyndWebhookLog.findMany).not.toHaveBeenCalled();
  });

  it("normalizePhone: junk-only phone (no digits/+) cleans to empty → null, falls through to email-only path", async () => {
    authenticateWebhookMock.mockResolvedValueOnce({
      shop: "store.myshopify.com",
      payload: {
        customer: {
          id: 100,
          email: "x@y.com",
          phone: "abc-def", // cleaned ⇒ "" ⇒ null (line 22 falsy branch)
        },
      },
    });
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    const res = await action({
      request: mkReq(),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    const rcFind = prismaMock.returnCase.findMany.mock.calls[0]?.[0];
    // Only email condition — no phone
    expect(rcFind.where.OR).toEqual([{ customerEmailNorm: "x@y.com" }]);
  });
});
