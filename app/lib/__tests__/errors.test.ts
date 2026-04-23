import { describe, it, expect } from "vitest";
import {
  FyndApiError,
  ShopifyApiError,
  WebhookDeliveryError,
  RateLimitError,
  AuthenticationError,
  ValidationError,
  ExternalTimeoutError,
  ConfigurationError,
  InvariantViolation,
  isOperationalError,
  toAppError,
} from "../observability/errors.server";

/* The error classification hierarchy is pure logic — no IO — so we can
   exhaustively lock down fingerprint computation, span attribute shape,
   and the isOperational / toAppError classifiers. */

describe("FyndApiError", () => {
  it("is operational with service=fynd", () => {
    const e = new FyndApiError("boom", 500, "/returns", "RET_500");
    expect(e.isOperational).toBe(true);
    expect(e.service).toBe("fynd");
    expect(e.name).toBe("FyndApiError");
    expect(e.statusCode).toBe(500);
    expect(e.endpoint).toBe("/returns");
    expect(e.fyndErrorCode).toBe("RET_500");
  });
  it("fingerprint depends on statusCode + endpoint pattern (ID-stripped)", () => {
    const a = new FyndApiError("x", 500, "/returns/cmxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    const b = new FyndApiError("x", 500, "/returns/cmyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy");
    expect(a.fingerprint).toBe(b.fingerprint);
  });
  it("fingerprint differs when status or endpoint differ", () => {
    const a = new FyndApiError("x", 500, "/returns");
    const b = new FyndApiError("x", 400, "/returns");
    const c = new FyndApiError("x", 500, "/refunds");
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
  });
  it("exposes fynd-specific span attributes", () => {
    const attrs = new FyndApiError("m", 503, "/x", "CODE").toSpanAttributes();
    expect(attrs["fynd.status_code"]).toBe(503);
    expect(attrs["fynd.endpoint"]).toBe("/x");
    expect(attrs["fynd.error_code"]).toBe("CODE");
    expect(attrs["error.operational"]).toBe(true);
  });
  it("omits fynd.error_code when not provided", () => {
    const attrs = new FyndApiError("m", 503, "/x").toSpanAttributes();
    expect("fynd.error_code" in attrs).toBe(false);
  });
});

describe("ShopifyApiError", () => {
  it("is operational with service=shopify", () => {
    const e = new ShopifyApiError("b", 500, "mutation orderUpdate { ... }");
    expect(e.isOperational).toBe(true);
    expect(e.service).toBe("shopify");
  });
  it("fingerprint extracts mutation/query name from GraphQL", () => {
    const a = new ShopifyApiError("x", 400, "mutation orderUpdate($id: ID!) { ... }");
    const b = new ShopifyApiError("x", 400, "mutation orderUpdate($x: ID!) { ... }");
    expect(a.fingerprint).toBe(b.fingerprint);
  });
  it("fingerprint handles missing/unnamed GraphQL (falls back to 'unknown')", () => {
    const e = new ShopifyApiError("x", 400, "just text, no graphql");
    expect(e.fingerprint).toMatch(/^[a-f0-9]{16}$/);
  });
  it("truncates query to 200 chars in span attrs", () => {
    const q = "query Big { " + "x".repeat(1000) + " }";
    const attrs = new ShopifyApiError("m", 500, q).toSpanAttributes();
    expect(String(attrs["shopify.query"]).length).toBe(200);
  });
});

describe("WebhookDeliveryError", () => {
  it("fingerprint derives from URL host + last status code", () => {
    const a = new WebhookDeliveryError("x", "https://hook.example.com/a", 3, 502);
    const b = new WebhookDeliveryError("x", "https://hook.example.com/b", 1, 502);
    expect(a.fingerprint).toBe(b.fingerprint);
  });
  it("uses 'timeout' sentinel when lastStatusCode absent", () => {
    const a = new WebhookDeliveryError("x", "https://h.example/y", 3);
    const b = new WebhookDeliveryError("x", "https://h.example/z", 3);
    expect(a.fingerprint).toBe(b.fingerprint);
  });
  it("handles malformed URLs gracefully", () => {
    const e = new WebhookDeliveryError("x", "not a url", 1, 502);
    expect(e.fingerprint).toMatch(/^[a-f0-9]{16}$/);
  });
  it("includes webhook attrs in span", () => {
    const attrs = new WebhookDeliveryError("b", "https://h/", 5, 503).toSpanAttributes();
    expect(attrs["webhook.url"]).toBe("https://h/");
    expect(attrs["webhook.attempts"]).toBe(5);
    expect(attrs["webhook.last_status_code"]).toBe(503);
  });
  it("omits webhook.last_status_code when not provided", () => {
    const attrs = new WebhookDeliveryError("b", "https://h/", 5).toSpanAttributes();
    expect("webhook.last_status_code" in attrs).toBe(false);
  });
});

describe("RateLimitError", () => {
  it("is operational", () => {
    const e = new RateLimitError("slow", "api.returns.reject", 5000);
    expect(e.isOperational).toBe(true);
    expect(e.retryAfterMs).toBe(5000);
  });
  it("fingerprint = endpoint", () => {
    const a = new RateLimitError("a", "api.x", 1000);
    const b = new RateLimitError("b", "api.x", 9000);
    expect(a.fingerprint).toBe(b.fingerprint);
  });
});

describe("AuthenticationError", () => {
  it("is operational with auth-specific span attrs", () => {
    const e = new AuthenticationError("bad", "api_key", "missing_header");
    expect(e.isOperational).toBe(true);
    const a = e.toSpanAttributes();
    expect(a["auth.type"]).toBe("api_key");
    expect(a["auth.failure_reason"]).toBe("missing_header");
  });
});

describe("ValidationError", () => {
  it("fingerprint = field:constraint", () => {
    const a = new ValidationError("x", "email", "format");
    const b = new ValidationError("y", "email", "format");
    expect(a.fingerprint).toBe(b.fingerprint);
  });
});

describe("ExternalTimeoutError", () => {
  it("carries service + timeoutMs + endpoint", () => {
    const e = new ExternalTimeoutError("t", "fynd", 5000, "/api/x");
    expect(e.service).toBe("fynd");
    expect(e.timeoutMs).toBe(5000);
    const attrs = e.toSpanAttributes();
    expect(attrs["timeout.ms"]).toBe(5000);
    expect(attrs["timeout.endpoint"]).toBe("/api/x");
  });
});

describe("ConfigurationError (programmer error)", () => {
  it("is not operational", () => {
    expect(new ConfigurationError("x", "ENCRYPTION_KEY").isOperational).toBe(false);
  });
});

describe("InvariantViolation (programmer error)", () => {
  it("is not operational", () => {
    expect(new InvariantViolation("x", "approvedCount<=totalReturns").isOperational).toBe(false);
  });
});

describe("isOperationalError", () => {
  it("true for operational AppErrors", () => {
    expect(isOperationalError(new FyndApiError("x", 500, "/y"))).toBe(true);
  });
  it("false for programmer AppErrors", () => {
    expect(isOperationalError(new ConfigurationError("x", "KEY"))).toBe(false);
  });
  it("false for plain Error", () => {
    expect(isOperationalError(new Error("x"))).toBe(false);
  });
  it("false for non-Error values", () => {
    expect(isOperationalError("string")).toBe(false);
    expect(isOperationalError(null)).toBe(false);
    expect(isOperationalError(undefined)).toBe(false);
  });
});

describe("toAppError", () => {
  it("returns the error as-is if it's an AppError", () => {
    const e = new FyndApiError("x", 500, "/y");
    expect(toAppError(e)).toBe(e);
  });
  it("returns null for non-AppError", () => {
    expect(toAppError(new Error("x"))).toBe(null);
    expect(toAppError("oops")).toBe(null);
  });
});

describe("AppError.toLogContext", () => {
  it("returns a structured log object", () => {
    const e = new FyndApiError("msg", 500, "/x");
    const ctx = e.toLogContext();
    expect(ctx).toMatchObject({
      errorClass: "FyndApiError",
      isOperational: true,
      service: "fynd",
      message: "msg",
    });
    expect(ctx.fingerprint).toMatch(/^[a-f0-9]{16}$/);
    expect(typeof ctx.stack).toBe("string");
  });
});
