/**
 * Additional edge-case tests for return-action-errors.server.ts.
 *
 * Complements return-action-errors.test.ts by covering the regex
 * alternatives in classifyFyndError + enrichRefundError that the
 * primary suite does not assert directly, plus multiline / no-space
 * truncation behaviour from extractErrorMessage.
 */
import { describe, it, expect } from "vitest";
import {
  classifyFyndError,
  enrichRefundError,
  extractErrorMessage,
} from "../return-action-errors.server";

describe("classifyFyndError — uncovered alternatives", () => {
  it("classifies bare 'configure' verb as config_error", () => {
    expect(classifyFyndError("Please configure your store first")).toBe("config_error");
  });

  it("classifies 'Platform API' phrasing as config_error", () => {
    expect(classifyFyndError("Platform API credentials missing")).toBe("config_error");
  });

  it("classifies 'Settings → Integrations' phrasing as config_error", () => {
    // Regex requires "Settings" then any chars then "Integrations" on one line.
    expect(classifyFyndError("Visit Settings → Integrations to fix this")).toBe("config_error");
  });

  it("classifies EHOSTUNREACH as network_error", () => {
    expect(classifyFyndError("EHOSTUNREACH 10.0.0.1")).toBe("network_error");
  });

  it("classifies bare 'network' word as network_error", () => {
    expect(classifyFyndError("transient network blip — retrying")).toBe("network_error");
  });

  it("classifies lowercase 'timeout' as timeout", () => {
    expect(classifyFyndError("connection timeout while waiting")).toBe("timeout");
  });

  it("prefers config_error over network_error when both phrases present", () => {
    // Order in the function: config_error tested first, so it wins.
    expect(classifyFyndError("network error — please configure platform")).toBe("config_error");
  });

  it("prefers network_error over timeout when both phrases present", () => {
    // Order: network_error checked before timeout.
    expect(classifyFyndError("ECONNREFUSED — request timed out")).toBe("network_error");
  });
});

describe("enrichRefundError — uncovered alternatives", () => {
  it("matches 'transactions cannot be empty' alternative for original method", () => {
    const result = enrichRefundError("transactions cannot be empty", {
      method: "original",
      orderName: "#42",
    });
    expect(result).toContain("COD or gift-card");
    expect(result).toContain("Store credit");
  });

  it("does not append COD hint when method is null even if message matches", () => {
    const result = enrichRefundError("no transactions to refund", {
      method: null,
      orderName: "#42",
    });
    expect(result).not.toContain("COD or gift-card");
  });

  it("matches store_credit no-customer alternative", () => {
    const result = enrichRefundError("store credit has no customer attached", {
      method: "store_credit",
      orderName: "#1001",
    });
    expect(result).toContain("Shopify account");
    expect(result).toContain("Shopify Admin");
    expect(result).not.toContain("Discount code");
  });

  it("matches 'customer ... not found' alternative regardless of method", () => {
    const result = enrichRefundError("customer was not found in Shopify", {
      method: "original",
      orderName: "#9",
    });
    expect(result).toContain("Shopify account");
  });

  it("matches 'already refunded' without 'been' word", () => {
    const result = enrichRefundError("Order is already refunded", {
      method: "original",
      orderName: "#777",
    });
    expect(result).toContain("Check Shopify Admin");
    expect(result).toContain("#777");
  });

  it("renders empty string for orderName when null in already-refunded path", () => {
    const result = enrichRefundError("already been refunded", {
      method: "original",
      orderName: null,
    });
    expect(result).toContain("Check Shopify Admin for order ");
    // "for order " followed by trailing punctuation only — no order id.
    expect(result).not.toMatch(/for order #/);
  });

  it("matches bare 'restock' word (no 'location')", () => {
    const result = enrichRefundError("Cannot restock items at this time", {
      method: "original",
      orderName: null,
    });
    expect(result).toContain("Settings → Return Settings");
  });

  it("matches 'gift card' (with space) alternative for gift-card hint", () => {
    // Note: 'gift card' regex matches before 'store_credit' fallback because
    // location/restock check comes first; here we ensure the gift-card
    // branch is reachable for messages with no 'location' / 'restock' / 'customer'.
    const result = enrichRefundError("gift card refund not supported", {
      method: "original",
      orderName: null,
    });
    expect(result).toContain("Shopify Admin");
    expect(result).not.toContain("Discount code");
    expect(result).toContain("gift card");
  });

  it("returns first match when multiple rules could apply (order matters)", () => {
    // Message contains both 'no transactions' (original-method rule) and 'gift card'.
    // With method=original, the first rule wins and the gift-card hint is not appended.
    const result = enrichRefundError("no transactions for gift card order", {
      method: "original",
      orderName: "#5",
    });
    expect(result).toContain("COD or gift-card");
    // The store-credit/discount-code suffix from the gift-card branch should NOT appear
    // because the first match short-circuits.
    expect(result).not.toContain('Use "Discount code" refund method for gift card');
  });
});

describe("extractErrorMessage — multiline + truncation edges", () => {
  it("truncates a single-line long message with no spaces using hard cut", async () => {
    // No spaces => lastIndexOf returns -1, so cut === limit (300).
    const noSpace = "z".repeat(500);
    const result = await extractErrorMessage(new Error(noSpace));
    expect(result.endsWith("…")).toBe(true);
    // Should be exactly 300 'z' + ellipsis since no boundary trim applies.
    expect(result.length).toBe(301);
    expect(result.startsWith("z".repeat(300))).toBe(true);
  });

  it("preserves embedded newlines in a multiline message under the limit", async () => {
    const multi = "line one\nline two\nline three";
    const result = await extractErrorMessage(new Error(multi));
    expect(result).toBe(multi);
    expect(result).toContain("\n");
  });

  it("truncates a multiline error message that exceeds the limit", async () => {
    // Build a message > 300 chars across multiple lines. Newline counts as
    // whitespace for the boundary regex but NOT for the lastIndexOf(' ') call.
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i} contents`).join("\n");
    expect(lines.length).toBeGreaterThan(300);
    const result = await extractErrorMessage(new Error(lines));
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBeLessThanOrEqual(305);
  });

  it("does not truncate a message exactly at the 300-char limit", async () => {
    const exact = "a".repeat(300);
    const result = await extractErrorMessage(new Error(exact));
    expect(result).toBe(exact);
    expect(result.endsWith("…")).toBe(false);
  });

  it("strips a trailing newline from the cut window before adding ellipsis", async () => {
    // Place a newline near the end of the limit so it lands in the trailing
    // whitespace-stripping regex.
    const head = "w".repeat(295);
    const tail = "\n" + "v".repeat(50);
    const long = head + tail;
    const result = await extractErrorMessage(new Error(long));
    expect(result.endsWith("…")).toBe(true);
    // Whatever sits immediately before the ellipsis must not be whitespace.
    const beforeEllipsis = result.slice(-2, -1);
    expect(beforeEllipsis).not.toMatch(/\s/);
  });
});
