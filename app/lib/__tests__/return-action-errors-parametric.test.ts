/**
 * Deep parametric tests for the pure error-helper functions in
 * return-action-errors.server.ts. These complement the existing
 * `return-action-errors.test.ts` and `return-action-errors-extra.test.ts`
 * suites by exercising classifyFyndError, enrichFyndError, and
 * extractErrorMessage with table-driven `it.each` cases that cover boundary
 * conditions, regex precedence, and unknown-value fallbacks.
 */
import { describe, it, expect } from "vitest";
import {
  enrichFyndError,
  classifyFyndError,
  extractErrorMessage,
} from "../return-action-errors.server";

// ---------------------------------------------------------------------------
// classifyFyndError
// ---------------------------------------------------------------------------
describe("classifyFyndError — parametric", () => {
  type Category = "config_error" | "network_error" | "timeout" | "api_error";

  const cases: Array<{ input: string; expected: Category; note: string }> = [
    // --- config_error ---
    { input: "Fynd is not configured", expected: "config_error", note: "exact 'not configured'" },
    {
      input: "Please configure Platform API credentials",
      expected: "config_error",
      note: "'configure' verb",
    },
    {
      input: "Platform API rejected request",
      expected: "config_error",
      note: "'Platform API' substring",
    },
    {
      input: "Visit Settings → Integrations to fix",
      expected: "config_error",
      note: "'Settings → Integrations'",
    },
    {
      input: "Settings and Integrations missing",
      expected: "config_error",
      note: "'Settings.*Integrations' regex",
    },
    { input: "Client ID is invalid", expected: "config_error", note: "'Client ID' marker" },
    { input: "client id missing", expected: "config_error", note: "case-insensitive Client ID" },
    { input: "Company ID required", expected: "config_error", note: "'Company ID' marker" },
    { input: "COMPANY ID missing", expected: "config_error", note: "uppercase Company ID" },

    // --- network_error ---
    { input: "ECONNREFUSED 127.0.0.1:6379", expected: "network_error", note: "ECONNREFUSED" },
    { input: "ENOTFOUND fynd-api.example.com", expected: "network_error", note: "ENOTFOUND" },
    { input: "EHOSTUNREACH on upstream", expected: "network_error", note: "EHOSTUNREACH" },
    { input: "network unreachable", expected: "network_error", note: "literal 'network'" },
    {
      input: "socket hang up while talking to Fynd",
      expected: "network_error",
      note: "socket hang up",
    },
    { input: "DNS resolution failed", expected: "network_error", note: "DNS literal" },
    { input: "dns lookup error", expected: "network_error", note: "lowercase dns" },

    // --- timeout ---
    { input: "ETIMEDOUT", expected: "timeout", note: "ETIMEDOUT exact" },
    { input: "Request timeout exceeded", expected: "timeout", note: "literal 'timeout'" },
    { input: "Request timed out after 30s", expected: "timeout", note: "'timed out'" },
    { input: "Aborted by client", expected: "timeout", note: "'aborted'" },
    { input: "operation aborted", expected: "timeout", note: "lowercase aborted" },

    // --- api_error fallthrough ---
    { input: "400 Bad Request", expected: "api_error", note: "plain 4xx" },
    { input: "500 Internal Server Error", expected: "api_error", note: "plain 5xx" },
    { input: "Some random Fynd response", expected: "api_error", note: "no markers" },
    { input: "Unauthorized", expected: "api_error", note: "401-ish wording" },
    { input: "validation failed: bag_id required", expected: "api_error", note: "validation msg" },
    { input: "", expected: "api_error", note: "empty string falls through" },

    // --- precedence: config beats network/timeout ---
    {
      input: "Platform API ECONNREFUSED",
      expected: "config_error",
      note: "config_error matched first even when network keyword present",
    },
    {
      input: "Settings → Integrations ETIMEDOUT",
      expected: "config_error",
      note: "config_error wins over timeout",
    },
    {
      input: "Client ID timed out",
      expected: "config_error",
      note: "Client ID wins over timed out",
    },

    // --- precedence: network beats timeout ---
    {
      input: "ECONNREFUSED then timed out",
      expected: "network_error",
      note: "network_error precedes timeout in regex order",
    },
  ];

  it.each(cases)("classifies %# -> $expected ($note)", ({ input, expected }) => {
    expect(classifyFyndError(input)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// enrichFyndError
// ---------------------------------------------------------------------------
describe("enrichFyndError — parametric", () => {
  const guidanceMarker = "Sync uses the same OAuth flow as Test Platform";

  const cases: Array<{
    input: string;
    enriched: boolean;
    note: string;
  }> = [
    // empty / falsy
    { input: "", enriched: false, note: "empty string returns as-is" },

    // 403 codes that should be enriched
    { input: "403 Forbidden: insufficient access", enriched: true, note: "403 + Forbidden combo" },
    { input: "HTTP 403 from Fynd", enriched: true, note: "raw 403" },
    { input: "Request was Forbidden", enriched: true, note: "case-insensitive 'Forbidden'" },
    { input: "forbidden", enriched: true, note: "lowercase forbidden alone" },
    { input: "got status 403 talking to platform", enriched: true, note: "embedded 403" },

    // already has guidance — should NOT be re-enriched
    {
      input: "403 Forbidden — see Settings → Integrations for company/orders scope details",
      enriched: false,
      note: "already mentions Settings & Integrations and company/orders",
    },
    { input: "403 missing scopes for write endpoint", enriched: false, note: "mentions scopes" },
    { input: "403 from Fynd Partners dashboard", enriched: false, note: "mentions Fynd Partners" },
    {
      input: "403 — Test Platform succeeded but write failed",
      enriched: false,
      note: "mentions Test Platform",
    },
    {
      input: "403 — visit Settings → Integrations",
      enriched: false,
      note: "mentions Settings → Integrations",
    },
    {
      input: "403 hitting company/orders endpoint",
      enriched: false,
      note: "mentions company/orders",
    },

    // non-403 — pass through
    { input: "500 Internal Server Error", enriched: false, note: "5xx unchanged" },
    { input: "404 Not Found", enriched: false, note: "404 unchanged" },
    { input: "401 Unauthorized", enriched: false, note: "401 (not 403) unchanged" },
    { input: "ETIMEDOUT after 30s", enriched: false, note: "timeout untouched" },
    { input: "Generic Fynd failure", enriched: false, note: "no triggers" },
    { input: "    ", enriched: false, note: "whitespace-only no triggers" },
    // 4030/14030 etc. — current regex matches '403' anywhere; verify behaviour.
    { input: "4030 some other code", enriched: true, note: "substring '403' still matches" },
  ];

  it.each(cases)("enriches case %# correctly ($note)", ({ input, enriched }) => {
    const out = enrichFyndError(input);
    if (input === "") {
      // Empty short-circuits — return value should be empty exactly.
      expect(out).toBe("");
      return;
    }
    if (enriched) {
      expect(out).toContain(guidanceMarker);
      expect(out.startsWith(input)).toBe(true);
    } else {
      expect(out).toBe(input);
    }
  });
});

// ---------------------------------------------------------------------------
// extractErrorMessage
// ---------------------------------------------------------------------------
describe("extractErrorMessage — parametric", () => {
  const NETWORK_FALLBACK = "Unable to connect to external service. Please try again later.";
  const OPAQUE_FALLBACK = "Request failed. Please check Fynd configuration and try again.";

  type Case = {
    note: string;
    build: () => unknown;
    assert: (out: string) => void;
  };

  const cases: Case[] = [
    {
      note: "vanilla Error returns its message",
      build: () => new Error("plain message"),
      assert: (out) => expect(out).toBe("plain message"),
    },
    {
      note: "Error with empty message returns empty",
      build: () => new Error(""),
      assert: (out) => expect(out).toBe(""),
    },
    {
      note: "Error with ECONNREFUSED rewritten to friendly fallback",
      build: () => new Error("ECONNREFUSED 10.0.0.1:443"),
      assert: (out) => expect(out).toBe(NETWORK_FALLBACK),
    },
    {
      note: "Error with ENOTFOUND rewritten",
      build: () => new Error("ENOTFOUND fynd.example.com"),
      assert: (out) => expect(out).toBe(NETWORK_FALLBACK),
    },
    {
      note: "Error with ETIMEDOUT rewritten",
      build: () => new Error("ETIMEDOUT after 30s"),
      assert: (out) => expect(out).toBe(NETWORK_FALLBACK),
    },
    {
      note: "Error with mixed-case 'econnrefused' is NOT rewritten (case-sensitive)",
      build: () => new Error("econnrefused lowercase"),
      assert: (out) => expect(out).toBe("econnrefused lowercase"),
    },
    {
      note: "Long Error message is truncated and ends with ellipsis",
      build: () => new Error("A".repeat(500) + " END"),
      assert: (out) => {
        expect(out.length).toBeLessThanOrEqual(305);
        expect(out.endsWith("…")).toBe(true);
      },
    },
    {
      note: "Long Error message strips trailing punctuation before ellipsis",
      build: () => {
        const head = "x".repeat(290);
        return new Error(`${head}, more text continues here ${"y".repeat(300)}`);
      },
      assert: (out) => {
        expect(out.endsWith("…")).toBe(true);
        const beforeEllipsis = out.slice(-2, -1);
        expect(beforeEllipsis).not.toMatch(/[\s,;:.\-]/);
      },
    },
    {
      note: "Error message exactly 300 chars is NOT truncated",
      build: () => new Error("a".repeat(300)),
      assert: (out) => {
        expect(out).toBe("a".repeat(300));
        expect(out.endsWith("…")).toBe(false);
      },
    },
    {
      note: "Error message 301 chars is truncated",
      build: () => new Error("a".repeat(301)),
      assert: (out) => {
        expect(out.endsWith("…")).toBe(true);
        expect(out.length).toBeLessThanOrEqual(305);
      },
    },
    {
      note: "Response with JSON {error} body returns the error",
      build: () =>
        new Response(JSON.stringify({ error: "Rate limited by Shopify" }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        }),
      assert: (out) => expect(out).toBe("Rate limited by Shopify"),
    },
    {
      note: "Response with JSON {message} body returns the message",
      build: () =>
        new Response(JSON.stringify({ message: "Validation failed" }), {
          status: 422,
          headers: { "Content-Type": "application/json" },
        }),
      assert: (out) => expect(out).toBe("Validation failed"),
    },
    {
      note: "Response with both error and message — error wins",
      build: () =>
        new Response(JSON.stringify({ error: "ERR_VAL", message: "MSG_VAL" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      assert: (out) => expect(out).toBe("ERR_VAL"),
    },
    {
      note: "Response with empty/whitespace error string falls back to status template",
      build: () =>
        new Response(JSON.stringify({ error: "   " }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        }),
      assert: (out) => {
        expect(out).toContain("502");
        expect(out).toContain("Fynd configuration");
      },
    },
    {
      note: "Response with unrelated JSON shape falls back to status template",
      build: () =>
        new Response(JSON.stringify({ foo: "bar" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      assert: (out) => expect(out).toContain("503"),
    },
    {
      note: "Response with non-JSON body falls back to status template",
      build: () => new Response("not json", { status: 500 }),
      assert: (out) => expect(out).toContain("500"),
    },
    {
      note: "Response with non-string error (number) falls back to status template",
      build: () =>
        new Response(JSON.stringify({ error: 123 }), {
          status: 418,
          headers: { "Content-Type": "application/json" },
        }),
      assert: (out) => expect(out).toContain("418"),
    },
    {
      note: "Response error message also gets truncated when very long",
      build: () =>
        new Response(JSON.stringify({ error: "z".repeat(500) }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      assert: (out) => {
        expect(out.length).toBeLessThanOrEqual(305);
        expect(out.endsWith("…")).toBe(true);
      },
    },
    {
      note: "Plain string thrown is returned as-is",
      build: () => "boom",
      assert: (out) => expect(out).toBe("boom"),
    },
    {
      note: "Long plain string is truncated",
      build: () => "z".repeat(500),
      assert: (out) => {
        expect(out.length).toBeLessThanOrEqual(305);
        expect(out.endsWith("…")).toBe(true);
      },
    },
    {
      note: "null becomes 'null'",
      build: () => null,
      assert: (out) => expect(out).toBe("null"),
    },
    {
      note: "undefined becomes 'undefined'",
      build: () => undefined,
      assert: (out) => expect(out).toBe("undefined"),
    },
    {
      note: "number becomes its string form",
      build: () => 42,
      assert: (out) => expect(out).toBe("42"),
    },
    {
      note: "boolean becomes its string form",
      build: () => false,
      assert: (out) => expect(out).toBe("false"),
    },
    {
      note: "plain object without ok/json falls into the opaque fallback",
      build: () => ({ random: "data" }),
      assert: (out) => expect(out).toBe(OPAQUE_FALLBACK),
    },
    {
      note: "object with ok but no json fn — String() yields '[object Object]' fallback",
      build: () => ({ ok: false }),
      assert: (out) => expect(out).toBe(OPAQUE_FALLBACK),
    },
    {
      note: "object with ok=true and json() returning {error} is treated as Response-like",
      build: () => ({ ok: true, status: 200, json: async () => ({ error: "duck-typed" }) }),
      assert: (out) => expect(out).toBe("duck-typed"),
    },
    {
      note: "object whose json() throws falls back to status template",
      build: () => ({
        ok: false,
        status: 504,
        json: async () => {
          throw new Error("boom");
        },
      }),
      assert: (out) => expect(out).toContain("504"),
    },
    {
      note: "Symbol thrown stringifies via String()",
      build: () => Symbol("tag"),
      assert: (out) => expect(out).toBe("Symbol(tag)"),
    },
    {
      note: "Subclass of Error preserves message",
      build: () => {
        class MyErr extends Error {}
        return new MyErr("subclassed message");
      },
      assert: (out) => expect(out).toBe("subclassed message"),
    },
    {
      note: "Error containing both ECONNREFUSED and other text still rewritten",
      build: () => new Error("Failed: ECONNREFUSED while connecting to Fynd"),
      assert: (out) => expect(out).toBe(NETWORK_FALLBACK),
    },
    {
      note: "Response with 404 status and no error body returns 404 template",
      build: () => new Response(null, { status: 404 }),
      assert: (out) => expect(out).toContain("404"),
    },
  ];

  it.each(cases)("case %# — $note", async ({ build, assert }) => {
    const result = await extractErrorMessage(build());
    assert(result);
  });
});
