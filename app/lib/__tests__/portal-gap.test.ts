/**
 * Gap-filling coverage tests for app/lib/portal-config.server.ts,
 * portal-cors.server.ts, portal-theme.server.ts, portal-auth.server.ts.
 *
 * Existing suites (portal-config.test.ts, portal-cors.test.ts,
 * portal-theme.test.ts, portal-theme-parametric.test.ts, portal-auth.test.ts,
 * portal-auth-deep.test.ts, portal-csrf.test.ts) already exercise the bulk of
 * each module. The only branches not yet exercised are the module-init
 * branches in portal-auth.server.ts (lines 7-11) — the secret-resolution IIFE
 * that picks between (a) the env-supplied secret, (b) the dev fallback with a
 * console.warn, and (c) the production "throw if unset" guard. Those branches
 * resolve at module-eval time, so we can only reach them by re-importing the
 * module under different env conditions via vi.resetModules + vi.isolateModulesAsync.
 *
 * We additionally lock down a couple of corner cases for the other three
 * modules to keep statement coverage at >=99% even if upstream callers grow:
 *   - parsePortalConfig: defaultTab fallthrough when an unknown enum slips in
 *     and when defaultTab is missing entirely.
 *   - portal-cors: malformed origin URL → no allow-origin header (catch path);
 *     dev-pattern allow when NODE_ENV !== production.
 *   - portal-theme: parsePortalTheme returns a *clone* (not the frozen const).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { parsePortalConfig } from "../portal-config.server";
import { getPortalCorsHeaders, withCors } from "../portal-cors.server";
import { parsePortalTheme, DEFAULT_PORTAL_THEME } from "../portal-theme.server";

// ---------- portal-config.server.ts gap branches ----------

describe("parsePortalConfig — gap branches", () => {
  it("falls back to 'return' when defaultTab is an unknown string", () => {
    const cfg = parsePortalConfig(JSON.stringify({ defaultTab: "wishlist" }));
    expect(cfg.defaultTab).toBe("return");
  });

  it("falls back to 'return' when defaultTab is omitted", () => {
    const cfg = parsePortalConfig(JSON.stringify({ showOrderTracking: false }));
    expect(cfg.defaultTab).toBe("return");
    expect(cfg.showOrderTracking).toBe(false);
  });

  it("respects an explicit false override on every boolean flag", () => {
    const cfg = parsePortalConfig(
      JSON.stringify({
        showOrderTracking: false,
        showReturnTracking: false,
        showCreateReturnTab: false,
        allowMediaUploads: false,
        allowReturnCancellation: false,
        defaultTab: "create",
      }),
    );
    expect(cfg).toEqual({
      showOrderTracking: false,
      showReturnTracking: false,
      showCreateReturnTab: false,
      allowMediaUploads: false,
      allowReturnCancellation: false,
      defaultTab: "create",
    });
  });

  it("returns defaults on unparseable JSON (catch branch)", () => {
    const cfg = parsePortalConfig("{not-json");
    expect(cfg.defaultTab).toBe("return");
    expect(cfg.showOrderTracking).toBe(true);
  });

  it("returns defaults on null/undefined/empty/whitespace", () => {
    expect(parsePortalConfig(null).defaultTab).toBe("return");
    expect(parsePortalConfig(undefined).defaultTab).toBe("return");
    expect(parsePortalConfig("").defaultTab).toBe("return");
    expect(parsePortalConfig("   \n\t").defaultTab).toBe("return");
  });
});

// ---------- portal-cors.server.ts gap branches ----------

describe("getPortalCorsHeaders / withCors — gap branches", () => {
  const ORIG_ENV = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = ORIG_ENV;
  });

  it("does not set Allow-Origin when Origin header is missing", () => {
    const req = new Request("https://app.example.com/x");
    const headers = getPortalCorsHeaders(req);
    expect(headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });

  it("does not set Allow-Origin for malformed origin (URL ctor throws → catch)", () => {
    const req = new Request("https://app.example.com/x", {
      headers: { Origin: "not-a-valid-url" },
    });
    const headers = getPortalCorsHeaders(req);
    expect(headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("allows *.myshopify.com origin", () => {
    const req = new Request("https://app.example.com/x", {
      headers: { Origin: "https://demo-store.myshopify.com" },
    });
    const headers = getPortalCorsHeaders(req);
    expect(headers.get("Access-Control-Allow-Origin")).toBe("https://demo-store.myshopify.com");
    expect(headers.get("Vary")).toBe("Origin");
  });

  it("allows *.shopify.com origin", () => {
    const req = new Request("https://app.example.com/x", {
      headers: { Origin: "https://admin.shopify.com" },
    });
    const headers = getPortalCorsHeaders(req);
    expect(headers.get("Access-Control-Allow-Origin")).toBe("https://admin.shopify.com");
  });

  it("rejects unrelated origins entirely", () => {
    const req = new Request("https://app.example.com/x", {
      headers: { Origin: "https://evil.example.com" },
    });
    const headers = getPortalCorsHeaders(req);
    expect(headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("allows http://localhost in dev mode", () => {
    process.env.NODE_ENV = "development";
    const req = new Request("https://app.example.com/x", {
      headers: { Origin: "http://localhost:3000" },
    });
    const headers = getPortalCorsHeaders(req);
    expect(headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:3000");
  });

  it("allows http://127.0.0.1 in dev mode", () => {
    process.env.NODE_ENV = "test"; // anything !== production
    const req = new Request("https://app.example.com/x", {
      headers: { Origin: "http://127.0.0.1:8080" },
    });
    const headers = getPortalCorsHeaders(req);
    expect(headers.get("Access-Control-Allow-Origin")).toBe("http://127.0.0.1:8080");
  });

  it("does NOT allow localhost when NODE_ENV=production", () => {
    process.env.NODE_ENV = "production";
    const req = new Request("https://app.example.com/x", {
      headers: { Origin: "http://localhost:3000" },
    });
    const headers = getPortalCorsHeaders(req);
    expect(headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("withCors merges CORS headers into a fresh Response, preserving status/body", async () => {
    const req = new Request("https://app.example.com/x", {
      headers: { Origin: "https://shop.myshopify.com" },
    });
    const original = new Response("ok-body", {
      status: 201,
      statusText: "Created",
      headers: { "X-Custom": "yes", "Content-Type": "text/plain" },
    });
    const wrapped = withCors(original, req);
    expect(wrapped.status).toBe(201);
    expect(wrapped.statusText).toBe("Created");
    expect(await wrapped.text()).toBe("ok-body");
    expect(wrapped.headers.get("X-Custom")).toBe("yes");
    expect(wrapped.headers.get("Content-Type")).toBe("text/plain");
    expect(wrapped.headers.get("Access-Control-Allow-Origin")).toBe("https://shop.myshopify.com");
    expect(wrapped.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });

  it("withCors still sets generic CORS headers when origin is rejected", () => {
    const req = new Request("https://app.example.com/x", {
      headers: { Origin: "https://evil.example.com" },
    });
    const wrapped = withCors(new Response(null, { status: 204 }), req);
    expect(wrapped.headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(wrapped.headers.get("Access-Control-Allow-Methods")).toContain("OPTIONS");
    expect(wrapped.headers.get("Access-Control-Max-Age")).toBe("86400");
  });
});

// ---------- portal-theme.server.ts gap branches ----------

describe("parsePortalTheme — gap branches", () => {
  it("returns a fresh object (not the frozen DEFAULT_PORTAL_THEME)", () => {
    const t = parsePortalTheme(null);
    expect(t).toEqual(DEFAULT_PORTAL_THEME);
    // The returned object must be mutable — confirms the spread clone path.
    expect(() => {
      (t as Record<string, string>).primaryColor = "#fff";
    }).not.toThrow();
    expect(t.primaryColor).toBe("#fff");
    // And the export is unchanged
    expect(DEFAULT_PORTAL_THEME.primaryColor).toBe("#008060");
  });

  it("returns a clone on parse error (catch branch) that is also mutable", () => {
    const t = parsePortalTheme("{nope");
    expect(t).toEqual(DEFAULT_PORTAL_THEME);
    expect(() => {
      (t as Record<string, string>).borderRadius = "0px";
    }).not.toThrow();
  });

  it("merges partial overrides while keeping defaults for missing keys", () => {
    const t = parsePortalTheme(JSON.stringify({ primaryColor: "#ff0000" }));
    expect(t.primaryColor).toBe("#ff0000");
    expect(t.backgroundColor).toBe(DEFAULT_PORTAL_THEME.backgroundColor);
  });

  it("handles whitespace-only json as empty (returns clone)", () => {
    const t = parsePortalTheme("   ");
    expect(t).toEqual(DEFAULT_PORTAL_THEME);
  });
});

// ---------- portal-auth.server.ts gap branches (module-init IIFE) ----------

describe("portal-auth.server.ts — secret resolution IIFE", () => {
  const ORIG_SECRET = process.env.PORTAL_JWT_SECRET;
  const ORIG_NODE_ENV = process.env.NODE_ENV;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env.PORTAL_JWT_SECRET = ORIG_SECRET;
    process.env.NODE_ENV = ORIG_NODE_ENV;
    vi.restoreAllMocks();
  });

  it("uses dev fallback + console.warn when PORTAL_JWT_SECRET is unset (non-production)", async () => {
    delete process.env.PORTAL_JWT_SECRET;
    process.env.NODE_ENV = "development";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    const mod = await import("../portal-auth.server");
    // The module loaded — the IIFE returned the dev fallback. Confirm by
    // round-tripping a token, which would fail if SECRET were undefined.
    const token = mod.createPortalToken({ shop: "x.myshopify.com" });
    expect(typeof token).toBe("string");
    const decoded = mod.verifyPortalToken(token);
    expect(decoded).not.toBeNull();
    expect((decoded as Record<string, unknown>).shop).toBe("x.myshopify.com");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toContain("PORTAL_JWT_SECRET not set or too short");
  });

  it("uses dev fallback + console.warn when PORTAL_JWT_SECRET is too short (non-production)", async () => {
    process.env.PORTAL_JWT_SECRET = "tooshort"; // <32 chars
    process.env.NODE_ENV = "development";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    const mod = await import("../portal-auth.server");
    const token = mod.createPortalToken({ ok: true });
    expect(mod.verifyPortalToken(token)).not.toBeNull();
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it("throws on module load when PORTAL_JWT_SECRET is unset and NODE_ENV=production", async () => {
    delete process.env.PORTAL_JWT_SECRET;
    process.env.NODE_ENV = "production";
    vi.resetModules();
    await expect(import("../portal-auth.server")).rejects.toThrow(
      /PORTAL_JWT_SECRET must be set in production/,
    );
  });

  it("throws on module load when PORTAL_JWT_SECRET is too short and NODE_ENV=production", async () => {
    process.env.PORTAL_JWT_SECRET = "short";
    process.env.NODE_ENV = "production";
    vi.resetModules();
    await expect(import("../portal-auth.server")).rejects.toThrow(/at least 32 characters/);
  });

  it("uses the env-supplied secret when it is >= 32 chars (happy path, no warn, no throw)", async () => {
    process.env.PORTAL_JWT_SECRET = "z".repeat(64);
    process.env.NODE_ENV = "development";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.resetModules();
    const mod = await import("../portal-auth.server");
    const token = mod.createPortalToken({ a: 1 });
    const decoded = mod.verifyPortalToken(token);
    expect((decoded as Record<string, unknown>).a).toBe(1);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
