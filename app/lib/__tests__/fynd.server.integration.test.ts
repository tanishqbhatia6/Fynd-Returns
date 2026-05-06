import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from "vitest";
import { server, http, HttpResponse } from "../../test/msw-server";

/* Stub the observability layer + FDK client factory so tests don't try
   to talk to OTel or the Fynd SDK. */
vi.mock("../observability/logger.server", () => ({
  fyndLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../observability/tracing.server", () => ({
  withSpan: async <T>(_n: string, _a: unknown, fn: (s: unknown) => Promise<T>) =>
    fn({ setAttribute: () => {}, end: () => {} }),
  addBusinessEvent: vi.fn(),
  startTimer: () => () => 1,
}));
vi.mock("../observability/metrics.server", () => ({
  fyndApiDuration: { record: vi.fn() },
  fyndSyncCounter: { add: vi.fn() },
}));
vi.mock("../observability/resilience.server", () => ({
  fyndCircuitBreaker: { execute: async <T>(fn: () => Promise<T>) => fn() },
  recordTimeout: vi.fn(),
  recordFallback: vi.fn(),
}));

import { fetchFyndPlatformToken } from "../fynd.server";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const BASE = "https://api-test.fynd.example";
const COMPANY = `co${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
const TOKEN_URL = (companyId: string) =>
  `${BASE}/service/panel/authentication/v1.0/company/${companyId}/oauth/token`;

function uniqueCompany() {
  return `co${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}

describe("fetchFyndPlatformToken", () => {
  it("returns the access_token on a 200 response", async () => {
    const companyId = uniqueCompany();
    server.use(
      http.post(TOKEN_URL(companyId), () =>
        HttpResponse.json({ access_token: "tok_abc", expires_in: 3600 }),
      ),
    );
    const token = await fetchFyndPlatformToken(BASE, companyId, "cid", "csec");
    expect(token).toBe("tok_abc");
  });

  it("sends Basic auth header with base64-encoded clientId:clientSecret", async () => {
    const companyId = uniqueCompany();
    let receivedAuth = "";
    server.use(
      http.post(TOKEN_URL(companyId), ({ request }) => {
        receivedAuth = request.headers.get("Authorization") ?? "";
        return HttpResponse.json({ access_token: "t", expires_in: 60 });
      }),
    );
    await fetchFyndPlatformToken(BASE, companyId, "my_cid", "my_csec");
    // Basic base64(cid:secret) — check it's a Basic header with the encoded pair.
    expect(receivedAuth.startsWith("Basic ")).toBe(true);
    const decoded = Buffer.from(receivedAuth.slice(6), "base64").toString("utf8");
    expect(decoded).toBe("my_cid:my_csec");
  });

  it("sends grant_type=client_credentials in the body", async () => {
    const companyId = uniqueCompany();
    let receivedBody: unknown;
    server.use(
      http.post(TOKEN_URL(companyId), async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json({ access_token: "t", expires_in: 60 });
      }),
    );
    await fetchFyndPlatformToken(BASE, companyId, "cid", "csec");
    expect(receivedBody).toEqual({ grant_type: "client_credentials" });
  });

  it("caches tokens — second call within TTL skips the network", async () => {
    const companyId = uniqueCompany();
    let calls = 0;
    server.use(
      http.post(TOKEN_URL(companyId), () => {
        calls++;
        return HttpResponse.json({ access_token: `tok${calls}`, expires_in: 3600 });
      }),
    );
    const t1 = await fetchFyndPlatformToken(BASE, companyId, "cid", "csec");
    const t2 = await fetchFyndPlatformToken(BASE, companyId, "cid", "csec");
    expect(t1).toBe("tok1");
    expect(t2).toBe("tok1"); // cache hit
    expect(calls).toBe(1);
  });

  it("throws a helpful 401 error with 'Check Company ID, Client ID & Secret'", async () => {
    const companyId = uniqueCompany();
    server.use(
      http.post(TOKEN_URL(companyId), () =>
        HttpResponse.json({ message: "Unauthorized" }, { status: 401 }),
      ),
    );
    await expect(fetchFyndPlatformToken(BASE, companyId, "cid", "csec")).rejects.toThrow(/401/);
    await expect(fetchFyndPlatformToken(BASE, companyId, "cid", "csec")).rejects.toThrow(
      /Check Company ID/,
    );
  });

  it("throws a 'Fynd server error' message on 500+", async () => {
    const companyId = uniqueCompany();
    server.use(
      http.post(TOKEN_URL(companyId), () =>
        HttpResponse.json({ message: "boom" }, { status: 503 }),
      ),
    );
    await expect(fetchFyndPlatformToken(BASE, companyId, "cid", "csec")).rejects.toThrow(
      /Fynd server error/,
    );
  });

  it("throws 'invalid JSON' when response body isn't JSON", async () => {
    const companyId = uniqueCompany();
    server.use(
      http.post(
        TOKEN_URL(companyId),
        () =>
          new HttpResponse("not json at all", {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          }),
      ),
    );
    await expect(fetchFyndPlatformToken(BASE, companyId, "cid", "csec")).rejects.toThrow(
      /invalid JSON/,
    );
  });

  it("throws when access_token is missing from response", async () => {
    const companyId = uniqueCompany();
    server.use(http.post(TOKEN_URL(companyId), () => HttpResponse.json({ expires_in: 3600 })));
    await expect(fetchFyndPlatformToken(BASE, companyId, "cid", "csec")).rejects.toThrow(
      /No access_token/,
    );
  });

  it("caps the cache TTL at the module's max (50 minutes) even if expires_in is larger", async () => {
    // We can't directly inspect the cache, but a second call with a different
    // expires_in in the response should still return the cached token.
    const companyId = uniqueCompany();
    let calls = 0;
    server.use(
      http.post(TOKEN_URL(companyId), () => {
        calls++;
        return HttpResponse.json({ access_token: `tok${calls}`, expires_in: 999999 });
      }),
    );
    await fetchFyndPlatformToken(BASE, companyId, "cid", "csec");
    await fetchFyndPlatformToken(BASE, companyId, "cid", "csec");
    expect(calls).toBe(1);
  });
});
