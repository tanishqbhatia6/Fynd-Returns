/**
 * Direct unit tests for the pure error-helper functions extracted from
 * api.returns.$id.actions.ts. These are exercised indirectly via the
 * extracted-handlers test, but exporting them as a standalone module
 * deserves first-class coverage so refactors don't silently change
 * truncation, classification, or guidance behaviour.
 */
import { describe, it, expect } from "vitest";
import {
  enrichFyndError,
  classifyFyndError,
  enrichRefundError,
  isRedirectResponse,
  extractErrorMessage,
} from "../return-action-errors.server";

describe("enrichFyndError", () => {
  it("returns empty input unchanged", () => {
    expect(enrichFyndError("")).toBe("");
  });

  it("appends scope guidance on 403 errors", () => {
    const result = enrichFyndError("403 Forbidden: insufficient access");
    expect(result).toContain("Sync uses the same OAuth flow as Test Platform");
    expect(result).toContain("403");
  });

  it("does NOT double-append when guidance is already present", () => {
    const input = "403 Forbidden — see Settings → Integrations for company/orders scope details";
    expect(enrichFyndError(input)).toBe(input);
  });

  it("passes non-403 errors through unchanged", () => {
    const input = "500 Internal Server Error";
    expect(enrichFyndError(input)).toBe(input);
  });

  it("recognises the word 'forbidden' too", () => {
    const result = enrichFyndError("Request was Forbidden");
    expect(result).toContain("OAuth flow as Test Platform");
  });
});

describe("classifyFyndError", () => {
  it("classifies missing-platform errors as config_error", () => {
    expect(classifyFyndError("Fynd is not configured. Configure Platform API.")).toBe(
      "config_error",
    );
    expect(classifyFyndError("Client ID missing")).toBe("config_error");
    expect(classifyFyndError("Company ID required")).toBe("config_error");
  });

  it("classifies network errors", () => {
    expect(classifyFyndError("ECONNREFUSED")).toBe("network_error");
    expect(classifyFyndError("ENOTFOUND fynd-api.example")).toBe("network_error");
    expect(classifyFyndError("socket hang up while talking to Fynd")).toBe("network_error");
    expect(classifyFyndError("DNS resolution failed")).toBe("network_error");
  });

  it("classifies timeouts", () => {
    expect(classifyFyndError("ETIMEDOUT")).toBe("timeout");
    expect(classifyFyndError("Request timed out after 30s")).toBe("timeout");
    expect(classifyFyndError("Aborted after 60s")).toBe("timeout");
  });

  it("falls through to api_error", () => {
    expect(classifyFyndError("400 Bad Request")).toBe("api_error");
    expect(classifyFyndError("Some random Fynd response")).toBe("api_error");
  });
});

describe("enrichRefundError", () => {
  it("appends COD/gift-card hint when 'no transactions' AND method=original", () => {
    const result = enrichRefundError("no transactions to refund", {
      method: "original",
      orderName: "#1001",
    });
    expect(result).toContain("COD or gift-card");
    expect(result).toContain("Store credit");
  });

  it("does NOT append COD hint when method is store_credit", () => {
    const result = enrichRefundError("no transactions to refund", {
      method: "store_credit",
      orderName: "#1001",
    });
    expect(result).not.toContain("COD or gift-card");
  });

  it("appends customer-account hint when store-credit fails for guest", () => {
    const result = enrichRefundError("store_credit customer not found", {
      method: "store_credit",
      orderName: "#1001",
    });
    expect(result).toContain("Shopify account");
    expect(result).toContain("Shopify Admin");
    expect(result).not.toContain("Discount code");
  });

  it("includes order name in already-refunded message", () => {
    const result = enrichRefundError("this order has already been refunded", {
      method: "original",
      orderName: "#1001",
    });
    expect(result).toContain("#1001");
  });

  it("appends location/restock hint", () => {
    const result = enrichRefundError("Invalid restock location", {
      method: "original",
      orderName: null,
    });
    expect(result).toContain("Settings → Return Settings");
  });

  it("appends gift-card hint", () => {
    const result = enrichRefundError("store_credit_amount not allowed for gift card", {
      method: "store_credit",
      orderName: null,
    });
    expect(result).toContain("Shopify Admin");
    expect(result).not.toContain("Discount code");
  });

  it("returns input unchanged when no rule matches", () => {
    const input = "Some unrelated Shopify error";
    expect(enrichRefundError(input, { method: "original", orderName: null })).toBe(input);
  });

  it("returns empty input unchanged", () => {
    expect(enrichRefundError("", { method: "original", orderName: null })).toBe("");
  });
});

describe("isRedirectResponse", () => {
  it("returns true for 3xx Response", () => {
    expect(
      isRedirectResponse(new Response(null, { status: 302, headers: { Location: "/x" } })),
    ).toBe(true);
    expect(
      isRedirectResponse(new Response(null, { status: 301, headers: { Location: "/x" } })),
    ).toBe(true);
    expect(
      isRedirectResponse(new Response(null, { status: 307, headers: { Location: "/x" } })),
    ).toBe(true);
  });

  it("returns false for 2xx Response", () => {
    expect(isRedirectResponse(new Response(null, { status: 200 }))).toBe(false);
  });

  it("returns false for 4xx/5xx Response", () => {
    expect(isRedirectResponse(new Response(null, { status: 404 }))).toBe(false);
    expect(isRedirectResponse(new Response(null, { status: 500 }))).toBe(false);
  });

  it("returns false for non-Response values", () => {
    expect(isRedirectResponse(null)).toBe(false);
    expect(isRedirectResponse(undefined)).toBe(false);
    expect(isRedirectResponse(new Error("nope"))).toBe(false);
    expect(isRedirectResponse({ status: 302 })).toBe(false);
    expect(isRedirectResponse("redirect")).toBe(false);
  });
});

describe("extractErrorMessage", () => {
  it("returns the message for a vanilla Error", async () => {
    const result = await extractErrorMessage(new Error("oops"));
    expect(result).toBe("oops");
  });

  it("rewrites network-error messages to a friendly fallback", async () => {
    const result = await extractErrorMessage(new Error("ECONNREFUSED 127.0.0.1:6379"));
    expect(result).toBe("Unable to connect to external service. Please try again later.");
    const result2 = await extractErrorMessage(new Error("ENOTFOUND fynd-api.example.com"));
    expect(result2).toBe("Unable to connect to external service. Please try again later.");
    const result3 = await extractErrorMessage(new Error("ETIMEDOUT after 30s"));
    expect(result3).toBe("Unable to connect to external service. Please try again later.");
  });

  it("truncates long error messages, ending in ellipsis", async () => {
    const long = "A".repeat(500) + " ENDSENTENCE";
    const result = await extractErrorMessage(new Error(long));
    expect(result.length).toBeLessThanOrEqual(305); // 300 + ellipsis padding
    expect(result.endsWith("…")).toBe(true);
  });

  it("strips trailing whitespace and punctuation before the ellipsis", async () => {
    // Construct a string where the cut point lands right after a comma/space.
    const head = "x".repeat(290);
    const long = `${head}, more text continues here ${"y".repeat(300)}`;
    const result = await extractErrorMessage(new Error(long));
    expect(result.endsWith("…")).toBe(true);
    // Helper strips ` , ; : . -` before the ellipsis — so the char before `…`
    // should never be one of those.
    const beforeEllipsis = result.slice(-2, -1);
    expect(beforeEllipsis).not.toMatch(/[\s,;:.\-]/);
  });

  it("extracts JSON error body from Response-like object", async () => {
    const responseLike = new Response(JSON.stringify({ error: "Shopify rate limited" }), {
      status: 429,
      headers: { "Content-Type": "application/json" },
    });
    const result = await extractErrorMessage(responseLike);
    expect(result).toBe("Shopify rate limited");
  });

  it("falls through to status string when JSON body has no error/message", async () => {
    const responseLike = new Response(JSON.stringify({ foo: "bar" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
    const result = await extractErrorMessage(responseLike);
    expect(result).toMatch(/502/);
  });

  it("handles non-JSON Response gracefully", async () => {
    const responseLike = new Response("not json", { status: 500 });
    const result = await extractErrorMessage(responseLike);
    // Should fall back to status-string template since json parse fails
    expect(result).toContain("500");
  });

  it("returns 'Request failed' for opaque Object/Response toString cases", async () => {
    const result = await extractErrorMessage({});
    expect(result).toContain("Request failed");
  });

  it("stringifies unknown thrown values", async () => {
    const result = await extractErrorMessage("plain string error");
    expect(result).toBe("plain string error");
  });

  it("truncates very long string thrown values", async () => {
    const long = "x".repeat(500);
    const result = await extractErrorMessage(long);
    expect(result.length).toBeLessThanOrEqual(305);
    expect(result.endsWith("…")).toBe(true);
  });
});
