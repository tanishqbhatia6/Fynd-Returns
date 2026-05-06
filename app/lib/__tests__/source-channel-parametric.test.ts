import { describe, it, expect } from "vitest";
import { normalizeSourceChannel } from "../source-channel.server";

describe("normalizeSourceChannel — parametric", () => {
  describe("nullish / empty inputs return null", () => {
    it.each<[unknown, null]>([
      [null, null],
      [undefined, null],
      ["", null],
    ])("normalizeSourceChannel(%p) === %p", (input, expected) => {
      expect(normalizeSourceChannel(input as string | null | undefined)).toBe(expected);
    });
  });

  describe("known channel mappings", () => {
    it.each<[string, string]>([
      // POS variants
      ["pos", "pos"],
      ["POS", "pos"],
      ["Pos", "pos"],
      ["  pos  ", "pos"],
      ["shopify_pos", "pos"],
      ["SHOPIFY_POS", "pos"],
      ["Shopify_POS", "pos"],
      ["  shopify_pos  ", "pos"],

      // Draft order variants
      ["draft_order", "draft_order"],
      ["DRAFT_ORDER", "draft_order"],
      ["Draft_Order", "draft_order"],
      ["  draft_order  ", "draft_order"],
      ["shopify_draft_order", "draft_order"],
      ["SHOPIFY_DRAFT_ORDER", "draft_order"],
      ["Shopify_Draft_Order", "draft_order"],
      ["\tshopify_draft_order\n", "draft_order"],

      // B2B / Wholesale variants
      ["b2b", "b2b"],
      ["B2B", "b2b"],
      ["B2b", "b2b"],
      ["  b2b  ", "b2b"],
      ["shopify_b2b", "b2b"],
      ["SHOPIFY_B2B", "b2b"],
      ["Shopify_B2B", "b2b"],
      ["wholesale", "b2b"],
      ["WHOLESALE", "b2b"],
      ["WholeSale", "b2b"],

      // Web variants
      ["web", "web"],
      ["WEB", "web"],
      ["Web", "web"],
      ["  web  ", "web"],
      ["online", "web"],
      ["ONLINE", "web"],
      ["Online", "web"],
      ["online_store", "web"],
      ["ONLINE_STORE", "web"],
      ["Online_Store", "web"],
      ["  online_store  ", "web"],
    ])("normalizeSourceChannel(%j) === %j", (input, expected) => {
      expect(normalizeSourceChannel(input)).toBe(expected);
    });
  });

  describe("unknown channels are passed through (lowercased + trimmed)", () => {
    it.each<[string, string]>([
      ["mobile_app", "mobile_app"],
      ["MOBILE_APP", "mobile_app"],
      ["  Mobile_App  ", "mobile_app"],
      ["facebook", "facebook"],
      ["INSTAGRAM", "instagram"],
      ["TikTok", "tiktok"],
      ["custom_channel", "custom_channel"],
      ["api", "api"],
      ["1234", "1234"],
      ["unknown-channel", "unknown-channel"],
      ["  spaced  channel  ", "spaced  channel"],
    ])("normalizeSourceChannel(%j) === %j", (input, expected) => {
      expect(normalizeSourceChannel(input)).toBe(expected);
    });
  });
});
