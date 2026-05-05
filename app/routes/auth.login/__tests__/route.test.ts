/**
 * Tests for /auth/login — Shopify policy-compliant info page.
 *
 * Per App Store policy, this route does NOT render an install form (no
 * .myshopify.com input). Two behaviours under test:
 *
 *   1. If `?shop=<store>.myshopify.com` is present, redirect to /auth.
 *   2. Otherwise, return an empty loader payload (page renders info text).
 */
import { describe, it, expect } from "vitest";
import { loader } from "../route";

function mkLoaderArgs(url: string) {
  return {
    request: new Request(url),
    params: {},
    context: {},
  } as unknown as Parameters<typeof loader>[0];
}

describe("auth.login loader — ?shop redirect", () => {
  it("redirects to /auth when a valid shop param is present", async () => {
    let thrown: unknown;
    try {
      await loader(mkLoaderArgs("https://app.example/auth/login?shop=acme.myshopify.com"));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    const res = thrown as Response;
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("location")).toBe("/auth?shop=acme.myshopify.com");
  });

  it("URL-encodes the shop parameter when forwarding", async () => {
    // Hyphenated subdomain — still matches the regex, must be encoded safely.
    let thrown: unknown;
    try {
      await loader(
        mkLoaderArgs("https://app.example/auth/login?shop=my-cool-store.myshopify.com"),
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    const location = (thrown as Response).headers.get("location");
    expect(location).toBe("/auth?shop=my-cool-store.myshopify.com");
  });

  it("accepts uppercase subdomains (case-insensitive regex)", async () => {
    let thrown: unknown;
    try {
      await loader(mkLoaderArgs("https://app.example/auth/login?shop=ACME.myshopify.com"));
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).headers.get("location")).toBe(
      "/auth?shop=ACME.myshopify.com",
    );
  });
});

describe("auth.login loader — no redirect cases", () => {
  it("returns an empty object when no shop param is provided", async () => {
    const result = await loader(mkLoaderArgs("https://app.example/auth/login"));
    expect(result).toEqual({});
  });

  it("does NOT redirect when the shop value is malformed (no .myshopify.com)", async () => {
    // Critical: prevents open-redirect via attacker-supplied ?shop=evil.com.
    const result = await loader(
      mkLoaderArgs("https://app.example/auth/login?shop=evil.com"),
    );
    expect(result).toEqual({});
  });

  it("does NOT redirect when shop has a path traversal / extra segments", async () => {
    const result = await loader(
      mkLoaderArgs("https://app.example/auth/login?shop=acme.myshopify.com/evil"),
    );
    expect(result).toEqual({});
  });

  it("does NOT redirect when shop starts with a hyphen (invalid subdomain)", async () => {
    const result = await loader(
      mkLoaderArgs("https://app.example/auth/login?shop=-bad.myshopify.com"),
    );
    expect(result).toEqual({});
  });

  it("does NOT redirect when shop param is empty", async () => {
    const result = await loader(mkLoaderArgs("https://app.example/auth/login?shop="));
    expect(result).toEqual({});
  });
});
