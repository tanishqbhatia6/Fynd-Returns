/**
 * Deeper branch-coverage tests for `handleProcessReplacement`.
 *
 * The sibling `process-handlers.test.ts` covers the broad happy path and
 * primary guard branches. This file fills in the deeper conditional
 * matrix that determines downstream behaviour:
 *
 *   1. Variant ID resolution
 *      - resolved by `id` match
 *      - resolved by case-insensitive `sku` match
 *      - resolved by nested `variant.id` shape
 *      - falls through with `null` variantId (custom-line path)
 *      - skipped entirely for `manual` line item id
 *
 *   2. draftOrderComplete success vs error
 *      - success returns realOrder data (used by update + email)
 *      - userErrors block path → falls back to draft data
 *      - top-level errors block path → falls back to draft data
 *      - thrown exception path → falls back to draft data
 *
 *   3. Fynd return_completed push
 *      - success path writes `fynd_replacement_synced` event
 *      - error path writes `fynd_replacement_sync_failed` event
 *      - skipped entirely when no fyndShipmentId
 *      - skipped when fynd client cannot be created
 *
 *   4. Customer notification
 *      - uses realOrder name when complete succeeded
 *      - uses draftOrder name when complete failed (fallback)
 *      - skipped entirely when customerEmailNorm is null
 *      - notification rejection is swallowed (still redirects)
 *
 * Note on the test seam: every dependency is mocked at module boundary.
 * The handler throws a `redirect()` Response on success — `expectRedirect`
 * absorbs that and asserts the location.
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

/** Minimal context factory tailored for replacement scenarios. */
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
        json: async () => ({
          data: {
            draftOrderCreate: {
              draftOrder: { id: "gid://shopify/DraftOrder/1", name: "D1" },
              userErrors: [],
            },
          },
        }),
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

/**
 * Builds an admin.graphql mock: 1st call returns draftOrderCreate response,
 * 2nd call returns draftOrderComplete response.
 */
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

beforeEach(() => {
  resetPrismaMock(prismaMock);
  fetchOrderMock.mockReset().mockResolvedValue(null);
  fetchOrderByOrderNumberMock.mockReset().mockResolvedValue(null);
  fetchVariantInfoMock.mockReset().mockResolvedValue(new Map());
  closeShopifyReturnBestEffortMock.mockReset().mockResolvedValue({ ok: true });
  createFyndClientOrErrorMock.mockReset().mockResolvedValue({ ok: false, error: "disabled" });
  sendApprovalNotificationMock.mockReset().mockResolvedValue(undefined);
});

// ─────────────────── Variant ID resolution ───────────────────
describe("handleProcessReplacement — variant ID resolution", () => {
  it("resolves variantId via line-item id match (top-level variantId field)", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        {
          id: "gid://shopify/LineItem/1",
          title: "Item 1",
          sku: "SKU-X",
          price: "10.00",
          quantity: 1,
          variantId: "gid://shopify/ProductVariant/V1",
        },
      ],
    });
    const ctx = mkCtx({ admin: mkAdmin(DRAFT_OK, COMPLETE_OK) });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    // Variant must have been included in inventory check
    expect(fetchVariantInfoMock).toHaveBeenCalledWith(expect.anything(), [
      "gid://shopify/ProductVariant/V1",
    ]);
    // Persisted exchangeItems must carry the resolved variantId
    const update = prismaMock.returnCase.update.mock.calls[0][0] as unknown as {
      data: { exchangeItemsJson: string };
    };
    const items = JSON.parse(update.data.exchangeItemsJson);
    expect(items[0].variantId).toBe("gid://shopify/ProductVariant/V1");
  });

  it("resolves variantId via SKU case-insensitive fallback when line-item ids differ", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        {
          // intentionally non-matching id — must fall through to SKU compare
          id: "gid://shopify/LineItem/99",
          title: "Item 1",
          sku: "sku-1", // lowercase, item.sku is "SKU-1"
          price: "10.00",
          quantity: 1,
          variantId: "gid://shopify/ProductVariant/V_SKU",
        },
      ],
    });
    const ctx = mkCtx({ admin: mkAdmin(DRAFT_OK, COMPLETE_OK) });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(fetchVariantInfoMock).toHaveBeenCalledWith(expect.anything(), [
      "gid://shopify/ProductVariant/V_SKU",
    ]);
  });

  it("resolves variantId from nested variant.id shape", async () => {
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
          // No top-level variantId — uses nested variant.id
          variant: { id: "gid://shopify/ProductVariant/V_NESTED" },
        },
      ],
    });
    const ctx = mkCtx({ admin: mkAdmin(DRAFT_OK, COMPLETE_OK) });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(fetchVariantInfoMock).toHaveBeenCalledWith(expect.anything(), [
      "gid://shopify/ProductVariant/V_NESTED",
    ]);
  });

  it("custom-line path: persists with null variantId when no shopify line-item match", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      // No matching line items at all in the order
      lineItems: [
        {
          id: "gid://shopify/LineItem/77",
          title: "Other",
          sku: "OTHER",
          price: "5.00",
          quantity: 1,
        },
      ],
    });
    const ctx = mkCtx({ admin: mkAdmin(DRAFT_OK, COMPLETE_OK) });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    // No GID-shaped variants → fetchVariantInfo not called
    expect(fetchVariantInfoMock).not.toHaveBeenCalled();
    const update = prismaMock.returnCase.update.mock.calls[0][0] as unknown as {
      data: { exchangeItemsJson: string };
    };
    const items = JSON.parse(update.data.exchangeItemsJson);
    expect(items[0].variantId).toBeNull();
  });

  it("excludes line items with shopifyLineItemId === 'manual'", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        {
          id: "gid://shopify/LineItem/1",
          title: "Real",
          sku: "SKU-1",
          price: "10.00",
          quantity: 1,
          variantId: "gid://shopify/ProductVariant/V1",
        },
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
            title: "Real",
          },
          {
            id: "li-2",
            shopifyLineItemId: "manual",
            qty: 1,
            sku: "SKU-MANUAL",
            price: "5.00",
            reasonCode: null,
            notes: null,
            title: "Manual",
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
    expect(items).toHaveLength(1);
    expect(items[0].sku).toBe("SKU-1");
  });

  it("excludes line items missing shopifyLineItemId entirely", async () => {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        {
          id: "gid://shopify/LineItem/1",
          title: "Real",
          sku: "SKU-1",
          price: "10.00",
          quantity: 1,
        },
      ],
    });
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        items: [
          {
            id: "li-skip",
            shopifyLineItemId: null,
            qty: 1,
            sku: "SKU-NO-ID",
            price: "5.00",
            reasonCode: null,
            notes: null,
            title: "skipped",
          },
          {
            id: "li-1",
            shopifyLineItemId: "gid://shopify/LineItem/1",
            qty: 1,
            sku: "SKU-1",
            price: "10.00",
            reasonCode: null,
            notes: null,
            title: "Real",
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
    expect(items).toHaveLength(1);
  });
});

// ─────────────────── draftOrderComplete success vs error ───────────────────
describe("handleProcessReplacement — draftOrderComplete branches", () => {
  function setupHappyOrder() {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
  }

  it("success: persists realOrderId/Name from completed order", async () => {
    setupHappyOrder();
    const ctx = mkCtx({ admin: mkAdmin(DRAFT_OK, COMPLETE_OK) });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const update = prismaMock.returnCase.update.mock.calls[0][0] as unknown as {
      data: { exchangeOrderId: string; exchangeOrderName: string };
    };
    expect(update.data.exchangeOrderId).toBe("gid://shopify/Order/9");
    expect(update.data.exchangeOrderName).toBe("#9");
    // replacement_created event captures completed=true and no completeError
    const ev = prismaMock.returnEvent.create.mock.calls
      .map((c) => (c[0] as { data: { eventType: string; payloadJson: string } }).data)
      .find((d) => d.eventType === "replacement_created")!;
    const payload = JSON.parse(ev.payloadJson);
    expect(payload.completed).toBe(true);
    expect(payload.completeError).toBeUndefined();
    expect(payload.orderId).toBe("gid://shopify/Order/9");
  });

  it("userErrors path: falls back to draft order id/name and records completeError", async () => {
    setupHappyOrder();
    const completeBody = {
      data: {
        draftOrderComplete: {
          draftOrder: null,
          userErrors: [{ field: ["id"], message: "Cannot complete: payment pending" }],
        },
      },
    };
    const ctx = mkCtx({ admin: mkAdmin(DRAFT_OK, completeBody) });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const update = prismaMock.returnCase.update.mock.calls[0][0] as unknown as {
      data: { exchangeOrderId: string; exchangeOrderName: string };
    };
    expect(update.data.exchangeOrderId).toBe("gid://shopify/DraftOrder/1");
    expect(update.data.exchangeOrderName).toBe("D1");
    const ev = prismaMock.returnEvent.create.mock.calls
      .map((c) => (c[0] as { data: { eventType: string; payloadJson: string } }).data)
      .find((d) => d.eventType === "replacement_created")!;
    const payload = JSON.parse(ev.payloadJson);
    expect(payload.completed).toBe(false);
    expect(payload.completeError).toContain("payment pending");
    expect(payload.orderId).toBeNull();
  });

  it("top-level errors path: records completeError and falls back to draft", async () => {
    setupHappyOrder();
    const completeBody = { errors: [{ message: "GraphQL boom" }] };
    const ctx = mkCtx({ admin: mkAdmin(DRAFT_OK, completeBody) });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const ev = prismaMock.returnEvent.create.mock.calls
      .map((c) => (c[0] as { data: { eventType: string; payloadJson: string } }).data)
      .find((d) => d.eventType === "replacement_created")!;
    const payload = JSON.parse(ev.payloadJson);
    expect(payload.completed).toBe(false);
    expect(payload.completeError).toContain("GraphQL boom");
  });

  it("thrown exception path: completeError captured, draft fallback persists", async () => {
    setupHappyOrder();
    let n = 0;
    const ctx = mkCtx({
      admin: {
        graphql: vi.fn(async () => {
          n++;
          if (n === 1) return { json: async () => DRAFT_OK };
          throw new Error("network burned");
        }),
      } as never,
    });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const update = prismaMock.returnCase.update.mock.calls[0][0] as unknown as {
      data: { exchangeOrderId: string };
    };
    expect(update.data.exchangeOrderId).toBe("gid://shopify/DraftOrder/1");
    const ev = prismaMock.returnEvent.create.mock.calls
      .map((c) => (c[0] as { data: { eventType: string; payloadJson: string } }).data)
      .find((d) => d.eventType === "replacement_created")!;
    expect(JSON.parse(ev.payloadJson).completeError).toContain("network burned");
  });
});

// ─────────────────── Fynd return_completed push ───────────────────
describe("handleProcessReplacement — Fynd return_completed push", () => {
  function setupHappyOrder() {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
  }

  it("success: writes fynd_replacement_synced event when client transitions OK", async () => {
    setupHappyOrder();
    const updateShipmentStatus = vi.fn<(...args: unknown[]) => Promise<undefined>>(
      async () => undefined,
    );
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus, getShipments: vi.fn() },
    });
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-1",
        fyndOrderId: "FY-O-1",
      } as never,
      admin: mkAdmin(DRAFT_OK, COMPLETE_OK),
    });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(updateShipmentStatus).toHaveBeenCalledWith(
      "FY-O-1",
      expect.objectContaining({
        statuses: [
          expect.objectContaining({
            shipments: [{ identifier: "SH-1" }],
            status: "return_completed",
          }),
        ],
      }),
    );
    const eventTypes = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(eventTypes).toContain("fynd_replacement_synced");
  });

  it("uses fyndShipmentId as callId fallback when fyndOrderId is null", async () => {
    setupHappyOrder();
    const updateShipmentStatus = vi.fn<(...args: unknown[]) => Promise<undefined>>(
      async () => undefined,
    );
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus, getShipments: vi.fn() },
    });
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-2",
        fyndOrderId: null,
      } as never,
      admin: mkAdmin(DRAFT_OK, COMPLETE_OK),
    });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(updateShipmentStatus).toHaveBeenCalledWith("SH-2", expect.anything());
  });

  it("error: writes fynd_replacement_sync_failed event when transition throws", async () => {
    setupHappyOrder();
    const updateShipmentStatus = vi.fn(async () => {
      throw new Error("Fynd 503");
    });
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: true,
      client: { updateShipmentStatus, getShipments: vi.fn() },
    });
    const ctx = mkCtx({
      returnCase: {
        ...mkCtx().returnCase,
        fyndShipmentId: "SH-3",
        fyndOrderId: "FY-O-3",
      } as never,
      admin: mkAdmin(DRAFT_OK, COMPLETE_OK),
    });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const events = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string; payloadJson: string } }).data,
    );
    const failed = events.find((e) => e.eventType === "fynd_replacement_sync_failed")!;
    expect(failed).toBeDefined();
    expect(JSON.parse(failed.payloadJson).error).toContain("Fynd 503");
    expect(JSON.parse(failed.payloadJson).shipmentId).toBe("SH-3");
  });

  it("skipped entirely when fyndShipmentId is null", async () => {
    setupHappyOrder();
    const ctx = mkCtx({ admin: mkAdmin(DRAFT_OK, COMPLETE_OK) });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(createFyndClientOrErrorMock).not.toHaveBeenCalled();
    const eventTypes = prismaMock.returnEvent.create.mock.calls.map(
      (c) => (c[0] as { data: { eventType: string } }).data.eventType,
    );
    expect(eventTypes).not.toContain("fynd_replacement_synced");
    expect(eventTypes).not.toContain("fynd_replacement_sync_failed");
  });

  it("skipped when createFyndClientOrError returns ok:false (no transition attempted)", async () => {
    setupHappyOrder();
    createFyndClientOrErrorMock.mockResolvedValueOnce({
      ok: false,
      error: "platform creds missing",
    });
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, fyndShipmentId: "SH-4" } as never,
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

// ─────────────────── Customer notification: realOrder vs draft fallback ───────────────────
describe("handleProcessReplacement — customer notification", () => {
  function setupHappyOrder() {
    fetchOrderMock.mockResolvedValueOnce({
      id: "gid://shopify/Order/1",
      email: "u@example.com",
      lineItems: [
        { id: "gid://shopify/LineItem/1", title: "I", sku: "SKU-1", price: "10.00", quantity: 1 },
      ],
    });
  }

  it("uses realOrder name in notes when complete succeeded", async () => {
    setupHappyOrder();
    const ctx = mkCtx({ admin: mkAdmin(DRAFT_OK, COMPLETE_OK) });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(sendApprovalNotificationMock).toHaveBeenCalledTimes(1);
    const args = sendApprovalNotificationMock.mock.calls[0][0] as unknown as {
      notes: string;
      orderName: string;
    };
    expect(args.notes).toContain("#9"); // real order name
    expect(args.notes).toContain("has been created");
    expect(args.orderName).toBe("#1001");
  });

  it("falls back to draft order name in notes when complete failed", async () => {
    setupHappyOrder();
    const completeFail = {
      data: {
        draftOrderComplete: { draftOrder: null, userErrors: [{ message: "Payment pending" }] },
      },
    };
    const ctx = mkCtx({ admin: mkAdmin(DRAFT_OK, completeFail) });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const args = sendApprovalNotificationMock.mock.calls[0][0] as unknown as { notes: string };
    expect(args.notes).toContain("D1"); // draft order name
    expect(args.notes).toContain("has been started");
    expect(args.notes).toContain("Once finalised");
  });

  it("skipped entirely when customerEmailNorm is null", async () => {
    setupHappyOrder();
    const ctx = mkCtx({
      returnCase: { ...mkCtx().returnCase, customerEmailNorm: null } as never,
      admin: mkAdmin(DRAFT_OK, COMPLETE_OK),
    });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    expect(sendApprovalNotificationMock).not.toHaveBeenCalled();
  });

  it("notification rejection is swallowed and redirect still occurs", async () => {
    setupHappyOrder();
    sendApprovalNotificationMock.mockRejectedValueOnce(new Error("smtp down"));
    const ctx = mkCtx({ admin: mkAdmin(DRAFT_OK, COMPLETE_OK) });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    // The update + event still happened
    expect(prismaMock.returnCase.update).toHaveBeenCalled();
  });

  it("derives shopName by stripping .myshopify.com from shopDomain", async () => {
    setupHappyOrder();
    const ctx = mkCtx({ admin: mkAdmin(DRAFT_OK, COMPLETE_OK) });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const args = sendApprovalNotificationMock.mock.calls[0][0] as unknown as {
      shopName?: string;
      shopDomain: string;
    };
    expect(args.shopName).toBe("store");
    expect(args.shopDomain).toBe("store.myshopify.com");
  });

  it("uses 'your order' fallback in notes when returnCase.shopifyOrderName is empty", async () => {
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
        // Empty string is falsy → notification orderName falls back to "your order"
        shopifyOrderName: "",
      } as never,
      admin: mkAdmin(DRAFT_OK, COMPLETE_OK),
    });
    await expectRedirect(
      handleProcessReplacement(ctx, { action: "process_replacement" } as ReturnActionBody),
      "/app/returns/rc-1",
    );
    const args = sendApprovalNotificationMock.mock.calls[0][0] as unknown as { orderName: string };
    expect(args.orderName).toBe("your order");
  });
});
