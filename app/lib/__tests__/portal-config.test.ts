/**
 * Tests for portal-config.server.ts: parsing the merchant-controlled portal
 * configuration JSON. The portal route relies on these defaults — a regression
 * here can hide tabs or flip the default landing tab unexpectedly.
 */
import { describe, it, expect } from "vitest";
import { parsePortalConfig } from "../portal-config.server";

const FULL_DEFAULT = {
  showOrderTracking: true,
  showReturnTracking: true,
  showCreateReturnTab: true,
  defaultTab: "return" as const,
  allowMediaUploads: true,
  allowReturnCancellation: true,
};

describe("parsePortalConfig", () => {
  it("returns defaults for null", () => {
    expect(parsePortalConfig(null)).toEqual(FULL_DEFAULT);
  });

  it("returns defaults for undefined", () => {
    expect(parsePortalConfig(undefined)).toEqual(FULL_DEFAULT);
  });

  it("returns defaults for an empty string", () => {
    expect(parsePortalConfig("")).toEqual(FULL_DEFAULT);
  });

  it("returns defaults for a whitespace-only string", () => {
    expect(parsePortalConfig("   \n\t ")).toEqual(FULL_DEFAULT);
  });

  it("returns defaults for malformed JSON", () => {
    expect(parsePortalConfig("{not json")).toEqual(FULL_DEFAULT);
  });

  it("returns defaults when JSON.parse throws on truncated input", () => {
    expect(parsePortalConfig('{"showOrderTracking": fals')).toEqual(FULL_DEFAULT);
  });

  it("returns defaults for an empty JSON object", () => {
    expect(parsePortalConfig("{}")).toEqual(FULL_DEFAULT);
  });

  it("parses a fully-specified config with every flag flipped to false", () => {
    const json = JSON.stringify({
      showOrderTracking: false,
      showReturnTracking: false,
      showCreateReturnTab: false,
      defaultTab: "order",
      allowMediaUploads: false,
      allowReturnCancellation: false,
    });
    expect(parsePortalConfig(json)).toEqual({
      showOrderTracking: false,
      showReturnTracking: false,
      showCreateReturnTab: false,
      defaultTab: "order",
      allowMediaUploads: false,
      allowReturnCancellation: false,
    });
  });

  it("fills in defaults for a partial config (only one key set)", () => {
    const cfg = parsePortalConfig(JSON.stringify({ showOrderTracking: false }));
    expect(cfg).toEqual({ ...FULL_DEFAULT, showOrderTracking: false });
  });

  it("respects explicit false rather than substituting true defaults", () => {
    const cfg = parsePortalConfig(
      JSON.stringify({ allowMediaUploads: false, allowReturnCancellation: false }),
    );
    expect(cfg.allowMediaUploads).toBe(false);
    expect(cfg.allowReturnCancellation).toBe(false);
    // Untouched flags keep their defaults.
    expect(cfg.showOrderTracking).toBe(true);
    expect(cfg.defaultTab).toBe("return");
  });

  it("accepts each valid defaultTab value", () => {
    expect(parsePortalConfig(JSON.stringify({ defaultTab: "order" })).defaultTab).toBe("order");
    expect(parsePortalConfig(JSON.stringify({ defaultTab: "return" })).defaultTab).toBe("return");
    expect(parsePortalConfig(JSON.stringify({ defaultTab: "create" })).defaultTab).toBe("create");
  });

  it("falls back to 'return' for an invalid defaultTab", () => {
    expect(parsePortalConfig(JSON.stringify({ defaultTab: "wishlist" })).defaultTab).toBe("return");
  });

  it("falls back to 'return' when defaultTab is an empty string", () => {
    expect(parsePortalConfig(JSON.stringify({ defaultTab: "" })).defaultTab).toBe("return");
  });

  it("ignores unknown extra keys and still returns a valid PortalConfig", () => {
    const json = JSON.stringify({
      showOrderTracking: false,
      bogusKey: "ignore me",
      anotherJunk: 123,
    });
    const cfg = parsePortalConfig(json);
    expect(cfg).toEqual({ ...FULL_DEFAULT, showOrderTracking: false });
    expect((cfg as Record<string, unknown>).bogusKey).toBeUndefined();
  });

  it("returns defaults for the JSON 'null' literal (no fields to spread)", () => {
    // JSON.parse("null") yields null; the implementation falls through
    // to defaults via the ?? operator on each key.
    expect(parsePortalConfig("null")).toEqual(FULL_DEFAULT);
  });
});
