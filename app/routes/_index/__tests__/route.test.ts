/**
 * Tests for the marketing landing page route (`/`).
 *
 * The page is mostly static JSX (heroes, feature cards, footer, theme
 * toggle). The only server-side behavior is the `loader`, which:
 *   1. Redirects Shopify/Admin launches to `/app?...` when a `shop`
 *      query param or trusted Admin referrer is present.
 *   2. Otherwise returns `{ showForm: Boolean(login) }`.
 *
 * Tests focus on the loader (redirect behavior + return shape) plus a
 * smoke test that the module loads and exposes the expected exports.
 */

import { describe, it, expect, vi } from "vitest";

// Mock shopify.server so importing the route doesn't try to bootstrap
// the real Shopify app (which needs API keys, env, etc.).
vi.mock("../../../shopify.server", () => ({
  login: vi.fn(),
  authenticate: { admin: vi.fn() },
}));

import { loader } from "../route";
import * as routeModule from "../route";

describe("_index route loader", () => {
  it("redirects to /app preserving the shop param when shop is present", async () => {
    const request = new Request("https://example.com/?shop=mystore.myshopify.com");

    let thrown: unknown;
    try {
      await loader({ request, params: {}, context: {} } as never);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Response);
    const res = thrown as Response;
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    const location = res.headers.get("Location") ?? "";
    expect(location.startsWith("/app?")).toBe(true);
    expect(location).toContain("shop=mystore.myshopify.com");
    expect(location).toContain("host=YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvbXlzdG9yZQ");
    expect(location).toContain("embedded=1");
  });

  it("preserves additional query params on redirect", async () => {
    const request = new Request(
      "https://example.com/?shop=mystore.myshopify.com&host=abc123&embedded=1",
    );

    let thrown: unknown;
    try {
      await loader({ request, params: {}, context: {} } as never);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Response);
    const location = (thrown as Response).headers.get("Location") ?? "";
    expect(location).toContain("shop=mystore.myshopify.com");
    expect(location).toContain("host=abc123");
    expect(location).toContain("embedded=1");
  });

  it("redirects Shopify Admin launches without shop query into the embedded app", async () => {
    const request = new Request("https://example.com/", {
      headers: {
        referer: "https://admin.shopify.com/store/fynd-store-1/apps/fynd-returns",
      },
    });

    let thrown: unknown;
    try {
      await loader({ request, params: {}, context: {} } as never);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Response);
    const location = (thrown as Response).headers.get("Location") ?? "";
    expect(location.startsWith("/app?")).toBe(true);
    expect(location).toContain("shop=fynd-store-1.myshopify.com");
    expect(location).toContain("host=YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvZnluZC1zdG9yZS0x");
    expect(location).toContain("embedded=1");
  });

  it("redirects legacy myshopify admin referrers into the embedded app", async () => {
    const request = new Request("https://example.com/", {
      headers: {
        referer: "https://fynd-store-1.myshopify.com/admin/apps/fynd-returns",
      },
    });

    let thrown: unknown;
    try {
      await loader({ request, params: {}, context: {} } as never);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Response);
    const location = (thrown as Response).headers.get("Location") ?? "";
    expect(location).toContain("shop=fynd-store-1.myshopify.com");
    expect(location).toContain("embedded=1");
  });

  it("redirects Shopify token-only embedded launches into the app shell", async () => {
    const request = new Request(
      "https://example.com/?embedded=1&host=abc123&id_token=token-from-shopify",
    );

    let thrown: unknown;
    try {
      await loader({ request, params: {}, context: {} } as never);
    } catch (e) {
      thrown = e;
    }

    expect(thrown).toBeInstanceOf(Response);
    const location = (thrown as Response).headers.get("Location") ?? "";
    expect(location.startsWith("/app?")).toBe(true);
    expect(location).toContain("embedded=1");
    expect(location).toContain("host=abc123");
    expect(location).toContain("id_token=token-from-shopify");
  });

  it("returns showForm:true when no shop param is present (login is mocked truthy)", async () => {
    const request = new Request("https://example.com/");

    const result = await loader({ request, params: {}, context: {} } as never);

    expect(result).toEqual({ showForm: true });
  });

  it("does not redirect when shop param is missing even if other params exist", async () => {
    const request = new Request("https://example.com/?utm_source=google&ref=blog");

    const result = await loader({ request, params: {}, context: {} } as never);

    expect(result).toHaveProperty("showForm");
    // Result must be a plain object, not a thrown Response
    expect(result).not.toBeInstanceOf(Response);
  });

  it("does not trust non-Shopify referrers for admin launch inference", async () => {
    const request = new Request("https://example.com/", {
      headers: {
        referer: "https://evil.example/store/fynd-store-1/apps/fynd-returns",
      },
    });

    const result = await loader({ request, params: {}, context: {} } as never);

    expect(result).toEqual({ showForm: true });
  });

  it("treats an empty shop param as missing (does not redirect)", async () => {
    // `searchParams.get("shop")` returns "" for `?shop=`, which is falsy,
    // so the loader should NOT redirect.
    const request = new Request("https://example.com/?shop=");

    const result = await loader({ request, params: {}, context: {} } as never);

    expect(result).toEqual({ showForm: true });
  });

  it("redirect status is a standard HTTP redirect code", async () => {
    const request = new Request("https://example.com/?shop=foo.myshopify.com");

    let thrown: unknown;
    try {
      await loader({ request, params: {}, context: {} } as never);
    } catch (e) {
      thrown = e;
    }

    const res = thrown as Response;
    // react-router's `redirect()` defaults to 302
    expect([301, 302, 303, 307, 308]).toContain(res.status);
  });
});

describe("_index route module", () => {
  it("exports a loader function", () => {
    expect(typeof routeModule.loader).toBe("function");
  });

  it("exports a default React component", () => {
    expect(routeModule.default).toBeDefined();
    expect(typeof routeModule.default).toBe("function");
  });

  it("default export accepts no required arguments (callable as component)", () => {
    // React Router wraps the component (e.g. WithComponentProps), so we
    // just verify it is a zero-arity-callable function (length === 0 for
    // the wrapper) — i.e. it can be rendered without props.
    expect(typeof routeModule.default).toBe("function");
    expect(routeModule.default.length).toBeLessThanOrEqual(1);
  });
});
