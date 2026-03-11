import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getPortalCorsHeaders, withCors } from "../portal-cors.server";

function makeRequest(origin: string): Request {
  return new Request("https://app.example.com/api/test", {
    headers: { Origin: origin },
  });
}

describe("getPortalCorsHeaders", () => {
  const originalEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  it("sets Access-Control-Allow-Origin for *.myshopify.com origins", () => {
    const req = makeRequest("https://cool-store.myshopify.com");
    const headers = getPortalCorsHeaders(req);
    expect(headers.get("Access-Control-Allow-Origin")).toBe(
      "https://cool-store.myshopify.com",
    );
  });

  it("sets Access-Control-Allow-Origin for *.shopify.com origins", () => {
    const req = makeRequest("https://admin.shopify.com");
    const headers = getPortalCorsHeaders(req);
    expect(headers.get("Access-Control-Allow-Origin")).toBe(
      "https://admin.shopify.com",
    );
  });

  it("sets Vary: Origin for allowed origins", () => {
    const req = makeRequest("https://test.myshopify.com");
    const headers = getPortalCorsHeaders(req);
    expect(headers.get("Vary")).toBe("Origin");
  });

  it("allows localhost in non-production", () => {
    process.env.NODE_ENV = "development";
    const req = makeRequest("http://localhost:3000");
    const headers = getPortalCorsHeaders(req);
    expect(headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:3000",
    );
  });

  it("allows localhost without port in non-production", () => {
    process.env.NODE_ENV = "development";
    const req = makeRequest("http://localhost");
    const headers = getPortalCorsHeaders(req);
    expect(headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost",
    );
  });

  it("allows 127.0.0.1 in non-production", () => {
    process.env.NODE_ENV = "development";
    const req = makeRequest("http://127.0.0.1:5173");
    const headers = getPortalCorsHeaders(req);
    expect(headers.get("Access-Control-Allow-Origin")).toBe(
      "http://127.0.0.1:5173",
    );
  });

  it("rejects localhost in production", () => {
    process.env.NODE_ENV = "production";
    const req = makeRequest("http://localhost:3000");
    const headers = getPortalCorsHeaders(req);
    expect(headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("does not set Allow-Origin for unknown origins", () => {
    const req = makeRequest("https://evil-site.com");
    const headers = getPortalCorsHeaders(req);
    expect(headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("does not set Allow-Origin when origin is empty", () => {
    const req = new Request("https://app.example.com/api/test");
    const headers = getPortalCorsHeaders(req);
    expect(headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("always sets Allow-Methods header", () => {
    const req = makeRequest("https://evil-site.com");
    const headers = getPortalCorsHeaders(req);
    expect(headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, POST, OPTIONS",
    );
  });

  it("always sets Allow-Headers header", () => {
    const req = makeRequest("https://evil-site.com");
    const headers = getPortalCorsHeaders(req);
    expect(headers.get("Access-Control-Allow-Headers")).toBe(
      "Content-Type, Authorization",
    );
  });

  it("sets Max-Age to 86400", () => {
    const req = makeRequest("https://store.myshopify.com");
    const headers = getPortalCorsHeaders(req);
    expect(headers.get("Access-Control-Max-Age")).toBe("86400");
  });

  it("handles malformed origin URLs gracefully", () => {
    const req = makeRequest("not-a-url");
    const headers = getPortalCorsHeaders(req);
    expect(headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("withCors", () => {
  it("merges CORS headers onto an existing response", () => {
    const req = makeRequest("https://store.myshopify.com");
    const original = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const merged = withCors(original, req);

    expect(merged.status).toBe(200);
    expect(merged.headers.get("Content-Type")).toBe("application/json");
    expect(merged.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://store.myshopify.com",
    );
    expect(merged.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, POST, OPTIONS",
    );
  });

  it("preserves the original response status and statusText", () => {
    const req = makeRequest("https://store.myshopify.com");
    const original = new Response(null, {
      status: 404,
      statusText: "Not Found",
    });
    const merged = withCors(original, req);
    expect(merged.status).toBe(404);
    expect(merged.statusText).toBe("Not Found");
  });

  it("preserves the original response body", async () => {
    const req = makeRequest("https://store.myshopify.com");
    const body = JSON.stringify({ data: "hello" });
    const original = new Response(body, { status: 200 });
    const merged = withCors(original, req);
    const text = await merged.text();
    expect(text).toBe(body);
  });

  it("does not set Allow-Origin for disallowed origins", () => {
    const req = makeRequest("https://bad-actor.com");
    const original = new Response(null, { status: 200 });
    const merged = withCors(original, req);
    expect(merged.headers.get("Access-Control-Allow-Origin")).toBeNull();
    // But other CORS headers are still set
    expect(merged.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, POST, OPTIONS",
    );
  });
});
