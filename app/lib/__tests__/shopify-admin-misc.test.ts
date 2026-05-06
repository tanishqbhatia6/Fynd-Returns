import { describe, it, expect, vi, beforeEach } from "vitest";

/* Stub observability so tests don't try to talk to a real OTel collector. */
vi.mock("../observability/logger.server", () => ({
  refundLogger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("../observability/tracing.server", () => ({
  withSpan: async <T,>(_name: string, _attrs: unknown, fn: (span: unknown) => Promise<T>) =>
    fn({ setAttribute: () => {}, end: () => {} }),
  addBusinessEvent: vi.fn(),
  startTimer: () => () => 1,
}));
vi.mock("../observability/metrics.server", () => ({
  shopifyApiDuration: { record: vi.fn() },
}));
vi.mock("../observability/resilience.server", () => ({
  shopifyCircuitBreaker: { execute: async <T,>(fn: () => Promise<T>) => fn() },
}));

import {
  fetchAllLocations,
  fetchPrimaryLocationId,
  fetchVariantInfo,
  sendDraftOrderInvoice,
  type AdminGraphQL,
} from "../shopify-admin.server";

/* ─── Helpers ───────────────────────────────────────────────────────── */

type GraphqlCall = { query: string; variables?: Record<string, unknown> };

function makeAdmin(responses: Array<unknown | Error | { status: number; body: unknown }>): {
  admin: AdminGraphQL;
  graphql: ReturnType<typeof vi.fn>;
  calls: GraphqlCall[];
} {
  const calls: GraphqlCall[] = [];
  let i = 0;
  const graphql = vi.fn(async (query: string, opts?: { variables?: Record<string, unknown> }) => {
    calls.push({ query, variables: opts?.variables });
    const r = responses[i++] ?? { data: {} };
    if (r instanceof Error) throw r;
    if (r && typeof r === "object" && "status" in r && "body" in r) {
      return new Response(JSON.stringify((r as { body: unknown }).body), {
        status: (r as { status: number }).status,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(r), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { admin: { graphql } as AdminGraphQL, graphql, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

/* ─── fetchAllLocations ─────────────────────────────────────────────── */

describe("fetchAllLocations", () => {
  it("returns mapped locations with isActive=true by default", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          locations: {
            nodes: [
              { id: "gid://shopify/Location/1", name: "Main", isActive: true },
              { id: "gid://shopify/Location/2", name: "Warehouse", isActive: true },
            ],
          },
        },
      },
    ]);
    const out = await fetchAllLocations(admin);
    expect(out).toHaveLength(2);
    expect(out[0]).toEqual({ id: "gid://shopify/Location/1", name: "Main", isActive: true });
  });

  it("treats missing isActive as active=true", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          locations: {
            nodes: [{ id: "gid://shopify/Location/9", name: "NoFlag" }],
          },
        },
      },
    ]);
    const out = await fetchAllLocations(admin);
    expect(out[0].isActive).toBe(true);
  });

  it("propagates isActive=false (deactivated locations)", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          locations: {
            nodes: [
              { id: "gid://shopify/Location/1", name: "Active", isActive: true },
              { id: "gid://shopify/Location/2", name: "Deactivated", isActive: false },
            ],
          },
        },
      },
    ]);
    const out = await fetchAllLocations(admin);
    const inactive = out.find((l) => l.name === "Deactivated");
    expect(inactive?.isActive).toBe(false);
  });

  it("returns [] when GraphQL surface returns errors", async () => {
    const { admin } = makeAdmin([
      { data: { locations: { nodes: [] } }, errors: [{ message: "missing read_locations scope" }] },
    ]);
    const out = await fetchAllLocations(admin);
    expect(out).toEqual([]);
  });

  it("swallows thrown errors and returns []", async () => {
    const { admin } = makeAdmin([new Error("network down")]);
    const out = await fetchAllLocations(admin);
    expect(out).toEqual([]);
  });

  it("fetchPrimaryLocationId returns first location id", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          locations: {
            nodes: [
              { id: "gid://shopify/Location/1", name: "Main", isActive: true },
              { id: "gid://shopify/Location/2", name: "Other", isActive: true },
            ],
          },
        },
      },
    ]);
    const id = await fetchPrimaryLocationId(admin);
    expect(id).toBe("gid://shopify/Location/1");
  });

  it("fetchPrimaryLocationId returns null when no locations", async () => {
    const { admin } = makeAdmin([{ data: { locations: { nodes: [] } } }]);
    const id = await fetchPrimaryLocationId(admin);
    expect(id).toBeNull();
  });
});

/* ─── fetchVariantInfo ──────────────────────────────────────────────── */

describe("fetchVariantInfo", () => {
  it("returns empty Map when given empty array", async () => {
    const { admin, graphql } = makeAdmin([]);
    const out = await fetchVariantInfo(admin, []);
    expect(out.size).toBe(0);
    expect(graphql).not.toHaveBeenCalled();
  });

  it("filters out empty/invalid ids before querying", async () => {
    const { admin, graphql } = makeAdmin([]);
    const out = await fetchVariantInfo(admin, ["", "   ", null as unknown as string]);
    expect(out.size).toBe(0);
    expect(graphql).not.toHaveBeenCalled();
  });

  it("normalizes numeric ids into ProductVariant gids", async () => {
    const { admin, calls } = makeAdmin([{ data: { nodes: [] } }]);
    await fetchVariantInfo(admin, ["12345"]);
    const ids = (calls[0].variables as { ids: string[] }).ids;
    expect(ids).toEqual(["gid://shopify/ProductVariant/12345"]);
  });

  it("preserves already-formed gids", async () => {
    const { admin, calls } = makeAdmin([{ data: { nodes: [] } }]);
    await fetchVariantInfo(admin, ["gid://shopify/ProductVariant/99"]);
    const ids = (calls[0].variables as { ids: string[] }).ids;
    expect(ids).toEqual(["gid://shopify/ProductVariant/99"]);
  });

  it("maps full variant payload into ShopifyVariantInfo", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          nodes: [
            {
              id: "gid://shopify/ProductVariant/1",
              sku: "SKU-1",
              title: "M / Blue",
              availableForSale: true,
              inventoryQuantity: 7,
              inventoryPolicy: "DENY",
              inventoryItem: { tracked: true },
              price: "29.99",
              compareAtPrice: "39.99",
              image: { url: "https://cdn/img.jpg" },
              product: {
                id: "gid://shopify/Product/10",
                title: "Tee",
                featuredImage: { url: "https://cdn/feat.jpg" },
              },
            },
          ],
        },
      },
    ]);
    const out = await fetchVariantInfo(admin, ["gid://shopify/ProductVariant/1"]);
    const info = out.get("gid://shopify/ProductVariant/1");
    expect(info).toBeDefined();
    expect(info?.sku).toBe("SKU-1");
    expect(info?.productTitle).toBe("Tee");
    expect(info?.variantTitle).toBe("M / Blue");
    expect(info?.price).toBe("29.99");
    expect(info?.compareAtPrice).toBe("39.99");
    expect(info?.inventoryAvailable).toBe(7);
    expect(info?.availableForSale).toBe(true);
    expect(info?.imageUrl).toBe("https://cdn/img.jpg");
  });

  it("falls back to product featuredImage when variant image missing", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          nodes: [
            {
              id: "gid://shopify/ProductVariant/2",
              sku: null,
              title: null,
              availableForSale: false,
              inventoryQuantity: 0,
              inventoryItem: { tracked: true },
              price: "10.00",
              image: null,
              product: { id: "gid://shopify/Product/2", title: "P", featuredImage: { url: "https://cdn/p.jpg" } },
            },
          ],
        },
      },
    ]);
    const out = await fetchVariantInfo(admin, ["gid://shopify/ProductVariant/2"]);
    expect(out.get("gid://shopify/ProductVariant/2")?.imageUrl).toBe("https://cdn/p.jpg");
  });

  it("returns inventoryAvailable=null when inventoryItem.tracked is false", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          nodes: [
            {
              id: "gid://shopify/ProductVariant/3",
              sku: "X",
              title: "x",
              availableForSale: true,
              inventoryQuantity: 100,
              inventoryItem: { tracked: false },
              price: "1.00",
              image: null,
              product: { id: "gid://shopify/Product/3", title: "P3" },
            },
          ],
        },
      },
    ]);
    const out = await fetchVariantInfo(admin, ["gid://shopify/ProductVariant/3"]);
    expect(out.get("gid://shopify/ProductVariant/3")?.inventoryAvailable).toBeNull();
  });

  it("skips null nodes from the response", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          nodes: [
            null,
            {
              id: "gid://shopify/ProductVariant/5",
              availableForSale: true,
              inventoryItem: { tracked: true },
              inventoryQuantity: 1,
              price: "5.00",
              product: { id: "gid://shopify/Product/5", title: "P5" },
            },
          ],
        },
      },
    ]);
    const out = await fetchVariantInfo(admin, ["a", "b"]);
    expect(out.size).toBe(1);
    expect(out.has("gid://shopify/ProductVariant/5")).toBe(true);
  });

  it("returns empty Map on non-OK HTTP response", async () => {
    const { admin } = makeAdmin([{ status: 500, body: { errors: [{ message: "boom" }] } }]);
    const out = await fetchVariantInfo(admin, ["1"]);
    expect(out.size).toBe(0);
  });

  it("returns empty Map on thrown error", async () => {
    const { admin } = makeAdmin([new Error("timeout")]);
    const out = await fetchVariantInfo(admin, ["1"]);
    expect(out.size).toBe(0);
  });

  it("logs but still returns parsed data when GraphQL errors are present", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          nodes: [
            {
              id: "gid://shopify/ProductVariant/7",
              availableForSale: true,
              inventoryItem: { tracked: true },
              inventoryQuantity: 2,
              price: "2.00",
              product: { id: "gid://shopify/Product/7", title: "P7" },
            },
          ],
        },
        errors: [{ message: "throttled" }],
      },
    ]);
    const out = await fetchVariantInfo(admin, ["7"]);
    expect(out.size).toBe(1);
  });
});

/* ─── sendDraftOrderInvoice ─────────────────────────────────────────── */

describe("sendDraftOrderInvoice", () => {
  it("sends invoice and returns invoiceUrl on success", async () => {
    const { admin, calls } = makeAdmin([
      {
        data: {
          draftOrderInvoiceSend: {
            draftOrder: {
              id: "gid://shopify/DraftOrder/1",
              name: "#D1",
              invoiceUrl: "https://shop/invoice/abc",
            },
            userErrors: [],
          },
        },
      },
    ]);
    const out = await sendDraftOrderInvoice(
      admin,
      "gid://shopify/DraftOrder/1",
      "buyer@example.com",
    );
    expect(out.success).toBe(true);
    expect(out.invoiceUrl).toBe("https://shop/invoice/abc");
    const vars = calls[0].variables as { id: string; email: { to: string; subject: string; customMessage: string } | null };
    expect(vars.id).toBe("gid://shopify/DraftOrder/1");
    expect(vars.email?.to).toBe("buyer@example.com");
    expect(vars.email?.subject).toBe("Complete your exchange");
  });

  it("uses custom subject and bodyMessage when provided", async () => {
    const { admin, calls } = makeAdmin([
      {
        data: {
          draftOrderInvoiceSend: {
            draftOrder: { id: "gid://shopify/DraftOrder/2", name: "#D2", invoiceUrl: null },
            userErrors: [],
          },
        },
      },
    ]);
    await sendDraftOrderInvoice(
      admin,
      "gid://shopify/DraftOrder/2",
      "x@y.z",
      "Custom Subject",
      "Custom Body",
    );
    const vars = calls[0].variables as { email: { subject: string; customMessage: string } };
    expect(vars.email.subject).toBe("Custom Subject");
    expect(vars.email.customMessage).toBe("Custom Body");
  });

  it("passes email=null when customer email is missing", async () => {
    const { admin, calls } = makeAdmin([
      {
        data: {
          draftOrderInvoiceSend: {
            draftOrder: { id: "gid://shopify/DraftOrder/3", name: "#D3", invoiceUrl: "https://x" },
            userErrors: [],
          },
        },
      },
    ]);
    const out = await sendDraftOrderInvoice(admin, "gid://shopify/DraftOrder/3", null);
    expect(out.success).toBe(true);
    const vars = calls[0].variables as { email: unknown };
    expect(vars.email).toBeNull();
  });

  it("falls back to error when userErrors are returned", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          draftOrderInvoiceSend: {
            draftOrder: null,
            userErrors: [{ field: ["email"], message: "Email is invalid" }],
          },
        },
      },
    ]);
    const out = await sendDraftOrderInvoice(admin, "gid://shopify/DraftOrder/4", "bad");
    expect(out.success).toBe(false);
    expect(out.error).toContain("Email is invalid");
  });

  it("returns success=false when top-level GraphQL errors are present", async () => {
    const { admin } = makeAdmin([{ errors: [{ message: "ACCESS_DENIED" }] }]);
    const out = await sendDraftOrderInvoice(admin, "gid://shopify/DraftOrder/5", "x@y.z");
    expect(out.success).toBe(false);
    expect(out.error).toContain("ACCESS_DENIED");
  });

  it("returns invoiceUrl=null when the draftOrder has no invoiceUrl", async () => {
    const { admin } = makeAdmin([
      {
        data: {
          draftOrderInvoiceSend: {
            draftOrder: { id: "gid://shopify/DraftOrder/6", name: "#D6", invoiceUrl: null },
            userErrors: [],
          },
        },
      },
    ]);
    const out = await sendDraftOrderInvoice(admin, "gid://shopify/DraftOrder/6", "ok@e.com");
    expect(out.success).toBe(true);
    expect(out.invoiceUrl).toBeNull();
  });

  it("returns success=false when admin.graphql throws", async () => {
    const { admin } = makeAdmin([new Error("network failure")]);
    const out = await sendDraftOrderInvoice(admin, "gid://shopify/DraftOrder/7", "x@y.z");
    expect(out.success).toBe(false);
    expect(out.error).toContain("network failure");
  });
});
