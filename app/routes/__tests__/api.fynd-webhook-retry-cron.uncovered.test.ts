/**
 * Targeted coverage for unreached arrow callbacks in
 * `app/routes/api.fynd-webhook-retry-cron.ts`.
 *
 * The two functions left uncovered by the existing suites are the inline
 * `.catch(() => {})` handlers attached to:
 *
 *   - line 94: `prisma.fyndWebhookLog.delete({ ... }).catch(() => {})`
 *     reached only when the delete itself rejects (after a successful
 *     `processFyndWebhook` re-process of an "ignored" log).
 *
 *   - line 125: `prisma.fyndWebhookLog.update({ ... }).catch(() => {})`
 *     reached only when the post-error retry-bump update rejects (i.e.
 *     `processFyndWebhook` threw AND the subsequent bookkeeping update
 *     also threw).
 *
 * Also exercises the localhost-host branch of `isAuthorized` (line 31) via
 * both `localhost` and `127.0.0.1` host headers when `CRON_SECRET` is unset.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, processFyndWebhookMock, unwrapFyndWebhookPayloadMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  processFyndWebhookMock: vi.fn(),
  unwrapFyndWebhookPayloadMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/fynd-webhook.server", () => ({
  processFyndWebhook: processFyndWebhookMock,
  unwrapFyndWebhookPayload: unwrapFyndWebhookPayloadMock,
}));

import { loader, action } from "../api.fynd-webhook-retry-cron";

const origEnv = { ...process.env };

beforeEach(() => {
  process.env = { ...origEnv };
  resetPrismaMock(prismaMock);
  processFyndWebhookMock.mockReset();
  unwrapFyndWebhookPayloadMock
    .mockReset()
    .mockImplementation((raw: string) => ({
      payload: JSON.parse(raw),
      eventType: "shipment.updated",
    }));
});

afterEach(() => {
  process.env = { ...origEnv };
});

function mkReq(opts: { method?: string; auth?: string; host?: string } = {}) {
  const headers = new Headers();
  if (opts.auth) headers.set("Authorization", opts.auth);
  if (opts.host) headers.set("Host", opts.host);
  return new Request("https://app.example/api/fynd-webhook-retry-cron", {
    method: opts.method ?? "POST",
    headers,
  });
}

const BEARER = { auth: "Bearer topsecret" };

describe("inline .catch handlers (uncovered functions)", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "topsecret";
  });

  it("succeeded branch: when prisma.delete rejects, the inline .catch swallows it and the run still reports succeeded=1", async () => {
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      { id: "del-fail-1", rawPayload: JSON.stringify({ a: 1 }), retryCount: 0 },
    ]);
    processFyndWebhookMock.mockResolvedValueOnce({ ok: true, action: "updated" });
    // Force delete() to reject — this is the only way to invoke the inline
    // arrow `.catch(() => {})` on line 94.
    prismaMock.fyndWebhookLog.delete.mockRejectedValueOnce(
      new Error("delete failed (e.g. row already gone)"),
    );

    const res = await action({
      request: mkReq({ method: "POST", ...BEARER }),
      params: {},
      context: {},
    } as never);
    const body = await res.json();

    // The throw is swallowed; the run completes normally.
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.processed).toBe(1);
    expect(body.succeeded).toBe(1);
    expect(body.rescheduled).toBe(0);
    expect(body.exhausted).toBe(0);
    // delete was attempted exactly once on the right id
    expect(prismaMock.fyndWebhookLog.delete).toHaveBeenCalledWith({ where: { id: "del-fail-1" } });
  });

  it("error-branch: when post-throw update rejects, the inline .catch swallows it and the loop continues", async () => {
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      { id: "upd-fail-1", rawPayload: JSON.stringify({}), retryCount: 0 },
      { id: "ok-2", rawPayload: JSON.stringify({}), retryCount: 0 },
    ]);
    // First log: processFyndWebhook throws → enters catch block
    // Second log: succeeds normally
    processFyndWebhookMock
      .mockRejectedValueOnce(new Error("processing exploded"))
      .mockResolvedValueOnce({ ok: true, action: "updated" });
    // The retry-bump update inside the catch block is the *first* update
    // call. Force it to reject — this is the only way to invoke the inline
    // arrow `.catch(() => {})` on line 125.
    prismaMock.fyndWebhookLog.update.mockRejectedValueOnce(
      new Error("update failed (e.g. row deleted concurrently)"),
    );

    const res = await action({
      request: mkReq({ method: "POST", ...BEARER }),
      params: {},
      context: {},
    } as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.processed).toBe(2);
    // Even though the bookkeeping update rejected, the throw still
    // increments `rescheduled` (newCount=1 < MAX_RETRIES=5).
    expect(body.rescheduled).toBe(1);
    expect(body.succeeded).toBe(1);
    expect(body.exhausted).toBe(0);
    // The catch handler swallowed the rejection — both logs were processed
    expect(processFyndWebhookMock).toHaveBeenCalledTimes(2);
  });

  it("error-branch with exhaustion: update rejects when newCount=MAX_RETRIES, .catch still swallows and exhausted is incremented", async () => {
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([
      { id: "upd-fail-exh", rawPayload: JSON.stringify({}), retryCount: 4 },
    ]);
    processFyndWebhookMock.mockRejectedValueOnce(new Error("boom on last retry"));
    prismaMock.fyndWebhookLog.update.mockRejectedValueOnce(new Error("update also failed"));

    const res = await action({
      request: mkReq({ method: "POST", ...BEARER }),
      params: {},
      context: {},
    } as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.processed).toBe(1);
    expect(body.exhausted).toBe(1);
    expect(body.rescheduled).toBe(0);
  });
});

describe("isAuthorized localhost branch (line 31)", () => {
  it("allows requests from `localhost` host header when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([]);

    const res = await action({
      request: mkReq({ method: "POST", host: "localhost:3000" }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
  });

  it("allows requests from `127.0.0.1` host header when CRON_SECRET is unset (loader/GET)", async () => {
    delete process.env.CRON_SECRET;
    prismaMock.fyndWebhookLog.findMany.mockResolvedValueOnce([]);

    const res = await loader({
      request: mkReq({ method: "GET", host: "127.0.0.1:3000" }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
  });

  it("rejects non-local hosts when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;

    const res = await action({
      request: mkReq({ method: "POST", host: "evil.example.com" }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(401);
  });

  it("rejects when CRON_SECRET is unset and no host header is present", async () => {
    delete process.env.CRON_SECRET;

    // Build a Request with no Host header — line 31's `?? ""` fallback path
    const res = await action({
      request: mkReq({ method: "POST" }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(401);
  });
});
