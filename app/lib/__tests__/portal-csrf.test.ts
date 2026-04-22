/**
 * Portal CSRF token tests — verifies the shop-bound JWT issued by /api/portal/order
 * and required by state-changing portal endpoints. Defends against the cross-shop
 * forgery hole the *.myshopify.com CORS regex used to allow.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createPortalCsrfToken, verifyPortalCsrfToken } from "../portal-auth.server";

beforeAll(() => {
  process.env.PORTAL_JWT_SECRET = "x".repeat(64);
});

describe("portal CSRF token", () => {
  it("verifies a freshly-issued token bound to the same shop", () => {
    const token = createPortalCsrfToken("acme.myshopify.com");
    expect(verifyPortalCsrfToken(token, "acme.myshopify.com")).toBe(true);
  });

  it("rejects when the shop claim does not match", () => {
    const token = createPortalCsrfToken("acme.myshopify.com");
    expect(verifyPortalCsrfToken(token, "evil.myshopify.com")).toBe(false);
  });

  it("rejects null / empty token", () => {
    expect(verifyPortalCsrfToken(null, "acme.myshopify.com")).toBe(false);
    expect(verifyPortalCsrfToken(undefined, "acme.myshopify.com")).toBe(false);
    expect(verifyPortalCsrfToken("", "acme.myshopify.com")).toBe(false);
  });

  it("rejects garbage / malformed token", () => {
    expect(verifyPortalCsrfToken("not-a-jwt", "acme.myshopify.com")).toBe(false);
    expect(verifyPortalCsrfToken("aaa.bbb.ccc", "acme.myshopify.com")).toBe(false);
  });

  it("rejects a non-CSRF token (e.g. an OTP portalToken)", () => {
    // A portalToken issued via createPortalToken would be a valid JWT but its
    // payload doesn't carry the csrf:true flag, so verifyPortalCsrfToken must
    // refuse to accept it as a CSRF token.
    const jwt = require("jsonwebtoken") as typeof import("jsonwebtoken");
    const otherToken = jwt.sign(
      { sessionId: "x", shopId: "y" }, // no csrf flag
      process.env.PORTAL_JWT_SECRET!,
      { expiresIn: "1h" },
    );
    expect(verifyPortalCsrfToken(otherToken, "acme.myshopify.com")).toBe(false);
  });
});
