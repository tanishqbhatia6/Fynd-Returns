/**
 * Tests for source-channel.server.ts: normalises Shopify order source_name
 * values into a small set of canonical channels and parses per-channel return
 * policy JSON. Returns intake / portal eligibility / per-channel return windows
 * all hinge on these helpers, so we lock in the channel mapping + JSON
 * tolerance contract.
 */
import { describe, it, expect } from "vitest";
import {
  normalizeSourceChannel,
  sourceChannelLabel,
  parseChannelPolicies,
  getChannelPolicy,
  type ChannelPolicy,
  type ChannelPoliciesMap,
} from "../source-channel.server";

describe("normalizeSourceChannel", () => {
  it("returns null for null/undefined/empty input", () => {
    expect(normalizeSourceChannel(null)).toBeNull();
    expect(normalizeSourceChannel(undefined)).toBeNull();
    expect(normalizeSourceChannel("")).toBeNull();
  });

  it("maps POS variants to 'pos' (case-insensitive, whitespace trimmed)", () => {
    expect(normalizeSourceChannel("pos")).toBe("pos");
    expect(normalizeSourceChannel("POS")).toBe("pos");
    expect(normalizeSourceChannel("shopify_pos")).toBe("pos");
    expect(normalizeSourceChannel("  Shopify_POS  ")).toBe("pos");
  });

  it("maps draft order variants to 'draft_order'", () => {
    expect(normalizeSourceChannel("draft_order")).toBe("draft_order");
    expect(normalizeSourceChannel("shopify_draft_order")).toBe("draft_order");
    expect(normalizeSourceChannel("Draft_Order")).toBe("draft_order");
  });

  it("maps B2B / wholesale variants to 'b2b'", () => {
    expect(normalizeSourceChannel("b2b")).toBe("b2b");
    expect(normalizeSourceChannel("shopify_b2b")).toBe("b2b");
    expect(normalizeSourceChannel("wholesale")).toBe("b2b");
    expect(normalizeSourceChannel("WHOLESALE")).toBe("b2b");
  });

  it("maps online-store variants to 'web'", () => {
    expect(normalizeSourceChannel("web")).toBe("web");
    expect(normalizeSourceChannel("online")).toBe("web");
    expect(normalizeSourceChannel("online_store")).toBe("web");
    expect(normalizeSourceChannel("Online_Store")).toBe("web");
  });

  it("returns lowercased raw value for unknown channels (no silent drop)", () => {
    expect(normalizeSourceChannel("Shopify_POS_Mobile")).toBe("shopify_pos_mobile");
    expect(normalizeSourceChannel("  custom_channel  ")).toBe("custom_channel");
    expect(normalizeSourceChannel("MARKETPLACE")).toBe("marketplace");
  });

  it("trims surrounding whitespace before mapping", () => {
    expect(normalizeSourceChannel("\tpos\n")).toBe("pos");
    expect(normalizeSourceChannel("   wholesale   ")).toBe("b2b");
  });
});

describe("sourceChannelLabel", () => {
  it.each([
    ["pos", "Point of Sale"],
    ["draft_order", "Draft Order"],
    ["b2b", "B2B / Wholesale"],
    ["web", "Online Store"],
  ])("labels %s as %s", (channel, label) => {
    expect(sourceChannelLabel(channel)).toBe(label);
  });

  it("echoes unknown channels verbatim", () => {
    expect(sourceChannelLabel("shopify_pos_mobile")).toBe("shopify_pos_mobile");
  });

  it("defaults to 'Online Store' for null/undefined", () => {
    expect(sourceChannelLabel(null)).toBe("Online Store");
    expect(sourceChannelLabel(undefined)).toBe("Online Store");
  });
});

describe("parseChannelPolicies", () => {
  it("returns empty object for null/undefined/empty input", () => {
    expect(parseChannelPolicies(null)).toEqual({});
    expect(parseChannelPolicies(undefined)).toEqual({});
    expect(parseChannelPolicies("")).toEqual({});
  });

  it("parses a valid channel policy map", () => {
    const json = JSON.stringify({
      pos: { returnEnabled: false, returnWindowDays: null, autoApproveEnabled: null },
      b2b: { returnEnabled: true, returnWindowDays: 60, autoApproveEnabled: false },
      draft_order: { returnEnabled: true, returnWindowDays: 14, autoApproveEnabled: true },
    });
    const map = parseChannelPolicies(json);
    expect(map.pos?.returnEnabled).toBe(false);
    expect(map.b2b?.returnWindowDays).toBe(60);
    expect(map.b2b?.autoApproveEnabled).toBe(false);
    expect(map.draft_order?.autoApproveEnabled).toBe(true);
  });

  it("tolerates malformed JSON by returning empty object", () => {
    expect(parseChannelPolicies("{not json")).toEqual({});
    expect(parseChannelPolicies("undefined")).toEqual({});
    expect(parseChannelPolicies("{")).toEqual({});
    expect(parseChannelPolicies("}}}")).toEqual({});
    expect(parseChannelPolicies("{\"pos\": {")).toEqual({});
  });

  it("returns parsed value as-is for non-object JSON (caller-beware contract)", () => {
    // JSON.parse succeeds on these — the function only catches *parse* errors.
    // Lock in current behavior so any future stricter validation is intentional.
    expect(parseChannelPolicies("null") as unknown).toBeNull();
    expect(parseChannelPolicies("42") as unknown).toBe(42);
  });
});

describe("getChannelPolicy", () => {
  const policies: ChannelPoliciesMap = {
    pos: { returnEnabled: false, returnWindowDays: null, autoApproveEnabled: null },
    b2b: { returnEnabled: true, returnWindowDays: 60, autoApproveEnabled: true },
  };

  it("returns null for null/undefined/empty channel", () => {
    expect(getChannelPolicy(policies, null)).toBeNull();
    expect(getChannelPolicy(policies, undefined)).toBeNull();
    expect(getChannelPolicy(policies, "")).toBeNull();
  });

  it("returns null for the 'web' channel (uses global settings)", () => {
    expect(getChannelPolicy(policies, "web")).toBeNull();
  });

  it("returns the matching channel policy", () => {
    expect(getChannelPolicy(policies, "pos")?.returnEnabled).toBe(false);
    expect(getChannelPolicy(policies, "b2b")?.returnWindowDays).toBe(60);
  });

  it("returns null for channels not present in the policy map", () => {
    expect(getChannelPolicy(policies, "draft_order")).toBeNull();
    expect(getChannelPolicy(policies, "subscription_app")).toBeNull();
  });

  it("returns null on an empty policy map", () => {
    expect(getChannelPolicy({}, "pos")).toBeNull();
  });

  it("type sanity: returned policy fields match ChannelPolicy shape", () => {
    const p: ChannelPolicy | null = getChannelPolicy(policies, "b2b");
    expect(p).not.toBeNull();
    expect(typeof p?.returnEnabled).toBe("boolean");
    // returnWindowDays and autoApproveEnabled may be null OR matching primitive
    expect(["number", "object"]).toContain(typeof p?.returnWindowDays);
    expect(["boolean", "object"]).toContain(typeof p?.autoApproveEnabled);
  });
});
