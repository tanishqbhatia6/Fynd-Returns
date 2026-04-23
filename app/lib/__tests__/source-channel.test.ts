import { describe, it, expect } from "vitest";
import {
  normalizeSourceChannel,
  sourceChannelLabel,
  parseChannelPolicies,
  getChannelPolicy,
} from "../source-channel.server";

describe("normalizeSourceChannel", () => {
  it("returns null for falsy input", () => {
    expect(normalizeSourceChannel(null)).toBe(null);
    expect(normalizeSourceChannel(undefined)).toBe(null);
    expect(normalizeSourceChannel("")).toBe(null);
  });
  it("recognises POS variants", () => {
    expect(normalizeSourceChannel("pos")).toBe("pos");
    expect(normalizeSourceChannel("POS")).toBe("pos");
    expect(normalizeSourceChannel("shopify_pos")).toBe("pos");
  });
  it("recognises draft-order variants", () => {
    expect(normalizeSourceChannel("draft_order")).toBe("draft_order");
    expect(normalizeSourceChannel("shopify_draft_order")).toBe("draft_order");
  });
  it("recognises B2B / wholesale variants", () => {
    expect(normalizeSourceChannel("b2b")).toBe("b2b");
    expect(normalizeSourceChannel("shopify_b2b")).toBe("b2b");
    expect(normalizeSourceChannel("Wholesale")).toBe("b2b");
  });
  it("recognises online-store variants", () => {
    expect(normalizeSourceChannel("web")).toBe("web");
    expect(normalizeSourceChannel("online")).toBe("web");
    expect(normalizeSourceChannel("online_store")).toBe("web");
  });
  it("returns lowercased raw value for unknown channels", () => {
    expect(normalizeSourceChannel("Shopify_POS_Mobile")).toBe("shopify_pos_mobile");
    expect(normalizeSourceChannel("  custom_channel  ")).toBe("custom_channel");
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
  it("returns empty object for missing/invalid JSON", () => {
    expect(parseChannelPolicies(null)).toEqual({});
    expect(parseChannelPolicies("")).toEqual({});
    expect(parseChannelPolicies("{not json")).toEqual({});
  });
  it("parses a valid policy map", () => {
    const json = JSON.stringify({
      pos: { returnEnabled: false, returnWindowDays: null, autoApproveEnabled: null },
      b2b: { returnEnabled: true, returnWindowDays: 60, autoApproveEnabled: false },
    });
    const map = parseChannelPolicies(json);
    expect(map.pos?.returnEnabled).toBe(false);
    expect(map.b2b?.returnWindowDays).toBe(60);
  });
});

describe("getChannelPolicy", () => {
  const policies = {
    pos: { returnEnabled: false, returnWindowDays: null, autoApproveEnabled: null },
    b2b: { returnEnabled: true, returnWindowDays: 60, autoApproveEnabled: false },
  };
  it("returns null for web / default", () => {
    expect(getChannelPolicy(policies, "web")).toBe(null);
  });
  it("returns null for null/undefined channel", () => {
    expect(getChannelPolicy(policies, null)).toBe(null);
    expect(getChannelPolicy(policies, undefined)).toBe(null);
  });
  it("returns the matching policy", () => {
    expect(getChannelPolicy(policies, "pos")?.returnEnabled).toBe(false);
    expect(getChannelPolicy(policies, "b2b")?.returnWindowDays).toBe(60);
  });
  it("returns null for unknown channel not in policies", () => {
    expect(getChannelPolicy(policies, "custom")).toBe(null);
  });
});
