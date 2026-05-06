/**
 * Final branch-coverage gap tests across small lib utilities.
 *
 * Each test targets a specific branch edge that is NOT exercised by
 * existing test files. Source code is not modified. Goal: push branch
 * coverage on the listed utilities towards 98–100%.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/* 1. return-rules.server.ts — invalid productPoliciesJson catch    */
describe("return-rules.server — findMatchingProductPolicy malformed JSON", () => {
  it("returns eligible (catches JSON.parse error) when productPoliciesJson is unparseable", async () => {
    vi.resetModules();
    const { checkReturnEligibility } = await import("../return-rules.server");
    const settings = {
      id: "s",
      shopId: "shop",
      returnWindowDays: 30,
      productPoliciesJson: "{not-json",
      restrictedProductTagsJson: null,
      restrictedRegionsJson: null,
      returnFeeAmount: null,
      noReturnPeriodEnabled: false,
      minimumReturnPrice: null,
      photoRequired: false,
      channelPoliciesJson: null,
    } as never;
    const result = checkReturnEligibility(settings, {
      orderDate: new Date(),
      productTags: ["foo"],
    });
    expect(result.eligible).toBe(true);
  });
});

/* 2. encryption.server.ts — encryptIfNeeded already-encrypted + null branches */
describe("encryption.server — encryptIfNeeded / decryptIfEncrypted nil + idempotency", () => {
  it("encryptIfNeeded is idempotent (skips re-encrypt) and returns null for nil inputs", async () => {
    vi.resetModules();
    const { encrypt, encryptIfNeeded, decryptIfEncrypted } = await import(
      "../encryption.server"
    );
    const ct = encrypt("hello");
    expect(encryptIfNeeded(ct)).toBe(ct);
    expect(encryptIfNeeded(null)).toBeNull();
    expect(encryptIfNeeded(undefined)).toBeNull();
    expect(decryptIfEncrypted(null)).toBeNull();
    expect(decryptIfEncrypted(undefined)).toBeNull();
  });
});

/* 3. portal-auth.server.ts — cleanupExpiredSessions */
describe("portal-auth.server — cleanupExpiredSessions", () => {
  it("calls deleteMany with a cutoff Date and returns the deleted count", async () => {
    const { cleanupExpiredSessions } = await import("../portal-auth.server");
    const deleteMany = vi.fn().mockResolvedValue({ count: 7 });
    const result = await cleanupExpiredSessions(
      { lookupSession: { deleteMany } },
      30,
    );
    expect(result).toBe(7);
    const callArg = deleteMany.mock.calls[0][0] as {
      where: { expiresAt: { lt: Date } };
    };
    const ageDays =
      (Date.now() - callArg.where.expiresAt.lt.getTime()) / 86_400_000;
    expect(ageDays).toBeGreaterThan(29);
    expect(ageDays).toBeLessThan(31);
  });
});

/* 4. portal-cors.server.ts — malformed-URL catch */
describe("portal-cors.server — malformed Origin URL catch", () => {
  it("does not echo a non-URL Origin string", async () => {
    const { getPortalCorsHeaders } = await import("../portal-cors.server");
    const req = new Request("https://app.example.com/x", {
      headers: { Origin: "::not-a-url::" },
    });
    const headers = getPortalCorsHeaders(req);
    expect(headers.get("Access-Control-Allow-Origin")).toBeNull();
    expect(headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });
});

/* 5. return-id-counter.server.ts — both throw + success branches */
describe("return-id-counter.server — UPDATE result branches", () => {
  it("throws when zero rows return; resolves to counter on success", async () => {
    vi.resetModules();
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ returnIdCounter: 42 }]);
    vi.doMock("../../db.server", () => ({
      default: { $queryRawUnsafe: queryRaw },
    }));
    const { nextReturnIdCounter } = await import("../return-id-counter.server");
    await expect(nextReturnIdCounter("missing")).rejects.toThrow(
      /ShopSettings not found/,
    );
    await expect(nextReturnIdCounter("settings-1")).resolves.toBe(42);
    vi.doUnmock("../../db.server");
  });
});

/* 6. status-colors.ts — fallback + whitespace-normalisation */
describe("status-colors — fallback + whitespace normalisation", () => {
  it("returns fallbacks for unknown status and normalises whitespace", async () => {
    const { getStatusColor, getStatusBg } = await import("../status-colors");
    expect(getStatusColor("totally-unknown")).toBe("#64748b");
    expect(getStatusBg("totally-unknown")).toBe("#f8fafc");
    // /\s+/g + lowercase normalises 'IN  PROGRESS' → 'in progress'
    expect(getStatusColor("IN  PROGRESS")).toBe("#1d4ed8");
  });
});

/* 7. rate-limit.server.ts — principal + 429 + memory limit branches */
describe("rate-limit.server — principal/IP keying + 429 + limit-exceeded", () => {
  beforeEach(async () => {
    const mod = await import("../rate-limit.server");
    mod.__resetRateLimitForTests();
  });

  it("uses principal-prefixed key when principal is supplied", async () => {
    const { checkRateLimit } = await import("../rate-limit.server");
    const req = new Request("https://example.com/x?shop=ignored");
    const r = await checkRateLimit(req, "external.returns.list", "key-abc");
    expect(r.allowed).toBe(true);
  });

  it("rateLimitResponse returns 429 with Retry-After (ceil seconds)", async () => {
    const { rateLimitResponse } = await import("../rate-limit.server");
    const res = rateLimitResponse(2_500);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("3");
  });

  it("denies once the per-endpoint limit is exceeded", async () => {
    const { checkRateLimit, __resetRateLimitForTests } = await import(
      "../rate-limit.server"
    );
    __resetRateLimitForTests();
    const req = new Request("https://example.com/p", {
      headers: { "x-forwarded-for": "1.2.3.4" },
    });
    let last: Awaited<ReturnType<typeof checkRateLimit>> | null = null;
    // portal.create-return → maxRequests = 5; 6th call must fail.
    for (let i = 0; i < 6; i++) {
      last = await checkRateLimit(req, "portal.create-return");
    }
    expect(last?.allowed).toBe(false);
    expect(last?.retryAfterMs).toBeGreaterThan(0);
  });
});

/* 8. redis.server.ts — uninitialised + test injector */
describe("redis.server — uninitialised + test injector", () => {
  it("getRedis returns null with no REDIS_URL; closeRedis is a no-op", async () => {
    vi.resetModules();
    const prev = process.env.REDIS_URL;
    delete process.env.REDIS_URL;
    const { getRedis, closeRedis } = await import("../redis.server");
    expect(getRedis()).toBeNull();
    await expect(closeRedis()).resolves.toBeUndefined();
    if (prev !== undefined) process.env.REDIS_URL = prev;
  });

  it("__setRedisForTests injects a fake client and closeRedis quits it", async () => {
    vi.resetModules();
    const { __setRedisForTests, getRedis, closeRedis } = await import(
      "../redis.server"
    );
    const fake = { quit: vi.fn().mockResolvedValue("OK") };
    __setRedisForTests(fake as never);
    expect(getRedis()).toBe(fake as unknown);
    await closeRedis();
    expect(fake.quit).toHaveBeenCalled();
    __setRedisForTests(null);
    expect(getRedis()).toBeNull();
  });
});

/* 9. return-action-errors.server.ts — extractErrorMessage edge fallbacks */
describe("return-action-errors.server — extractErrorMessage edges", () => {
  it("returns connection sentinel for ECONNREFUSED Errors and status fallback for Response w/o error field", async () => {
    const { extractErrorMessage } = await import(
      "../return-action-errors.server"
    );
    expect(await extractErrorMessage(new Error("ECONNREFUSED 1.2.3.4:5432"))).toMatch(
      /Unable to connect/,
    );
    const res = new Response(JSON.stringify({ unrelated: "v" }), {
      status: 502,
      headers: { "content-type": "application/json" },
    });
    const out = await extractErrorMessage(res);
    expect(out).toMatch(/502/);
    expect(out).toMatch(/Fynd configuration/);
  });

  it("returns the generic Request-failed message for plain {} non-Error inputs", async () => {
    const { extractErrorMessage } = await import(
      "../return-action-errors.server"
    );
    // Plain object stringifies to "[object Object]" → generic fallback.
    expect(await extractErrorMessage({})).toMatch(/Request failed/);
  });
});

/* 10. credential-validation.server.ts — customBaseUrl invalid + auto-prefix */
describe("credential-validation.server — fyndCustomBaseUrl branches", () => {
  it("rejects an unparseable customBaseUrl and accepts a bare hostname (https auto-prefix)", async () => {
    const { sanitizeCredentialInputs } = await import(
      "../credential-validation.server"
    );
    const bad = sanitizeCredentialInputs({
      fyndCustomBaseUrl: "http://exa mple.com/path",
    });
    expect(bad.valid).toBe(false);
    expect(bad.error).toMatch(/Invalid custom URL/);

    const good = sanitizeCredentialInputs({ fyndCustomBaseUrl: "api.fynd.com" });
    expect(good.valid).toBe(true);
    expect(good.sanitized?.fyndCustomBaseUrl).toBe("api.fynd.com");
  });
});

/* 11. shop.server.ts — graphql failure / missing data branches */
describe("shop.server — syncShopLocaleAndCurrency error + missing-data fallback", () => {
  it("returns defaults when graphql throws and when data.shop is missing", async () => {
    vi.resetModules();
    vi.doMock("../../db.server", () => ({
      default: {
        shop: { upsert: vi.fn(), findUnique: vi.fn().mockResolvedValue(null) },
        shopSettings: { update: vi.fn(), create: vi.fn() },
      },
    }));
    const { syncShopLocaleAndCurrency } = await import("../shop.server");
    const adminFail = {
      graphql: vi.fn().mockRejectedValue(new Error("net down")),
    };
    expect(await syncShopLocaleAndCurrency(adminFail, "x.myshopify.com")).toEqual({
      locale: "en",
      currency: "USD",
      timezone: "UTC",
    });

    const adminEmpty = {
      graphql: vi
        .fn()
        .mockResolvedValue({ json: async () => ({ data: {} }) }),
    };
    expect(await syncShopLocaleAndCurrency(adminEmpty, "x.myshopify.com")).toEqual({
      locale: "en",
      currency: "USD",
      timezone: "UTC",
    });
    vi.doUnmock("../../db.server");
  });
});

/* 12. parse-json.ts — parseJsonObject branches */
describe("parse-json — parseJsonObject branches", () => {
  it("returns fallback on array / malformed / whitespace; parses valid object", async () => {
    const { parseJsonObject } = await import("../parse-json");
    expect(parseJsonObject<{ a?: number }>("[1,2,3]", { a: 7 })).toEqual({ a: 7 });
    expect(parseJsonObject<{ a?: number }>("{not-json", { a: 1 })).toEqual({ a: 1 });
    expect(parseJsonObject("   \n", { fallback: true })).toEqual({ fallback: true });
    expect(parseJsonObject('{"x":1}', { x: 0 })).toEqual({ x: 1 });
  });
});

/* 13. return-request-id.ts — buildReturnRequestId default branch */
describe("return-request-id — buildReturnRequestId default arm + formatReturnRequestId short input", () => {
  it("falls through to hash mode for an unknown bodyMode and echoes short ids", async () => {
    const { buildReturnRequestId, formatReturnRequestId } = await import(
      "../return-request-id"
    );
    const id = buildReturnRequestId(
      {
        prefix: "RPM",
        separator: "-",
        bodyMode: "garbage" as unknown as never,
        hashLength: 8,
        sequentialPadding: 6,
        suffix: "",
      },
      "cm5x9abc1234defg5678hijklmno",
    );
    expect(id.startsWith("RPM-")).toBe(true);
    expect(id.length).toBe(4 + 8); // "RPM-" + 8 chars
    expect(formatReturnRequestId("short")).toBe("short");
    expect(formatReturnRequestId("")).toBe("");
  });
});

/* 14. source-channel.server.ts — parseChannelPolicies + label branches */
describe("source-channel.server — parseChannelPolicies catch + label fallback", () => {
  it("returns {} on parse error; getChannelPolicy null/web short-circuits; raw label", async () => {
    const { parseChannelPolicies, getChannelPolicy, sourceChannelLabel } =
      await import("../source-channel.server");
    expect(parseChannelPolicies("{not-json")).toEqual({});
    expect(getChannelPolicy({}, null)).toBeNull();
    expect(getChannelPolicy({}, "web")).toBeNull();
    expect(sourceChannelLabel("unknown_channel")).toBe("unknown_channel");
    expect(sourceChannelLabel(null)).toBe("Online Store");
  });
});

/* 15. refund-gate-presets.ts — inferPresetFromStatuses + getStatusesForPreset */
describe("refund-gate-presets — preset inference + null returns", () => {
  it("infers 'none' / preset / 'custom' and returns null for none/custom", async () => {
    const { inferPresetFromStatuses, getStatusesForPreset } = await import(
      "../refund-gate-presets"
    );
    expect(inferPresetFromStatuses([])).toBe("none");
    expect(getStatusesForPreset("none")).toBeNull();
    expect(getStatusesForPreset("custom")).toBeNull();

    const list = getStatusesForPreset("after_qc")!;
    expect(inferPresetFromStatuses(list)).toBe("after_qc");
    expect(inferPresetFromStatuses(["random_a", "random_b"])).toBe("custom");
  });
});

/* 16. url-safety.server.ts — IPv6 literal + scheme/host edge branches */
describe("url-safety.server — IPv6 + scheme + host edges", () => {
  it("rejects loopback IPv6 literal, allows public IPv6, and rejects http when not allowed", async () => {
    const { isSafeOutboundUrl, isPrivateIPv6, isPrivateIPv4 } = await import(
      "../url-safety.server"
    );
    // Bracketed IPv6 literal — strips brackets, classifies private
    const loop = await isSafeOutboundUrl("https://[::1]/path");
    expect(loop).toEqual({ ok: false, reason: "private_ipv6" });
    // Public IPv6 literal short-circuits to ok
    const pub = await isSafeOutboundUrl("https://[2606:4700:4700::1111]/x");
    expect(pub).toEqual({ ok: true });
    // ftp:// — scheme not allowed
    const ftp = await isSafeOutboundUrl("ftp://example.com/x");
    expect(ftp).toEqual({ ok: false, reason: "scheme_not_allowed" });
    // http allowed via opt-in
    const okHttp = await isSafeOutboundUrl("http://example.com/x", {
      allowHttp: true,
    });
    expect(okHttp).toEqual({ ok: true });
    // IPv4-mapped IPv6 of a private v4 → private
    expect(isPrivateIPv6("::ffff:10.0.0.1")).toBe(true);
    // unique-local prefix 'fc' / 'fd' → private
    expect(isPrivateIPv6("fc00::1")).toBe(true);
    expect(isPrivateIPv6("FE80::1")).toBe(true);
    // public IPv6 (no private prefix) → false
    expect(isPrivateIPv6("2001:4860:4860::8888")).toBe(false);
    // ipv4ToInt invalid input → false
    expect(isPrivateIPv4("999.1.1.1")).toBe(false);
    expect(isPrivateIPv4("not-ip")).toBe(false);
    // garbage URL
    const bad = await isSafeOutboundUrl("not a url");
    expect(bad).toEqual({ ok: false, reason: "invalid_url" });
  });
});

/* 17. auto-approve.server.ts — productTag operators + numeric rule edge branches */
describe("auto-approve.server — full operator + parse coverage", () => {
  it("hits every productTag operator branch and rejects bad numeric rules", async () => {
    const { evaluateAutoApproveRules, parseAutoApproveRules } = await import(
      "../auto-approve.server"
    );
    const ctx = { productTags: ["Sale", "FINAL"], orderValue: 100, customerReturnCount: 5 };
    // contains
    expect(
      evaluateAutoApproveRules(
        [{ field: "productTag", operator: "contains", value: "sal", action: "manual_review" }],
        ctx,
      ),
    ).toBe("manual_review");
    // not_contains
    expect(
      evaluateAutoApproveRules(
        [{ field: "productTag", operator: "not_contains", value: "xyz", action: "approve" }],
        ctx,
      ),
    ).toBe("approve");
    // eq match
    expect(
      evaluateAutoApproveRules(
        [{ field: "productTag", operator: "eq", value: "sale", action: "approve" }],
        ctx,
      ),
    ).toBe("approve");
    // neq match
    expect(
      evaluateAutoApproveRules(
        [{ field: "productTag", operator: "neq", value: "nope", action: "approve" }],
        ctx,
      ),
    ).toBe("approve");
    // unsupported operator returns false → null result
    expect(
      evaluateAutoApproveRules(
        [{ field: "productTag", operator: "gt" as never, value: "sale", action: "approve" }],
        ctx,
      ),
    ).toBeNull();
    // Numeric rule with non-finite value rejected
    expect(
      evaluateAutoApproveRules(
        [{ field: "orderValue", operator: "gt", value: "abc", action: "approve" }],
        ctx,
      ),
    ).toBeNull();
    // customerReturnCount finite + gte hits compareNumeric
    expect(
      evaluateAutoApproveRules(
        [{ field: "customerReturnCount", operator: "gte", value: "5", action: "approve" }],
        ctx,
      ),
    ).toBe("approve");
    // returnReason missing in context returns null
    expect(
      evaluateAutoApproveRules(
        [{ field: "returnReason", operator: "eq", value: "x", action: "approve" }],
        {},
      ),
    ).toBeNull();
    // empty rules array
    expect(evaluateAutoApproveRules([], ctx)).toBeNull();
    // parse: non-array JSON returns []
    expect(parseAutoApproveRules('{"x":1}')).toEqual([]);
    // parse: malformed JSON
    expect(parseAutoApproveRules("{not-json")).toEqual([]);
    // parse: filters invalid entries
    expect(
      parseAutoApproveRules(
        JSON.stringify([
          { field: "x", operator: "eq", value: "v", action: "approve" },
          null,
          { field: "x" },
        ]),
      ),
    ).toHaveLength(1);
  });
});

/* 18. billing.server.ts — getBillingMode + isSuperAdmin branches */
describe("billing.server — env mode + superadmin parse branches", () => {
  it("getBillingMode treats unset/garbage as 'dev' and 'production' alias as 'prod'; isSuperAdmin handles list", async () => {
    const { getBillingMode, isSuperAdmin, getManagedPricingUpgradeUrl } =
      await import("../billing.server");
    const prevMode = process.env.APP_BILLING_MODE;
    const prevAdmins = process.env.SUPERADMIN_EMAILS;
    const prevHandle = process.env.APP_MANAGED_PRICING_HANDLE;
    const prevApiKey = process.env.SHOPIFY_API_KEY;

    delete process.env.APP_BILLING_MODE;
    expect(getBillingMode()).toBe("dev");
    process.env.APP_BILLING_MODE = "garbage";
    expect(getBillingMode()).toBe("dev");
    process.env.APP_BILLING_MODE = "PROD";
    expect(getBillingMode()).toBe("prod");
    process.env.APP_BILLING_MODE = "production";
    expect(getBillingMode()).toBe("prod");

    // superadmin: empty / null / present
    delete process.env.SUPERADMIN_EMAILS;
    expect(isSuperAdmin("a@b.com")).toBe(false);
    expect(isSuperAdmin(null)).toBe(false);
    expect(isSuperAdmin(undefined)).toBe(false);
    expect(isSuperAdmin("")).toBe(false);
    process.env.SUPERADMIN_EMAILS = "  Admin@Example.com  , other@x.com ";
    expect(isSuperAdmin("admin@example.com")).toBe(true);
    expect(isSuperAdmin("OTHER@X.COM")).toBe(true);
    expect(isSuperAdmin("nope@x.com")).toBe(false);

    // pricing url: handle precedence + protocol stripping
    process.env.APP_MANAGED_PRICING_HANDLE = "my-handle";
    expect(getManagedPricingUpgradeUrl("https://shop.myshopify.com/")).toMatch(
      /\/store\/shop\/charges\/my-handle\/pricing_plans$/,
    );
    delete process.env.APP_MANAGED_PRICING_HANDLE;
    process.env.SHOPIFY_API_KEY = "key-123";
    expect(getManagedPricingUpgradeUrl("shop.myshopify.com")).toMatch(
      /\/charges\/key-123\/pricing_plans$/,
    );
    delete process.env.SHOPIFY_API_KEY;
    expect(getManagedPricingUpgradeUrl("plain")).toMatch(/\/charges\/\/pricing_plans$/);

    // restore
    if (prevMode !== undefined) process.env.APP_BILLING_MODE = prevMode;
    else delete process.env.APP_BILLING_MODE;
    if (prevAdmins !== undefined) process.env.SUPERADMIN_EMAILS = prevAdmins;
    else delete process.env.SUPERADMIN_EMAILS;
    if (prevHandle !== undefined) process.env.APP_MANAGED_PRICING_HANDLE = prevHandle;
    if (prevApiKey !== undefined) process.env.SHOPIFY_API_KEY = prevApiKey;
  });
});

/* 19. portal-theme.server.ts — applyPortalThemeToHtml + parse fallback */
describe("portal-theme.server — apply + invalid JSON fallback", () => {
  it("replaces every placeholder and falls back on invalid JSON", async () => {
    const { applyPortalThemeToHtml, parsePortalTheme, DEFAULT_PORTAL_THEME } =
      await import("../portal-theme.server");
    const html =
      "%PRIMARY_COLOR%|%PRIMARY_HOVER%|%BG_COLOR%|%SURFACE_COLOR%|%TEXT_COLOR%|%TEXT_MUTED%|%BORDER_COLOR%|%FONT_FAMILY%|%HEADING_FONT%|%BORDER_RADIUS%|%SHADOW%";
    const out = applyPortalThemeToHtml(html, { ...DEFAULT_PORTAL_THEME });
    expect(out).not.toContain("%");
    expect(out).toContain(DEFAULT_PORTAL_THEME.primaryColor);
    expect(out).toContain(DEFAULT_PORTAL_THEME.shadow);
    // invalid JSON path → defaults
    expect(parsePortalTheme("{not-json")).toEqual({ ...DEFAULT_PORTAL_THEME });
    // whitespace-only
    expect(parsePortalTheme("   ")).toEqual({ ...DEFAULT_PORTAL_THEME });
    // null / undefined
    expect(parsePortalTheme(null)).toEqual({ ...DEFAULT_PORTAL_THEME });
    expect(parsePortalTheme(undefined)).toEqual({ ...DEFAULT_PORTAL_THEME });
    // partial overrides spread
    const partial = parsePortalTheme(JSON.stringify({ primaryColor: "#f00" }));
    expect(partial.primaryColor).toBe("#f00");
    expect(partial.fontFamily).toBe(DEFAULT_PORTAL_THEME.fontFamily);
  });
});

/* 20. api-key-auth.server.ts — generate format */
describe("api-key-auth.server — generateApiKey output shape", () => {
  it("returns rpm_-prefixed key, 8-char prefix, and a non-trivial bcrypt hash", async () => {
    const { generateApiKey, ALL_PERMISSIONS } = await import(
      "../api-key-auth.server"
    );
    const r = await generateApiKey();
    expect(r.fullKey.startsWith("rpm_")).toBe(true);
    expect(r.fullKey.length).toBe(4 + 40);
    expect(r.keyPrefix).toBe(r.fullKey.substring(0, 8));
    expect(r.keyHash.length).toBeGreaterThan(20);
    expect(r.keyHash).not.toContain(r.fullKey);
    expect(ALL_PERMISSIONS).toContain("read_returns");
    expect(ALL_PERMISSIONS).toContain("manage_webhooks");
  });
});
