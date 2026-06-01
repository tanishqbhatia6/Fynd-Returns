import { describe, expect, it, vi } from "vitest";
import {
  SHOPIFY_FRAME_CONTEXT_STORAGE_KEY,
  addShopifyFrameContext,
  getSafeAppPathFromReferrer,
  getShopifyFrameContextSearch,
  readShopifyFrameContext,
  writeShopifyFrameContext,
} from "../shopify-frame-context";

describe("shopify frame context helpers", () => {
  it("extracts the embedded Shopify params needed for document auth", () => {
    expect(
      getShopifyFrameContextSearch(
        "?shop=test-shop.myshopify.com&host=YWJjMTIz&embedded=1&status=pending",
      ),
    ).toBe("shop=test-shop.myshopify.com&host=YWJjMTIz&embedded=1");
  });

  it("adds embedded=1 when Shopify context is otherwise valid", () => {
    expect(getShopifyFrameContextSearch("?shop=test.myshopify.com&host=abc_123")).toBe(
      "shop=test.myshopify.com&host=abc_123&embedded=1",
    );
  });

  it("rejects malformed shop or host values", () => {
    expect(getShopifyFrameContextSearch("?shop=evil.com&host=abc")).toBeNull();
    expect(getShopifyFrameContextSearch("?shop=test.myshopify.com&host=bad host")).toBeNull();
  });

  it("merges Shopify context into app paths without overwriting page filters", () => {
    const context = "shop=test.myshopify.com&host=abc&embedded=1";
    expect(addShopifyFrameContext("/app/returns?status=pending", context)).toBe(
      "/app/returns?status=pending&shop=test.myshopify.com&host=abc&embedded=1",
    );
  });

  it("does not add Shopify context to non-admin paths", () => {
    expect(addShopifyFrameContext("/apps/returns", "shop=test.myshopify.com&host=abc")).toBe(
      "/apps/returns",
    );
  });

  it("reads and writes valid context from storage defensively", () => {
    const storage = new Map<string, string>();
    const shim = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    };

    writeShopifyFrameContext(shim, "shop=test.myshopify.com&host=abc&embedded=1");
    expect(storage.get(SHOPIFY_FRAME_CONTEXT_STORAGE_KEY)).toBe(
      "shop=test.myshopify.com&host=abc&embedded=1",
    );
    expect(readShopifyFrameContext(shim)).toBe("shop=test.myshopify.com&host=abc&embedded=1");
  });

  it("swallows blocked storage errors", () => {
    const storage = {
      getItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      setItem: vi.fn(() => {
        throw new Error("blocked");
      }),
    };

    expect(readShopifyFrameContext(storage)).toBeNull();
    expect(() =>
      writeShopifyFrameContext(storage, "shop=test.myshopify.com&host=abc"),
    ).not.toThrow();
  });

  it("accepts only same-origin /app referrers for recovery", () => {
    expect(
      getSafeAppPathFromReferrer("https://app.example/app/returns?id=1", "https://app.example"),
    ).toBe("/app/returns?id=1");
    expect(
      getSafeAppPathFromReferrer("https://evil.example/app/returns", "https://app.example"),
    ).toBeNull();
    expect(
      getSafeAppPathFromReferrer("https://app.example/apps/returns", "https://app.example"),
    ).toBeNull();
  });
});
