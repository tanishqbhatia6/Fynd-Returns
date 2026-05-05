/**
 * Tests for portal-cors.server.ts: portal API CORS allow-list. The portal runs
 * on the store domain (*.myshopify.com / *.shopify.com) and fetches from the
 * app domain, so the headers must echo back only trusted origins. Wildcard or
 * arbitrary origins must be rejected; preflights and missing-origin requests
 * must still get the standard method/header advertisement.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getPortalCorsHeaders, withCors } from "../portal-cors.server";

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

function makeRequest(headers: Record<string, string> = {}, method = "GET"): Request {
  return new Request("https://app.example.com/api/portal", { method, headers });
}

describe("getPortalCorsHeaders — allowed origins", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
  });
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it("echoes a *.myshopify.com origin", () => {
    const headers = getPortalCorsHeaders(makeRequest({ Origin: "https://my-store.myshopify.com" }));
    expect(headers.get("Access-Control-Allow-Origin")).toBe("https://my-store.myshopify.com");
    expect(headers.get("Vary")).toBe("Origin");
  });

  it("echoes a *.shopify.com origin", () => {
    const headers = getPortalCorsHeaders(makeRequest({ Origin: "https://admin.shopify.com" }));
    expect(headers.get("Access-Control-Allow-Origin")).toBe("https://admin.shopify.com");
    expect(headers.get("Vary")).toBe("Origin");
  });

  it("always advertises methods, allowed headers, and max-age", () => {
    const headers = getPortalCorsHeaders(makeRequest({ Origin: "https://store.myshopify.com" }));
    expect(headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, OPTIONS");
    expect(headers.get("Access-Control-Allow-Headers")).toBe("Content-Type, Authorization");
    expect(headers.get("Access-Control-Max-Age")).toBe("86400");
  });
});

describe("getPortalCorsHeaders — rejected origins", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
  });
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it("never echoes a wildcard '*' origin", () => {
    const headers = getPortalCorsHeaders(makeRequest({ Origin: "*" }));
    expect(headers.get("Access-Control-Allow-Origin")).toBeNull();
    // Methods/headers/max-age still advertised for preflight semantics.
    expect(headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, OPTIONS");
  });

  it("rejects an arbitrary attacker origin", () => {
    const headers = getPortalCorsHeaders(makeRequest({ Origin: "https://evil.example.com" }));
    expect(headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(headers.get("Vary")).toBeNull();
  });

  it("rejects spoofed substring origins (myshopify.com.evil.com)", () => {
    const headers = getPortalCorsHeaders(makeRequest({ Origin: "https://myshopify.com.evil.com" }));
    expect(headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("rejects bare 'myshopify.com' (no leading subdomain)", () => {
    // The pattern requires a dot prefix (\.myshopify\.com$), so the apex
    // domain alone is not allowed.
    const headers = getPortalCorsHeaders(makeRequest({ Origin: "https://myshopify.com" }));
    expect(headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("rejects malformed origin strings", () => {
    const headers = getPortalCorsHeaders(makeRequest({ Origin: "not-a-url" }));
    expect(headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("rejects localhost in production", () => {
    const headers = getPortalCorsHeaders(makeRequest({ Origin: "http://localhost:3000" }));
    expect(headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("getPortalCorsHeaders — missing origin", () => {
  it("does not set Allow-Origin/Vary when Origin header is absent", () => {
    const headers = getPortalCorsHeaders(makeRequest({}));
    expect(headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(headers.get("Vary")).toBeNull();
    // Methods/headers/max-age are still set.
    expect(headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, OPTIONS");
    expect(headers.get("Access-Control-Allow-Headers")).toBe("Content-Type, Authorization");
  });

  it("does not echo an empty-string Origin", () => {
    const headers = getPortalCorsHeaders(makeRequest({ Origin: "" }));
    expect(headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("getPortalCorsHeaders — dev origins", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "development";
  });
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it("allows http://localhost:PORT in non-production", () => {
    const headers = getPortalCorsHeaders(makeRequest({ Origin: "http://localhost:3000" }));
    expect(headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
    expect(headers.get("Vary")).toBe("Origin");
  });

  it("allows http://127.0.0.1 in non-production", () => {
    const headers = getPortalCorsHeaders(makeRequest({ Origin: "http://127.0.0.1:8080" }));
    expect(headers.get("Access-Control-Allow-Origin")).toBe("http://127.0.0.1:8080");
  });
});

describe("getPortalCorsHeaders — OPTIONS preflight", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
  });
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it("returns the same headers for an OPTIONS preflight as for GET", () => {
    const headers = getPortalCorsHeaders(
      makeRequest({ Origin: "https://store.myshopify.com" }, "OPTIONS"),
    );
    expect(headers.get("Access-Control-Allow-Origin")).toBe("https://store.myshopify.com");
    expect(headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, OPTIONS");
    expect(headers.get("Access-Control-Allow-Headers")).toBe("Content-Type, Authorization");
    expect(headers.get("Access-Control-Max-Age")).toBe("86400");
  });

  it("rejects an OPTIONS preflight with a disallowed origin", () => {
    const headers = getPortalCorsHeaders(
      makeRequest({ Origin: "https://evil.example.com" }, "OPTIONS"),
    );
    expect(headers.get("Access-Control-Allow-Origin")).toBeNull();
    // But still advertises the contract for browsers that need it.
    expect(headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, OPTIONS");
  });
});

describe("withCors", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "production";
  });
  afterEach(() => {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  });

  it("preserves status, statusText, and body of the wrapped response", async () => {
    const original = new Response("hello", { status: 201, statusText: "Created" });
    const wrapped = withCors(original, makeRequest({ Origin: "https://s.myshopify.com" }));
    expect(wrapped.status).toBe(201);
    expect(wrapped.statusText).toBe("Created");
    expect(await wrapped.text()).toBe("hello");
  });

  it("merges CORS headers onto the response for an allowed origin", () => {
    const original = new Response("{}", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    const wrapped = withCors(original, makeRequest({ Origin: "https://s.myshopify.com" }));
    expect(wrapped.headers.get("Content-Type")).toBe("application/json");
    expect(wrapped.headers.get("Access-Control-Allow-Origin")).toBe("https://s.myshopify.com");
    expect(wrapped.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, OPTIONS");
    expect(wrapped.headers.get("Vary")).toBe("Origin");
  });

  it("does not set Allow-Origin for a disallowed origin but still advertises methods", () => {
    const original = new Response(null, { status: 204 });
    const wrapped = withCors(original, makeRequest({ Origin: "https://evil.example.com" }));
    expect(wrapped.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(wrapped.headers.get("Access-Control-Allow-Methods")).toBe("GET, POST, OPTIONS");
  });
});
