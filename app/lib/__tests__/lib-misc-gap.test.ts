/**
 * Gap-filler tests for nine small lib modules.
 *
 * Each existing suite covers the happy paths and most branches; this file
 * targets the remaining residual lines / branches identified by the v8
 * coverage report so the per-file coverage clears 99%:
 *
 *   - credential-validation.server.ts: the success path that assigns
 *     `sanitized.fyndApplicationToken` after the length guard passes (line 58
 *     was uncovered because every existing test exercised the length-too-long
 *     branch only).
 *   - refund-gate-presets.ts: the `?? null` fallback inside
 *     `getStatusesForPreset` when an unknown preset key bypasses the
 *     none/custom early-return (only reachable via a cast-from-unknown).
 *   - return-request-id.ts: the unreachable-by-type-but-reachable-by-cast
 *     `default:` arm of the switch in `buildReturnRequestId`.
 *
 * For the other files (shop.server, return-id-counter.server, parse-json,
 * status-colors, source-channel.server) we add a tiny smoke + import-once
 * sanity check so this file legitimately "covers all listed files" while
 * not duplicating the existing thorough suites.
 *
 * NB: NO source modifications are made. We rely on `as` casts to drive
 * defensive defaults that exist in the source for runtime safety even
 * though TypeScript would normally rule them out.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import { sanitizeCredentialInputs } from "../credential-validation.server";
import {
  getStatusesForPreset,
  inferPresetFromStatuses,
  type RefundGatePreset,
} from "../refund-gate-presets";
import {
  buildReturnRequestId,
  parseReturnIdConfig,
  previewReturnRequestId,
  formatReturnRequestId,
  DEFAULT_RETURN_ID_CONFIG,
  type ReturnIdConfig,
} from "../return-request-id";
import { parseJsonArray, parseJsonObject } from "../parse-json";
import { getStatusColor, getStatusBg } from "../status-colors";
import {
  normalizeSourceChannel,
  sourceChannelLabel,
  parseChannelPolicies,
  getChannelPolicy,
} from "../source-channel.server";
import {
  enrichFyndError,
  classifyFyndError,
  enrichRefundError,
  isRedirectResponse,
  extractErrorMessage,
} from "../return-action-errors.server";

// ─── Mock prisma for shop.server + return-id-counter ──────────────────────

const { prismaMock } = vi.hoisted(() => ({
  prismaMock: {
    shop: {
      upsert: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
    },
    shopSettings: {
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({}),
    },
    $queryRawUnsafe: vi.fn(),
  },
}));

vi.mock("../../db.server", () => ({ default: prismaMock }));

import { findOrCreateShop, syncShopLocaleAndCurrency } from "../shop.server";
import { nextReturnIdCounter } from "../return-id-counter.server";

beforeEach(() => {
  prismaMock.shop.upsert.mockReset();
  prismaMock.shop.findUnique.mockReset();
  prismaMock.shop.findUniqueOrThrow.mockReset();
  prismaMock.shopSettings.update.mockReset().mockResolvedValue({});
  prismaMock.shopSettings.create.mockReset().mockResolvedValue({});
  prismaMock.$queryRawUnsafe.mockReset();
});

// ─── credential-validation.server.ts ──────────────────────────────────────

describe("credential-validation.server.ts — gaps", () => {
  it("returns sanitized fyndApplicationToken on the happy path (line 58)", () => {
    // Existing tests only exercise the length-too-long rejection path. The
    // success-path assignment that copies the trimmed value into `sanitized`
    // was uncovered. Drive it with a normal-length token containing
    // surrounding whitespace so we can also assert trimming.
    const r = sanitizeCredentialInputs({ fyndApplicationToken: "  tok-abc  " });
    expect(r.valid).toBe(true);
    expect(r.sanitized?.fyndApplicationToken).toBe("tok-abc");
  });

  it("accepts an empty applicationToken (optional)", () => {
    const r = sanitizeCredentialInputs({ fyndApplicationToken: "" });
    expect(r.valid).toBe(true);
    expect(r.sanitized?.fyndApplicationToken).toBe("");
  });

  it("returns sanitized values when given no input fields at all", () => {
    const r = sanitizeCredentialInputs({});
    expect(r.valid).toBe(true);
    expect(r.sanitized).toEqual({});
  });
});

// ─── refund-gate-presets.ts ───────────────────────────────────────────────

describe("refund-gate-presets.ts — gaps", () => {
  it("getStatusesForPreset returns null for an unknown preset key (?? null fallback, line 64)", () => {
    // Cast through unknown so we can drive the defensive `?? null` branch
    // without fighting TS — production code can hit this if a stale shop
    // record has a preset string we no longer recognise.
    const unknown = "after_full_moon" as unknown as RefundGatePreset;
    expect(getStatusesForPreset(unknown)).toBeNull();
  });

  it("inferPresetFromStatuses handles a single-status array gracefully", () => {
    expect(inferPresetFromStatuses(["unrelated"])).toBe("custom");
  });
});

// ─── return-request-id.ts ─────────────────────────────────────────────────

describe("return-request-id.ts — gaps", () => {
  it("buildReturnRequestId falls through to the default switch arm for unknown bodyMode (line 94)", () => {
    // The source defines a `default:` arm that mirrors hash-mode behaviour as
    // a safety net for unexpected bodyMode values. TS prevents reaching it
    // through the typed surface, so we cast through unknown to verify the
    // defensive fallback still produces a sane id.
    const cfg = {
      ...DEFAULT_RETURN_ID_CONFIG,
      bodyMode: "future_mode" as unknown as ReturnIdConfig["bodyMode"],
      hashLength: 8,
    };
    const id = buildReturnRequestId(cfg as ReturnIdConfig, "abcdefghij1234567890");
    expect(id).toBe("RPM-34567890");
  });

  it("previewReturnRequestId combined with parseReturnIdConfig round-trips a preset", () => {
    const json = JSON.stringify({ ...DEFAULT_RETURN_ID_CONFIG, prefix: "RMA", suffix: "-EU" });
    const cfg = parseReturnIdConfig(json);
    const preview = previewReturnRequestId(cfg);
    expect(preview.startsWith("RMA-")).toBe(true);
    expect(preview.endsWith("-EU")).toBe(true);
  });

  it("formatReturnRequestId smoke (already covered, included for module touch)", () => {
    expect(formatReturnRequestId("aaaaaaaa")).toBe("RPM-AAAAAAAA");
  });
});

// ─── parse-json.ts ────────────────────────────────────────────────────────

describe("parse-json.ts — gap smoke", () => {
  it("parseJsonArray + parseJsonObject smoke (module touch)", () => {
    expect(parseJsonArray("[1,2]", [])).toEqual([1, 2]);
    expect(parseJsonObject('{"a":1}', {})).toEqual({ a: 1 });
  });
});

// ─── status-colors.ts ─────────────────────────────────────────────────────

describe("status-colors.ts — gap smoke", () => {
  it("getStatusColor + getStatusBg smoke (module touch)", () => {
    expect(getStatusColor("pending")).toMatch(/^#/);
    expect(getStatusBg("pending")).toMatch(/^#/);
  });
});

// ─── source-channel.server.ts ─────────────────────────────────────────────

describe("source-channel.server.ts — gap smoke", () => {
  it("normalizeSourceChannel + label + policies smoke (module touch)", () => {
    expect(normalizeSourceChannel("pos")).toBe("pos");
    expect(sourceChannelLabel("pos")).toBe("Point of Sale");
    expect(parseChannelPolicies(null)).toEqual({});
    expect(getChannelPolicy({}, "pos")).toBeNull();
  });
});

// ─── return-action-errors.server.ts ───────────────────────────────────────

describe("return-action-errors.server.ts — gap smoke", () => {
  it("public surface smoke (module touch)", async () => {
    expect(enrichFyndError("ok")).toBe("ok");
    expect(classifyFyndError("ok")).toBe("api_error");
    expect(enrichRefundError("ok", { method: null, orderName: null })).toBe("ok");
    expect(isRedirectResponse(new Response(null, { status: 302 }))).toBe(true);
    expect(await extractErrorMessage(new Error("ok"))).toBe("ok");
  });
});

// ─── shop.server.ts ───────────────────────────────────────────────────────

describe("shop.server.ts — gap smoke", () => {
  it("findOrCreateShop happy path (module touch)", async () => {
    const shop = { id: "s1", shopDomain: "x.myshopify.com", settings: null };
    prismaMock.shop.upsert.mockResolvedValue(shop);
    expect(await findOrCreateShop("x.myshopify.com")).toEqual(shop);
  });

  it("syncShopLocaleAndCurrency smoke with empty data path", async () => {
    const admin = {
      graphql: vi.fn().mockResolvedValue({ json: async () => ({ data: {} }) }),
    } as Parameters<typeof syncShopLocaleAndCurrency>[0];
    const res = await syncShopLocaleAndCurrency(admin, "x.myshopify.com");
    expect(res).toEqual({ locale: "en", currency: "USD", timezone: "UTC" });
  });
});

// ─── return-id-counter.server.ts ──────────────────────────────────────────

describe("return-id-counter.server.ts — gap smoke", () => {
  it("nextReturnIdCounter happy path (module touch)", async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([{ returnIdCounter: 1 }]);
    expect(await nextReturnIdCounter("s")).toBe(1);
  });
});
