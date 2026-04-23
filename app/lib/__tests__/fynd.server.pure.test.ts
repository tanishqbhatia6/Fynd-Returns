import { describe, it, expect, vi } from "vitest";

/* Only test the pure exports — parseShipmentInternalIds, isFyndPrivateUrl,
   getNormalizedCredentialsFromRaw. The network-dependent code
   (fetchFyndPlatformToken, testPlatformConnectionRaw, createFyndClient,
   signFyndUrl) needs a bigger HTTP-mock harness that lives with the Fynd
   integration tests. */

// Stub out encryption so getNormalizedCredentialsFromRaw can exercise the
// decrypt branch without a real ENCRYPTION_KEY.
vi.mock("../encryption.server", () => ({
  decrypt: (s: string) => {
    if (s.startsWith("enc:")) {
      return JSON.stringify({ clientId: "dec_id", clientSecret: "dec_secret" });
    }
    throw new Error("bad ciphertext");
  },
}));

import {
  parseShipmentInternalIds,
  isFyndPrivateUrl,
  getNormalizedCredentialsFromRaw,
} from "../fynd.server";

describe("parseShipmentInternalIds", () => {
  it("returns nulls for null input", () => {
    expect(parseShipmentInternalIds(null)).toEqual({ orderId: null, shipmentId: null });
  });
  it("returns nulls for object with no IDs", () => {
    expect(parseShipmentInternalIds({})).toEqual({ orderId: null, shipmentId: null });
  });
  it("prefers FY-prefixed order_id", () => {
    expect(parseShipmentInternalIds({ order_id: "FY1234567890ABC" }))
      .toEqual({ orderId: "FY1234567890ABC", shipmentId: null });
  });
  it("falls back to numeric order_id", () => {
    expect(parseShipmentInternalIds({ order_id: "1001" }))
      .toEqual({ orderId: "1001", shipmentId: null });
  });
  it("extracts shipment_id from id field", () => {
    expect(parseShipmentInternalIds({ id: "FY9876543210XYZ" }).shipmentId).toBe("FY9876543210XYZ");
  });
  it("prefers FY-shipmentId over numeric when both present", () => {
    // shipment_id field holds a numeric value, id field holds a FY-prefix.
    // findIndex returns the FY one first, so it wins.
    const res = parseShipmentInternalIds({
      shipment_id: "123456",
      id: "FY9876543210XYZ",
    });
    // parseShipmentInternalIds takes the first shipmentRaw which is `id`,
    // so whichever is first in the construction wins.
    expect(res.shipmentId).toBe("FY9876543210XYZ");
  });
  it("trims whitespace from values", () => {
    const res = parseShipmentInternalIds({ order_id: "  1001  " });
    expect(res.orderId).toBe("1001");
  });
  it("uses bag_id as order fallback", () => {
    expect(parseShipmentInternalIds({ bag_id: "B123" }).orderId).toBe("B123");
  });
  it("uses channel_shipment_id as shipment fallback", () => {
    expect(parseShipmentInternalIds({ channel_shipment_id: "CH456" }).shipmentId).toBe("CH456");
  });
});

describe("isFyndPrivateUrl", () => {
  it("returns false for null/undefined/empty", () => {
    expect(isFyndPrivateUrl(null)).toBe(false);
    expect(isFyndPrivateUrl(undefined)).toBe(false);
    expect(isFyndPrivateUrl("")).toBe(false);
  });
  it("recognises storage.googleapis.com private URLs", () => {
    expect(isFyndPrivateUrl("https://storage.googleapis.com/fynd-assets-private-prod/x/y.jpg"))
      .toBe(true);
  });
  it("recognises cdn.fynd.com private URLs", () => {
    expect(isFyndPrivateUrl("https://cdn.fynd.com/private/foo.jpg")).toBe(true);
  });
  it("recognises fynd-*-assets-private URLs", () => {
    expect(isFyndPrivateUrl("https://fynd-prod-assets-private/x")).toBe(true);
  });
  it("returns false for public URLs", () => {
    expect(isFyndPrivateUrl("https://cdn.fynd.com/public/foo.jpg")).toBe(false);
    expect(isFyndPrivateUrl("https://example.com/image.png")).toBe(false);
  });
});

describe("getNormalizedCredentialsFromRaw", () => {
  it("returns null for null/empty input", () => {
    expect(getNormalizedCredentialsFromRaw(null)).toBe(null);
    expect(getNormalizedCredentialsFromRaw("")).toBe(null);
    expect(getNormalizedCredentialsFromRaw("   ")).toBe(null);
  });
  it("parses plaintext JSON credentials", () => {
    const json = JSON.stringify({
      clientId: "cid",
      clientSecret: "csec",
      applicationToken: "atok",
    });
    const creds = getNormalizedCredentialsFromRaw(json);
    expect(creds?.platform).toEqual({ clientId: "cid", clientSecret: "csec" });
    expect(creds?.storefront).toEqual({ applicationToken: "atok" });
  });
  it("parses new nested shape { platform, storefront }", () => {
    const json = JSON.stringify({
      platform: { clientId: "cid2", clientSecret: "csec2" },
      storefront: { applicationToken: "atok2" },
    });
    const creds = getNormalizedCredentialsFromRaw(json);
    expect(creds?.platform?.clientId).toBe("cid2");
    expect(creds?.storefront?.applicationToken).toBe("atok2");
  });
  it("decrypts encrypted credentials (contains colon)", () => {
    // decrypt mock returns the known JSON string when prefix matches.
    const creds = getNormalizedCredentialsFromRaw("enc:somethingsomething");
    expect(creds?.platform).toEqual({ clientId: "dec_id", clientSecret: "dec_secret" });
  });
  it("returns null when decryption fails", () => {
    expect(getNormalizedCredentialsFromRaw("bad:ciphertext")).toBe(null);
  });
  it("returns null for invalid JSON (no colon, not JSON)", () => {
    expect(getNormalizedCredentialsFromRaw("notjson")).toBe(null);
  });
  it("accepts snake_case keys (client_id / client_secret / application_token)", () => {
    const json = JSON.stringify({
      client_id: "sc_id",
      client_secret: "sc_sec",
      application_token: "sc_tok",
    });
    const creds = getNormalizedCredentialsFromRaw(json);
    expect(creds?.platform).toEqual({ clientId: "sc_id", clientSecret: "sc_sec" });
    expect(creds?.storefront?.applicationToken).toBe("sc_tok");
  });
  it("returns empty object when no usable keys present", () => {
    const creds = getNormalizedCredentialsFromRaw(JSON.stringify({ unrelated: "x" }));
    expect(creds).toEqual({});
  });
});
