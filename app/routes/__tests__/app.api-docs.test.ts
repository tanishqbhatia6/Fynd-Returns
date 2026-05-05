/**
 * Loader tests for app.api-docs.tsx — surfaces the external API endpoints
 * registry along with a baseUrl used to build the Postman download link.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { authenticateMock } = vi.hoisted(() => ({
  authenticateMock: vi.fn(),
}));

vi.mock("../../shopify.server", () => ({
  authenticate: { admin: authenticateMock },
}));

vi.mock("../../components/AppPage", () => ({
  AppPage: ({ children }: { children: unknown }) => children,
}));

vi.mock("../../lib/api-docs-data", () => ({
  EXTERNAL_API_ENDPOINTS: [
    {
      method: "GET",
      path: "/api/v1/external/returns",
      name: "List Returns",
      description: "List returns",
      permission: "read_returns",
      folder: "Returns",
      responseExample: { data: [] },
      errorCodes: [],
    },
    {
      method: "POST",
      path: "/api/v1/external/returns/:id/approve",
      name: "Approve Return",
      description: "Approve",
      permission: "write_returns",
      folder: "Returns",
      responseExample: { ok: true },
      errorCodes: [{ status: 404, code: "NOT_FOUND", when: "missing" }],
    },
    {
      method: "DELETE",
      path: "/api/v1/external/webhooks/:id",
      name: "Delete Webhook",
      description: "Delete a webhook",
      permission: "manage_webhooks",
      folder: "Webhooks",
      responseExample: { deleted: true },
      errorCodes: [],
    },
  ],
}));

import { loader } from "../app.api-docs";

const origAppUrl = process.env.SHOPIFY_APP_URL;

beforeEach(() => {
  authenticateMock.mockReset().mockResolvedValue({
    session: { shop: "store.myshopify.com" },
  });
});

afterEach(() => {
  if (origAppUrl === undefined) delete process.env.SHOPIFY_APP_URL;
  else process.env.SHOPIFY_APP_URL = origAppUrl;
});

describe("loader", () => {
  it("authenticates the admin request", async () => {
    delete process.env.SHOPIFY_APP_URL;
    const request = new Request("https://example.myshopify.com/app/api-docs");
    await loader({ request, params: {}, context: {} } as never);
    expect(authenticateMock).toHaveBeenCalledTimes(1);
    expect(authenticateMock).toHaveBeenCalledWith(request);
  });

  it("returns the EXTERNAL_API_ENDPOINTS registry", async () => {
    delete process.env.SHOPIFY_APP_URL;
    const data = await loader({
      request: new Request("https://example.myshopify.com/app/api-docs"),
      params: {},
      context: {},
    } as never);
    expect(Array.isArray(data.endpoints)).toBe(true);
    expect(data.endpoints).toHaveLength(3);
  });

  it("includes endpoint method/path/permission fields needed by the UI", async () => {
    delete process.env.SHOPIFY_APP_URL;
    const data = await loader({
      request: new Request("https://example.myshopify.com/app/api-docs"),
      params: {},
      context: {},
    } as never);
    const ep = data.endpoints[0];
    expect(ep.method).toBe("GET");
    expect(ep.path).toBe("/api/v1/external/returns");
    expect(ep.permission).toBe("read_returns");
    expect(ep.folder).toBe("Returns");
  });

  it("uses SHOPIFY_APP_URL env var as baseUrl when set", async () => {
    process.env.SHOPIFY_APP_URL = "https://app.returnpromax.com";
    const data = await loader({
      request: new Request("https://tunnel.example.com/app/api-docs"),
      params: {},
      context: {},
    } as never);
    expect(data.baseUrl).toBe("https://app.returnpromax.com");
  });

  it("falls back to request URL origin when SHOPIFY_APP_URL is unset", async () => {
    delete process.env.SHOPIFY_APP_URL;
    const data = await loader({
      request: new Request("https://tunnel.example.com/app/api-docs?foo=bar"),
      params: {},
      context: {},
    } as never);
    expect(data.baseUrl).toBe("https://tunnel.example.com");
  });

  it("falls back to request URL origin when SHOPIFY_APP_URL is empty string", async () => {
    process.env.SHOPIFY_APP_URL = "";
    const data = await loader({
      request: new Request("https://tunnel.example.com/app/api-docs"),
      params: {},
      context: {},
    } as never);
    expect(data.baseUrl).toBe("https://tunnel.example.com");
  });

  it("baseUrl can be combined into a Postman collection download URL", async () => {
    process.env.SHOPIFY_APP_URL = "https://app.example.com";
    const data = await loader({
      request: new Request("https://x"),
      params: {},
      context: {},
    } as never);
    expect(`${data.baseUrl}/api/v1/external/postman`).toBe(
      "https://app.example.com/api/v1/external/postman",
    );
  });

  it("propagates auth failures from authenticate.admin", async () => {
    authenticateMock.mockReset().mockRejectedValueOnce(new Response(null, { status: 302 }));
    await expect(
      loader({
        request: new Request("https://example.myshopify.com/app/api-docs"),
        params: {},
        context: {},
      } as never),
    ).rejects.toBeInstanceOf(Response);
  });

  it("does not fetch data when authentication fails", async () => {
    authenticateMock.mockReset().mockRejectedValueOnce(new Error("unauthenticated"));
    await expect(
      loader({
        request: new Request("https://x"),
        params: {},
        context: {},
      } as never),
    ).rejects.toThrow("unauthenticated");
  });

  it("returns endpoints spanning all expected folders", async () => {
    delete process.env.SHOPIFY_APP_URL;
    const data = await loader({
      request: new Request("https://example.myshopify.com/app/api-docs"),
      params: {},
      context: {},
    } as never);
    const folders = new Set(data.endpoints.map((e) => e.folder));
    expect(folders.has("Returns")).toBe(true);
    expect(folders.has("Webhooks")).toBe(true);
  });

  it("returns endpoints with all HTTP methods used by the UI badges", async () => {
    delete process.env.SHOPIFY_APP_URL;
    const data = await loader({
      request: new Request("https://example.myshopify.com/app/api-docs"),
      params: {},
      context: {},
    } as never);
    const methods = new Set(data.endpoints.map((e) => e.method));
    expect(methods).toEqual(new Set(["GET", "POST", "DELETE"]));
  });

  it("preserves errorCodes shape on each endpoint", async () => {
    delete process.env.SHOPIFY_APP_URL;
    const data = await loader({
      request: new Request("https://example.myshopify.com/app/api-docs"),
      params: {},
      context: {},
    } as never);
    for (const ep of data.endpoints) {
      expect(Array.isArray(ep.errorCodes)).toBe(true);
    }
    const approve = data.endpoints.find((e) => e.name === "Approve Return")!;
    expect(approve.errorCodes[0]).toEqual({
      status: 404,
      code: "NOT_FOUND",
      when: "missing",
    });
  });
});
