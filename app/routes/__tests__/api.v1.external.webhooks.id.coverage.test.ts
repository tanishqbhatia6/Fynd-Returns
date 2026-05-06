import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateApiKeyMock, checkRateLimitMock, checkPerKeyRateLimitMock } =
  vi.hoisted(() => ({
    prismaMock: {} as ReturnType<typeof createPrismaMock>,
    authenticateApiKeyMock: vi.fn(),
    checkRateLimitMock: vi.fn(async () => ({ allowed: true, remaining: 10, retryAfterMs: 0 })),
    checkPerKeyRateLimitMock: vi.fn<(...args: unknown[]) => Promise<Response | null>>(
      async () => null,
    ),
  }));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/api-key-auth.server", () => ({ authenticateApiKey: authenticateApiKeyMock }));
vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: checkRateLimitMock,
  rateLimitResponse: () => Response.json({ error: "rate" }, { status: 429 }),
}));
vi.mock("../../lib/external-api-helpers.server", async () => {
  const actual = await vi.importActual<typeof import("../../lib/external-api-helpers.server")>(
    "../../lib/external-api-helpers.server",
  );
  return { ...actual, checkPerKeyRateLimit: checkPerKeyRateLimitMock };
});

import { action } from "../api.v1.external.webhooks.$id";

const mkReq = (method: string = "DELETE", id: string = "sub-1") =>
  new Request(`https://app.example/api/v1/external/webhooks/${id}`, { method });

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateApiKeyMock.mockReset();
  checkRateLimitMock
    .mockReset()
    .mockResolvedValue({ allowed: true, remaining: 10, retryAfterMs: 0 });
  checkPerKeyRateLimitMock.mockReset().mockResolvedValue(null);
});

describe("DELETE /api/v1/external/webhooks/:id — extended coverage", () => {
  // ── method-not-allowed coverage across verbs ──
  it.each(["GET", "POST", "PATCH", "OPTIONS"])(
    "405 + standard error envelope on %s",
    async (method) => {
      const res = await action({
        request: mkReq(method),
        params: { id: "sub-1" },
        context: {},
      } as never);
      expect(res.status).toBe(405);
      const body = await res.json();
      expect(body.error).toMatchObject({ code: "METHOD_NOT_ALLOWED" });
    },
  );

  // ── permission failure (manage_webhooks scope rejected) ──
  it("403 when API key lacks manage_webhooks permission (FORBIDDEN)", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({
      ok: false,
      response: Response.json(
        { error: { code: "FORBIDDEN", message: "Missing required permission: manage_webhooks" } },
        { status: 403 },
      ),
    });
    const res = await action({ request: mkReq(), params: { id: "sub-1" }, context: {} } as never);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN");
    // Permission failure must short-circuit before any DB work
    expect(prismaMock.webhookSubscription.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.webhookSubscription.update).not.toHaveBeenCalled();
  });

  it("requests the manage_webhooks permission from authenticateApiKey", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    prismaMock.webhookSubscription.findFirst.mockResolvedValueOnce({
      id: "sub-1",
      shopId: "shop-1",
    });
    await action({ request: mkReq(), params: { id: "sub-1" }, context: {} } as never);
    expect(authenticateApiKeyMock).toHaveBeenCalledWith(expect.any(Request), "manage_webhooks");
  });

  // ── tenant isolation ──
  it("404 when subscription belongs to a different shop (tenant scoping)", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    // Simulating Prisma narrowing on shopId — the row exists in DB for shop-2
    // but findFirst({ where: { id, shopId: 'shop-1' } }) returns null.
    prismaMock.webhookSubscription.findFirst.mockResolvedValueOnce(null);
    const res = await action({ request: mkReq(), params: { id: "sub-1" }, context: {} } as never);
    expect(res.status).toBe(404);
    expect(prismaMock.webhookSubscription.findFirst).toHaveBeenCalledWith({
      where: { id: "sub-1", shopId: "shop-1" },
    });
    // Must never call update if not found
    expect(prismaMock.webhookSubscription.update).not.toHaveBeenCalled();
  });

  // ── soft-delete semantics ──
  it("soft-deletes — does not hard-delete the row", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    prismaMock.webhookSubscription.findFirst.mockResolvedValueOnce({
      id: "sub-1",
      shopId: "shop-1",
      isActive: true,
    });
    const res = await action({ request: mkReq(), params: { id: "sub-1" }, context: {} } as never);
    expect(res.status).toBe(200);
    // Critical: never call hard delete / deleteMany
    expect(prismaMock.webhookSubscription.delete).not.toHaveBeenCalled();
    expect(prismaMock.webhookSubscription.deleteMany).not.toHaveBeenCalled();
    // Update flips isActive=false (and only that)
    expect(prismaMock.webhookSubscription.update).toHaveBeenCalledTimes(1);
    const updateArg = prismaMock.webhookSubscription.update.mock.calls[0][0];
    expect(updateArg.data).toEqual({ isActive: false });
  });

  it("returns success envelope { data: { id, message }, errors: [] }", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    prismaMock.webhookSubscription.findFirst.mockResolvedValueOnce({
      id: "sub-xyz",
      shopId: "shop-1",
    });
    const res = await action({
      request: mkReq("DELETE", "sub-xyz"),
      params: { id: "sub-xyz" },
      context: {},
    } as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      data: { id: "sub-xyz", message: "Webhook subscription removed" },
      errors: [],
    });
  });

  // ── idempotency: deleting an already-soft-deleted subscription still succeeds ──
  it("200 when deleting an already-soft-deleted (isActive=false) subscription (idempotent)", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    prismaMock.webhookSubscription.findFirst.mockResolvedValueOnce({
      id: "sub-1",
      shopId: "shop-1",
      isActive: false,
    });
    const res = await action({ request: mkReq(), params: { id: "sub-1" }, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.webhookSubscription.update).toHaveBeenCalledWith({
      where: { id: "sub-1" },
      data: { isActive: false },
    });
  });

  // ── error path on update step (post-find) ──
  it("500 when prisma.update throws after a successful find", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    prismaMock.webhookSubscription.findFirst.mockResolvedValueOnce({
      id: "sub-1",
      shopId: "shop-1",
    });
    prismaMock.webhookSubscription.update.mockRejectedValueOnce(new Error("update boom"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await action({ request: mkReq(), params: { id: "sub-1" }, context: {} } as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe("INTERNAL_ERROR");
    errSpy.mockRestore();
  });

  // ── ordering: rate-limit must run BEFORE auth ──
  it("does not call authenticateApiKey when IP rate-limit blocks the request", async () => {
    checkRateLimitMock.mockResolvedValueOnce({ allowed: false, remaining: 0, retryAfterMs: 1000 });
    const res = await action({ request: mkReq(), params: { id: "sub-1" }, context: {} } as never);
    expect(res.status).toBe(429);
    expect(authenticateApiKeyMock).not.toHaveBeenCalled();
  });

  // ── ordering: per-key limit runs AFTER auth, BEFORE DB ──
  it("does not touch DB when per-key rate limit fires", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    checkPerKeyRateLimitMock.mockResolvedValueOnce(
      Response.json({ error: "rate" }, { status: 429 }),
    );
    const res = await action({ request: mkReq(), params: { id: "sub-1" }, context: {} } as never);
    expect(res.status).toBe(429);
    expect(prismaMock.webhookSubscription.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.webhookSubscription.update).not.toHaveBeenCalled();
  });

  // ── empty-string id is treated as missing ──
  it("400 when id param is an empty string", async () => {
    authenticateApiKeyMock.mockResolvedValueOnce({ ok: true, keyId: "k-1", shopId: "shop-1" });
    const res = await action({ request: mkReq(), params: { id: "" }, context: {} } as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("BAD_REQUEST");
  });
});
