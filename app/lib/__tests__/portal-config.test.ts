import { describe, it, expect } from "vitest";
import { parsePortalConfig } from "../portal-config.server";

describe("parsePortalConfig", () => {
  it("returns defaults for null", () => {
    const cfg = parsePortalConfig(null);
    expect(cfg.showOrderTracking).toBe(true);
    expect(cfg.showReturnTracking).toBe(true);
    expect(cfg.showCreateReturnTab).toBe(true);
    expect(cfg.defaultTab).toBe("return");
    expect(cfg.allowMediaUploads).toBe(true);
    expect(cfg.allowReturnCancellation).toBe(true);
  });

  it("returns defaults for undefined", () => {
    expect(parsePortalConfig(undefined).defaultTab).toBe("return");
  });

  it("returns defaults for empty / whitespace-only string", () => {
    expect(parsePortalConfig("").showOrderTracking).toBe(true);
    expect(parsePortalConfig("   ").showOrderTracking).toBe(true);
  });

  it("returns defaults for malformed JSON", () => {
    expect(parsePortalConfig("{not json")).toEqual({
      showOrderTracking: true,
      showReturnTracking: true,
      showCreateReturnTab: true,
      defaultTab: "return",
      allowMediaUploads: true,
      allowReturnCancellation: true,
    });
  });

  it("parses valid JSON and honours overrides", () => {
    const cfg = parsePortalConfig(JSON.stringify({
      showOrderTracking: false,
      showCreateReturnTab: false,
      defaultTab: "order",
      allowMediaUploads: false,
      allowReturnCancellation: false,
    }));
    expect(cfg.showOrderTracking).toBe(false);
    expect(cfg.showCreateReturnTab).toBe(false);
    expect(cfg.defaultTab).toBe("order");
    expect(cfg.allowMediaUploads).toBe(false);
    expect(cfg.allowReturnCancellation).toBe(false);
  });

  it("preserves true defaults for keys not present in JSON", () => {
    const cfg = parsePortalConfig(JSON.stringify({ showOrderTracking: false }));
    expect(cfg.showOrderTracking).toBe(false);
    expect(cfg.showReturnTracking).toBe(true); // default kicks in
    expect(cfg.defaultTab).toBe("return");
  });

  it("accepts 'create' as a valid defaultTab", () => {
    expect(parsePortalConfig(JSON.stringify({ defaultTab: "create" })).defaultTab).toBe("create");
  });

  it("falls back to 'return' for invalid defaultTab values", () => {
    expect(parsePortalConfig(JSON.stringify({ defaultTab: "bogus" })).defaultTab).toBe("return");
  });

  it("falls back to 'return' when defaultTab key absent", () => {
    expect(parsePortalConfig(JSON.stringify({})).defaultTab).toBe("return");
  });
});
