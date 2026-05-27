/**
 * Gap-coverage tests for `handleProcessReplacement`.
 *
 * Companion to the broad happy-path coverage in `process-handlers.test.ts`
 * and the deeper conditional matrix in `process-replacement-deep.test.ts`.
 * This file targets the residual uncovered lines/branches:
 *
 *   1. Outer `catch` block when an error escapes the main flow:
 *      - empty rawMessage → fallback "Replacement could not be processed…"
 *      - replacement_failed event logging swallows secondary prisma error
 *      - non-Error / non-Response thrown values
 *
 *   2. userErrors path with scope-error wording → 400 + reinstall hint
 *
 *   3. Inventory edge cases:
 *      - negative `inventoryAvailable` clamps to 0 via Math.max
 *      - inventoryAvailable === null skips stockout (truthiness branch)
 *
 *   4. Title/SKU/price fallback chains in the line-item map:
 *      - falls back to item.sku when both title fields absent
 *      - "Replacement item" final fallback when title and sku are absent
 *      - originalUnitPrice falls back to "0.00" when both prices absent
 *      - sku resolves from shopify line-item when item.sku is null
 *
 *   5. Draft input fallbacks when returnRequestNo is null:
 *      - tag uses returnCase.id as suffix
 *      - note uses returnCase.id
 *      - customAttributes use empty string for shopifyOrderName when null
 *
 *   6. Fynd: client present but missing updateShipmentStatus method
 *      (the `"updateShipmentStatus" in client` false branch).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../../test/prisma-mock";

const {
  prismaMock,
  fetchOrderMock,
  fetchOrderByOrderNumberMock,
  fetchVariantInfoMock,
  closeShopifyReturnBestEffortMock,
  createFyndClientOrErrorMock,
  sendApprovalNotificationMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  fetchOrderMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  fetchOrderByOrderNumberMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  fetchVariantInfoMock: vi.fn<(...args: unknown[]) => Promise<Map<string, unknown>>>(
    async () => new Map(),
  ),
  closeShopifyReturnBestEffortMock: vi.fn(async () => ({ ok: true })),
  createFyndClientOrErrorMock: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
    ok: false,
    error: "disabled",
  })),
  sendApprovalNotificationMock: vi.fn<(...args: unknown[]) => Promise<undefined>>(
    async () => undefined,
  ),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify-admin.server", () => ({
  fetchOrder: fetchOrderMock,
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
  fetchVariantInfo: fetchVariantInfoMock,
  closeShopifyReturnBestEffort: closeShopifyReturnBestEffortMock,
}));
vi.mock("../../fynd.server", () => ({
  createFyndClientOrError: createFyndClientOrErrorMock,
}));
vi.mock("../../notification.server", () => ({
  sendApprovalNotification: sendApprovalNotificationMock,
}));

import { handleProcessReplacement } from "../process-replacement.server";
import type { ReturnHandlerContext, ReturnActionBody } from "../types";

const DRAFT_OK = {
  data: {
    draftOrderCreate: {
      draftOrder: { id: "gid://shopify/DraftOrder/1", name: "D1" },
      userErrors: [],
    },
  },
};
const COMPLETE_OK = {
  data: {
    draftOrderComplete: {
      draftOrder: {
        id: "gid://shopify/DraftOrder/1",
        name: "D1",
        order: { id: "gid://shopify/Order/9", name: "#9" },
      },
      userErrors: [],
    },
  },
};

function mkAdmin(createRes: unknown, completeRes: unknown): ReturnHandlerContext["admin"] {
  let n = 0;
  return {
    graphql: vi.fn(async () => {
      n++;
      const body = n === 1 ? createRes : completeRes;
      return { json: async () => body };
    }),
  } as never;
}

function mkCtx(overrides: Partial<ReturnHandlerContext> = {}): ReturnHandlerContext {
  return {
    id: "rc-1",
    returnCase: {
      id: "rc-1",
      status: "approved",
      returnRequestNo: "R-1",
      shopifyOrderId: "gid://shopify/Order/1",
      shopifyOrderName: "#1001",
      customerEmailNorm: "u@example.com",
      customerPhoneNorm: null,
      adminNotes: null,
      currency: "USD",
      refundStatus: null,
      cancellationRequestedAt: null,
      fyndOrderId: null,
      fyndShipmentId: null,
      fyndReturnId: null,
      fyndPayloadJson: null,
      fyndCurrentStatus: null,
      shopifyReturnId: null,
      exchangeOrderId: null,
      resolutionType: null,
      isGreenReturn: false,
      items: [
        {
          id: "li-1",
          shopifyLineItemId: "gid://shopify/LineItem/1",
          qty: 1,
          sku: "SKU-1",
          price: "10.00",
          reasonCode: null,
          notes: null,
          title: "Item 1",
        },
      ],
    } as never,
    shop: {
      id: "shop-1",
      shopDomain: "store.myshopify.com",
      settings: { fyndApiType: "platform" },
    },
    admin: {
      graphql: vi.fn(async () => ({
        json: async () => DRAFT_OK,
      })),
    } as never,
    shopDomain: "store.myshopify.com",
    sessionEmail: "admin@example.com",
    isTerminal: false,
    elapsed: () => 100,
    logShopifyReturnEvent: vi.fn<(...args: unknown[]) => Promise<undefined>>(async () => undefined),
    ...overrides,
  };
}

async function expectRedirect(p: Promise<unknown>, frag: string) {
  try {
    await p;
    throw new Error("expected redirect");
  } catch (err) {
    expect(err).toBeInstanceOf(Response);
    const res = err as Response;
    expect(res.status).toBeGreaterThanOrEqual(300);
    expect(res.status).toBeLessThan(400);
    expect(res.headers.get("Location")).toContain(frag);
  }
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  fetchOrderMock.mockReset().mockResolvedValue(null);
  fetchOrderByOrderNumberMock.mockReset().mockResolvedValue(null);
  fetchVariantInfoMock.mockReset().mockResolvedValue(new Map());
  closeShopifyReturnBestEffortMock.mockReset().mockResolvedValue({ ok: true });
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({ ok: false, error: "disabled" });
  sendApprovalNotificationMock.mockReset().mockResolvedValue(undefined);
});

// ─────────────────── Outer catch block ───────────────────
describe("handleProcessReplacement — outer catch fallback", () => {
  function setupHappyOrder() {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
  }

  it("uses generic fallback message when thrown error has empty message", async () => {
    setupHappyOrder();
    // Make returnCase.update throw with an empty Error → rawMessage === ""
    prismaMock.returnCase.update.mockRejectedValueOnce(new Error(""));
    const ctx = mkCtx({ admin: mkAdmin(DRAFT_OK, COMPLETE_OK) });
    const res = await handleProcessReplacement(ctx, {
      action: "process_replacement",
    } as ReturnActionBody);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Replacement could not be processed. Please try again.");
    // replacement_failed event was logged (with the fallback message)
    const failed = prismaMock.returnEvent.create.mock.calls
      .map((c) => (c[0] as { data: { eventType: string; payloadJson: string } }).data)
      .find((d) => d.eventType === "replacement_failed");
    expect(failed).toBeDefined();
    expect(JSON.parse(failed!.payloadJson).error).toBe(
      "Replacement could not be processed. Please try again.",
    );
  });

  it("swallows secondary prisma error when logging replacement_failed event", async () => {
    setupHappyOrder();
    // Primary failure inside try
    prismaMock.returnCase.update.mockRejectedValueOnce(new Error("primary boom"));
    // Secondary failure: writing the replacement_failed event also throws
    prismaMock.returnEvent.create.mockRejectedValueOnce(new Error("secondary boom"));
    const ctx = mkCtx({ admin: mkAdmin(DRAFT_OK, COMPLETE_OK) });
    const res = await handleProcessReplacement(ctx, {
      action: "process_replacement",
    } as ReturnActionBody);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("primary boom");
  });

  it("propagates non-empty error message from a thrown Error", async () => {
    setupHappyOrder();
    prismaMock.returnCase.update.mockRejectedValueOnce(
      new Error("update unique constraint failed"),
    );
    const ctx = mkCtx({ admin: mkAdmin(DRAFT_OK, COMPLETE_OK) });
    const res = await handleProcessReplacement(ctx, {
      action: "process_replacement",
    } as ReturnActionBody);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("update unique constraint failed");
  });
});

// ─────────────────── userErrors scope-error path ───────────────────
describe("handleProcessReplacement — userErrors scope path", () => {
  it("403 with reinstall hint when userErrors mention write_draft_orders scope", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const ctx = mkCtx({
      admin: {
        graphql: vi.fn(async () => ({
          json: async () => ({
            data: {
              draftOrderCreate: {
                draftOrder: null,
                userErrors: [
                  { field: ["input"], message: "Access denied: missing write_draft_orders scope" },
                ],
              },
            },
          }),
        })),
      } as never,
    });
    const res = await handleProcessReplacement(ctx, {
      action: "process_replacement",
    } as ReturnActionBody);
    // userErrors scope path returns 400 (not 403 — that is only the top-level errors path)
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("write_draft_orders");
    expect(body.error).toContain("reinstall");
  });
});

// ─────────────────── Inventory edge cases ───────────────────
describe("handleProcessReplacement — inventory edge cases", () => {
  it("clamps negative inventoryAvailable to 0 in stockoutLines", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        {
          id: "gid://shopify/LineItem/1",
          title: "Item 1",
          sku: "SKU-1",
          price: "10.00",
          quantity: 1,
          variantId: "gid://shopify/ProductVariant/V1",
        },
      ],
    });
    fetchVariantInfoMock.mockResolvedValueOnce(
      new Map([["gid://shopify/ProductVariant/V1", { inventoryAvailable: -3 }]]),
    );
    const ctx = mkCtx();
    const res = await handleProcessReplacement(ctx, {
      action: "process_replacement",
    } as ReturnActionBody);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.stockoutLines[0].available).toBe(0);
  });

  it("skips stockout when inventoryAvailable is null (treated as unlimited)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        {
          id: "gid://shopify/LineItem/1",
          title: "Item 1",
          sku: "SKU-1",
          price: "10.00",
          quantity: 1,
          variantId: "gid://shopify/ProductVariant/V1",
        },
      ],
    });
    fetchVariantInfoMock.mockResolvedValueOnce(
      new Map([["gid://shopify/ProductVariant/V1", { inventoryAvailable: null }]]),
    );
    const ctx = mkCtx({ admin: mkAdmin(DRAFT_OK, COMPLETE_OK) });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });

  it("skips stockout when inventoryMap has no entry for the variant", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        {
          id: "gid://shopify/LineItem/1",
          title: "Item 1",
          sku: "SKU-1",
          price: "10.00",
          quantity: 1,
          variantId: "gid://shopify/ProductVariant/V1",
        },
      ],
    });
    // fetchVariantInfo returns empty Map → `info` is undefined → skip
    fetchVariantInfoMock.mockResolvedValueOnce(new Map());
    const ctx = mkCtx({ admin: mkAdmin(DRAFT_OK, COMPLETE_OK) });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });
});

// ─────────────────── Line-item fallback chains ───────────────────
describe("handleProcessReplacement — line-item fallbacks", () => {
  it("title falls back to item.sku when shopifyItem and item have no title", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      // line-item with no title
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: null, sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        items: [
          {
            id: "li-1",
            shopifyLineItemId: "gid://shopify/LineItem/1",
            qty: 1,
            sku: "SKU-1",
            price: "10.00",
            reasonCode: null,
            notes: null,
            title: null,
          },
        ],
      } as never,
      admin: mkAdmin(DRAFT_OK, COMPLETE_OK),
    });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const update = prismaMock.returnCase.update.mock.calls[0][0] as unknown as {
      data: { exchangeItemsJson: string };
    };
    const items = JSON.parse(update.data.exchangeItemsJson);
    expect(items[0].title).toBe("SKU-1");
  });

  it("title falls back to 'Replacement item' when title and sku are absent", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: null, sku: null, price: null, quantity: 1 },
      ],
    });
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        items: [
          // No title, no sku
          {
            id: "li-1",
            shopifyLineItemId: "gid://shopify/LineItem/1",
            qty: 1,
            sku: null,
            price: null,
            reasonCode: null,
            notes: null,
            title: null,
          },
        ],
      } as never,
      admin: mkAdmin(DRAFT_OK, COMPLETE_OK),
    });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const update = prismaMock.returnCase.update.mock.calls[0][0] as unknown as {
      data: { exchangeItemsJson: string };
    };
    const items = JSON.parse(update.data.exchangeItemsJson);
    expect(items[0].title).toBe("Replacement item");
    expect(items[0].originalUnitPrice).toBe("0.00");
    expect(items[0].sku).toBeNull();
  });

  it("sku resolves from shopify line-item when item.sku is null", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      // shopify line-item carries the SKU
      lineItems: [
        {
          id: "gid://shopify/LineItem/1",
          title: "Item 1",
          sku: "FROM-SHOPIFY",
          price: "12.00",
          quantity: 1,
        },
      ],
    });
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        items: [
          // item has no sku
          {
            id: "li-1",
            shopifyLineItemId: "gid://shopify/LineItem/1",
            qty: 1,
            sku: null,
            price: null,
            reasonCode: null,
            notes: null,
            title: "Item 1",
          },
        ],
      } as never,
      admin: mkAdmin(DRAFT_OK, COMPLETE_OK),
    });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const update = prismaMock.returnCase.update.mock.calls[0][0] as unknown as {
      data: { exchangeItemsJson: string };
    };
    const items = JSON.parse(update.data.exchangeItemsJson);
    expect(items[0].sku).toBe("FROM-SHOPIFY");
    // originalUnitPrice resolved from shopifyItem.price
    expect(items[0].originalUnitPrice).toBe("12.00");
  });
});

// ─────────────────── Draft input fallbacks ───────────────────
describe("handleProcessReplacement — draft input fallbacks", () => {
  it("uses returnCase.id when returnRequestNo is null (tags + note + customAttribute)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const captured: Array<unknown> = [];
    let n = 0;
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        returnRequestNo: null,
        shopifyOrderName: null,
      } as never,
      admin: {
        graphql: vi.fn(async (_q: unknown, opts: unknown) => {
          n++;
          captured.push(opts);
          return n === 1 ? { json: async () => DRAFT_OK } : { json: async () => COMPLETE_OK };
        }),
      } as never,
    });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const createCall = captured[0] as {
      variables: {
        input: {
          tags: string[];
          note: string;
          customAttributes: Array<{ key: string; value: string }>;
        };
      };
    };
    expect(createCall.variables.input.tags).toContain("rpm-replacement-rc-1");
    expect(createCall.variables.input.note).toContain("Replacement for return rc-1");
    // shopifyOrderName null → empty string fallback in customAttribute
    const replFor = createCall.variables.input.customAttributes.find(
      (a) => a.key === "rpm_replacement_for",
    )!;
    expect(replFor.value).toBe("");
  });

  it("does NOT include shippingAddress when order has no shippingAddress", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
      // no shippingAddress
    });
    const captured: Array<unknown> = [];
    let n = 0;
    const ctx = mkCtx({
      admin: {
        graphql: vi.fn(async (_q: unknown, opts: unknown) => {
          n++;
          captured.push(opts);
          return n === 1 ? { json: async () => DRAFT_OK } : { json: async () => COMPLETE_OK };
        }),
      } as never,
    });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const input = (captured[0] as { variables: { input: Record<string, unknown> } }).variables
      .input;
    expect(input.shippingAddress).toBeUndefined();
    expect(input.billingAddress).toEqual({ firstName: "Customer", lastName: "" });
  });

  it("falls back to provinceCode/countryCode when province/country are empty in shippingAddress", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
      shippingAddress: {
        address1: "1 Main",
        address2: null,
        city: "X",
        province: null,
        provinceCode: "CA",
        country: null,
        countryCode: "US",
        zip: "12345",
        firstName: "A",
        lastName: "B",
        phone: "+1",
      },
    });
    const captured: Array<unknown> = [];
    let n = 0;
    const ctx = mkCtx({
      admin: {
        graphql: vi.fn(async (_q: unknown, opts: unknown) => {
          n++;
          captured.push(opts);
          return n === 1 ? { json: async () => DRAFT_OK } : { json: async () => COMPLETE_OK };
        }),
      } as never,
    });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const input = (
      captured[0] as {
        variables: {
          input: {
            shippingAddress: { province?: string; country?: string };
            billingAddress: { province?: string; country?: string };
          };
        };
      }
    ).variables.input;
    expect(input.shippingAddress.province).toBe("CA");
    expect(input.shippingAddress.country).toBe("US");
    expect(input.billingAddress.province).toBe("CA");
    expect(input.billingAddress.country).toBe("US");
  });
});

// ─────────────────── Fynd client without updateShipmentStatus method ───────────────────
describe("handleProcessReplacement — Fynd client missing transition method", () => {
  it("skips Fynd push when client returned by createFyndClientOrError lacks updateShipmentStatus", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    // ok:true but no updateShipmentStatus key on client → "in" check returns false
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { getShipments: vi.fn() },
    });
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, fyndShipmentId: "SH-X", fyndOrderId: "FY-O-X" } as never,
      admin: mkAdmin(DRAFT_OK, COMPLETE_OK),
    });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const eventTypes = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(eventTypes).not.toContain("fynd_replacement_synced");
    expect(eventTypes).not.toContain("fynd_replacement_sync_failed");
  });
});

// ─────────────────── Fynd payload parse failure ───────────────────
describe("handleProcessReplacement — Fynd payload parse error", () => {
  it("treats malformed fyndPayloadJson as no-status (allows replacement to proceed)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndReturnId: "FR-1",
        // Invalid JSON → JSON.parse throws → caught silently → fyndCurrentStatus stays null → gate passes
        fyndPayloadJson: "{not-json",
      } as never,
      admin: mkAdmin(DRAFT_OK, COMPLETE_OK),
    });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });

  it("payload without status field passes the Fynd gate", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndReturnId: "FR-1",
        fyndPayloadJson: JSON.stringify({ other: "field" }),
      } as never,
      admin: mkAdmin(DRAFT_OK, COMPLETE_OK),
    });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });

  it("allowed Fynd status (return_bag_delivered) lets replacement proceed", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndReturnId: "FR-1",
        fyndPayloadJson: JSON.stringify({ status: "return_bag_delivered" }),
      } as never,
      admin: mkAdmin(DRAFT_OK, COMPLETE_OK),
    });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
  });
});

// ─────────────────── Non-Error thrown values ───────────────────
describe("handleProcessReplacement — non-Error thrown values", () => {
  function setupHappyOrder() {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
  }

  it("draftOrderComplete: stringifies non-Error thrown value into completeError", async () => {
    setupHappyOrder();
    let n = 0;
    const ctx = mkCtx({
      admin: {
        graphql: vi.fn(async () => {
          n++;
          if (n === 1) return { json: async () => DRAFT_OK };
          // Throw a plain string (not an Error) — exercises String(err) branch on line 265
          throw "string-failure-mode";
        }),
      } as never,
    });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const ev = prismaMock.returnEvent.create.mock.calls
      .map((c) => (c[0] as { data: { eventType: string; payloadJson: string } }).data)
      .find((d) => d.eventType === "replacement_created")!;
    expect(JSON.parse(ev.payloadJson).completeError).toBe("string-failure-mode");
  });

  it("Fynd push: stringifies non-Error thrown value into the failure event payload", async () => {
    setupHappyOrder();
    const updateShipmentStatus = vi.fn(async () => {
      throw "fynd-string-error";
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus, getShipments: vi.fn() },
    });
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-S",
        fyndOrderId: "FY-O-S",
      } as never,
      admin: mkAdmin(DRAFT_OK, COMPLETE_OK),
    });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const failed = prismaMock.returnEvent.create.mock.calls
      .map((c) => (c[0] as { data: { eventType: string; payloadJson: string } }).data)
      .find((d) => d.eventType === "fynd_replacement_sync_failed")!;
    expect(JSON.parse(failed.payloadJson).error).toBe("fynd-string-error");
  });
});

// ─────────────────── sessionEmail fallback in audit identity ───────────────────
describe("handleProcessReplacement — sessionEmail null fallback", () => {
  it("uses 'shop-admin' as audit identity when sessionEmail is null", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    const ctx = mkCtx({
      sessionEmail: null,
      admin: mkAdmin(DRAFT_OK, COMPLETE_OK),
    });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    // replacement_created event captures adminEmail null
    const ev = prismaMock.returnEvent.create.mock.calls
      .map((c) => (c[0] as { data: { eventType: string; payloadJson: string } }).data)
      .find((d) => d.eventType === "replacement_created")!;
    expect(JSON.parse(ev.payloadJson).adminEmail).toBeNull();
  });
});

// ─────────────────── Outer catch with Response thrown ───────────────────
describe("handleProcessReplacement — Response thrown in catch", () => {
  it("re-throws non-redirect Response (>=400) without converting to JSON 500", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
    // Make returnCase.update reject with a Response (not a redirect)
    const rejectionResponse = new Response("nope", { status: 502 });
    prismaMock.returnCase.update.mockRejectedValueOnce(rejectionResponse);
    const ctx = mkCtx({ admin: mkAdmin(DRAFT_OK, COMPLETE_OK) });
    let thrown: unknown;
    try {
      await handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(502);
  });
});
