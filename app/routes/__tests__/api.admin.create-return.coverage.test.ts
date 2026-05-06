/**
 * Extra coverage tests for app/routes/api.admin.create-return.ts.
 *
 * Complements api.admin.create-return.test.ts by drilling into:
 *   - The full auto-approve pipeline (settings → parseAutoApproveRules →
 *     evaluateAutoApproveRules → returnCase.create.status = "approved").
 *   - The auto-trigger code path that runs `prisma.returnCase.count` for the
 *     customer-return-count rule input.
 *   - Manual mode (autoApproveEnabled=false): status defaults to "pending"
 *     and no rule evaluation happens.
 *   - Item / event / return-request-id side-effects within the transaction.
 *   - Source-channel normalization, currency slicing, exchangePreference
 *     gating, and adminOverride bypass paths.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateMock,
  shopifyModuleMock,
  checkReturnEligibilityMock,
  normalizeSourceChannelMock,
  evaluateAutoApproveRulesMock,
  parseAutoApproveRulesMock,
  buildReturnRequestIdMock,
  nextReturnIdCounterMock,
  parseReturnIdConfigMock,
  fetchOrderByFyndAffiliateIdMock,
  fetchOrderByOrderNumberMock,
  withRestCredentialsMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  shopifyModuleMock: { unauthenticated: { admin: vi.fn() } },
  checkReturnEligibilityMock: vi.fn<(...args: unknown[]) => unknown>(() => ({ eligible: true })),
  normalizeSourceChannelMock: vi.fn((s: string | null) => s),
  evaluateAutoApproveRulesMock: vi.fn<(...args: unknown[]) => unknown>(() => "approve"),
  parseAutoApproveRulesMock: vi.fn<(...args: unknown[]) => unknown[]>(() => []),
  buildReturnRequestIdMock: vi.fn(() => "R-COV-1"),
  nextReturnIdCounterMock: vi.fn(async () => 42),
  parseReturnIdConfigMock: vi.fn(() => ({ bodyMode: "random" })),
  fetchOrderByFyndAffiliateIdMock: vi.fn(),
  fetchOrderByOrderNumberMock: vi.fn(),
  withRestCredentialsMock: vi.fn((admin: unknown) => admin),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({
  authenticate: { admin: authenticateMock },
  default: shopifyModuleMock,
}));
vi.mock("../../lib/return-request-id", () => ({
  parseReturnIdConfig: parseReturnIdConfigMock,
  buildReturnRequestId: buildReturnRequestIdMock,
  formatReturnRequestId: vi.fn((x: string) => `R-${x.slice(0, 6)}`),
}));
vi.mock("../../lib/return-id-counter.server", () => ({
  nextReturnIdCounter: nextReturnIdCounterMock,
}));
vi.mock("../../lib/return-rules.server", () => ({
  checkReturnEligibility: checkReturnEligibilityMock,
}));
vi.mock("../../lib/source-channel.server", () => ({
  normalizeSourceChannel: normalizeSourceChannelMock,
}));
vi.mock("../../lib/auto-approve.server", () => ({
  evaluateAutoApproveRules: evaluateAutoApproveRulesMock,
  parseAutoApproveRules: parseAutoApproveRulesMock,
}));
vi.mock("../../lib/shopify-admin.server", () => ({
  fetchOrderByFyndAffiliateId: fetchOrderByFyndAffiliateIdMock,
  fetchOrderByOrderNumber: fetchOrderByOrderNumberMock,
  withRestCredentials: withRestCredentialsMock,
}));

import { action } from "../api.admin.create-return";

function jsonReq(body: unknown, method = "POST") {
  const init: RequestInit = { method };
  if (method !== "GET" && method !== "HEAD") {
    init.headers = { "Content-Type": "application/json" };
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return new Request("https://app.example/api/admin/create-return", init);
}

function happyBody(overrides: Record<string, unknown> = {}) {
  return {
    shopifyOrderName: "1042",
    items: [{ lineItemId: "gid://shopify/LineItem/1", qty: 1, reasonCode: "damaged" }],
    customerEmail: "ALICE@Example.COM",
    adminOverride: false,
    resolutionType: "refund",
    ...overrides,
  };
}

function wireTransactionAndCreate() {
  prismaMock.$transaction.mockImplementation(async (arg: unknown) => {
    if (typeof arg === "function")
      return await (arg as (p: typeof prismaMock) => unknown)(prismaMock);
    return arg;
  });
  prismaMock.returnCase.create.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      id: "rc-cov",
      items: Array.isArray((data.items as { create?: unknown[] } | undefined)?.create)
        ? (data.items as { create: unknown[] }).create
        : [],
      createdAt: new Date("2026-01-01T00:00:00Z"),
      ...data,
    }),
  );
  prismaMock.returnCase.update.mockImplementation(
    async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => ({
      ...where,
      ...data,
    }),
  );
  prismaMock.returnEvent.create.mockResolvedValue({ id: "ev-cov" });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  shopifyModuleMock.unauthenticated.admin
    .mockReset()
    .mockResolvedValue({ admin: { graphql: vi.fn() } });
  checkReturnEligibilityMock.mockReset().mockReturnValue({ eligible: true });
  normalizeSourceChannelMock.mockReset().mockImplementation((s: string | null) => s);
  evaluateAutoApproveRulesMock.mockReset().mockReturnValue("approve");
  parseAutoApproveRulesMock.mockReset().mockReturnValue([]);
  buildReturnRequestIdMock.mockReset().mockReturnValue("R-COV-1");
  nextReturnIdCounterMock.mockReset().mockResolvedValue(42);
  parseReturnIdConfigMock.mockReset().mockReturnValue({ bodyMode: "random" });
  fetchOrderByFyndAffiliateIdMock.mockReset();
  fetchOrderByOrderNumberMock.mockReset();
  withRestCredentialsMock.mockReset().mockImplementation((a: unknown) => a);
});

describe("auto-approve full pipeline (auto-trigger)", () => {
  beforeEach(() => {
    wireTransactionAndCreate();
  });

  it("runs the full pipeline: parse rules -> count returns -> evaluate -> approved status", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: {
        id: "s-1",
        autoApproveEnabled: true,
        autoApproveRulesJson: '[{"id":"r1"}]',
        returnIdConfigJson: null,
      },
    });
    parseAutoApproveRulesMock.mockReturnValueOnce([{ id: "rule-1", type: "reason" }]);
    prismaMock.returnCase.count.mockResolvedValueOnce(3);
    evaluateAutoApproveRulesMock.mockReturnValueOnce("approve");

    const res = await action({
      request: jsonReq(
        happyBody({
          items: [{ lineItemId: "li-1", qty: 1, reasonCode: "wrong_size" }],
          lineItemsWithPrice: [{ id: "li-1", price: "20", productTags: ["sale", "final"] }],
        }),
      ),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    // Pipeline order: parseAutoApproveRules called with raw json
    expect(parseAutoApproveRulesMock).toHaveBeenCalledWith('[{"id":"r1"}]');
    // returnCase.count called for customer-return-count rule input
    expect(prismaMock.returnCase.count).toHaveBeenCalledWith({
      where: { shopId: "shop-1", customerEmailNorm: "alice@example.com" },
    });
    // evaluator called with reason + tags + customer info
    const evalArgs = evaluateAutoApproveRulesMock.mock.calls[0];
    expect(evalArgs[0]).toEqual([{ id: "rule-1", type: "reason" }]);
    expect(evalArgs[1]).toMatchObject({
      returnReason: "wrong_size",
      productTags: ["sale", "final"],
      customerEmail: "alice@example.com",
      customerReturnCount: 3,
    });
    // Final: status persisted as "approved"
    const createCall = prismaMock.returnCase.create.mock.calls[0][0];
    expect(createCall.data.status).toBe("approved");
  });

  it("skips returnCase.count when no customerEmail provided", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: true, autoApproveRulesJson: "[]" },
    });
    parseAutoApproveRulesMock.mockReturnValueOnce([{ id: "r1" }]);

    await action({
      request: jsonReq(happyBody({ customerEmail: undefined })),
      params: {},
      context: {},
    } as never);

    expect(prismaMock.returnCase.count).not.toHaveBeenCalled();
    const evalArgs = evaluateAutoApproveRulesMock.mock.calls[0];
    expect(evalArgs[1]).toMatchObject({ customerReturnCount: undefined });
  });

  it("passes undefined productTags when no lineItemsWithPrice tags", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: true, autoApproveRulesJson: "[]" },
    });
    parseAutoApproveRulesMock.mockReturnValueOnce([{ id: "r1" }]);

    await action({
      request: jsonReq(
        happyBody({
          lineItemsWithPrice: [{ id: "gid://shopify/LineItem/1", price: "5" }],
        }),
      ),
      params: {},
      context: {},
    } as never);

    const evalArgs = evaluateAutoApproveRulesMock.mock.calls[0] as unknown[];
    expect((evalArgs[1] as { productTags?: unknown }).productTags).toBeUndefined();
  });

  it("auto-approve with empty rules array still resolves to 'approved'", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: true, autoApproveRulesJson: null },
    });
    parseAutoApproveRulesMock.mockReturnValueOnce([]);

    await action({ request: jsonReq(happyBody()), params: {}, context: {} } as never);

    // No rule evaluation when rules empty (short-circuit branch)
    expect(evaluateAutoApproveRulesMock).not.toHaveBeenCalled();
    const createCall = prismaMock.returnCase.create.mock.calls[0][0];
    expect(createCall.data.status).toBe("approved");
  });

  it("creates ReturnEvent with eventType=initiated and adminOverride=false in payload", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: true },
    });

    await action({
      request: jsonReq(happyBody({ createdByStaff: "agent@x.com", crmTicketId: "T-9" })),
      params: {},
      context: {},
    } as never);

    const evCall = prismaMock.returnEvent.create.mock.calls[0][0];
    expect(evCall.data.eventType).toBe("initiated");
    expect(evCall.data.source).toBe("admin");
    expect(evCall.data.returnCaseId).toBe("rc-cov");
    const payload = JSON.parse(evCall.data.payloadJson);
    expect(payload).toMatchObject({
      adminOverride: false,
      createdByStaff: "agent@x.com",
      crmTicketId: "T-9",
      itemCount: 1,
    });
  });

  it("invokes nextReturnIdCounter for sequential bodyMode and updates returnRequestNo", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: true },
    });
    parseReturnIdConfigMock.mockReturnValueOnce({ bodyMode: "sequential" });
    nextReturnIdCounterMock.mockResolvedValueOnce(99);
    buildReturnRequestIdMock.mockReturnValueOnce("R-2026-099");

    await action({ request: jsonReq(happyBody()), params: {}, context: {} } as never);

    expect(nextReturnIdCounterMock).toHaveBeenCalledWith("s-1");
    expect(buildReturnRequestIdMock).toHaveBeenCalledWith({ bodyMode: "sequential" }, "rc-cov", 99);
    const updateCall = prismaMock.returnCase.update.mock.calls[0][0];
    expect(updateCall.data.returnRequestNo).toBe("R-2026-099");
  });

  it("does NOT call nextReturnIdCounter for random bodyMode", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: true },
    });
    parseReturnIdConfigMock.mockReturnValueOnce({ bodyMode: "random" });

    await action({ request: jsonReq(happyBody()), params: {}, context: {} } as never);

    expect(nextReturnIdCounterMock).not.toHaveBeenCalled();
  });
});

describe("manual mode (autoApprove disabled)", () => {
  beforeEach(() => {
    wireTransactionAndCreate();
  });

  it("status='pending' and no rule evaluation when autoApproveEnabled=false", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: false, autoApproveRulesJson: '[{"id":"x"}]' },
    });

    const res = await action({ request: jsonReq(happyBody()), params: {}, context: {} } as never);

    expect(res.status).toBe(200);
    expect(parseAutoApproveRulesMock).not.toHaveBeenCalled();
    expect(evaluateAutoApproveRulesMock).not.toHaveBeenCalled();
    expect(prismaMock.returnCase.count).not.toHaveBeenCalled();
    const createCall = prismaMock.returnCase.create.mock.calls[0][0];
    expect(createCall.data.status).toBe("pending");
  });

  it("manual mode + adminOverride=true still creates with 'pending' status (no auto-approve)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: false },
    });

    await action({
      request: jsonReq(happyBody({ adminOverride: true })),
      params: {},
      context: {},
    } as never);

    expect(checkReturnEligibilityMock).not.toHaveBeenCalled();
    const createCall = prismaMock.returnCase.create.mock.calls[0][0];
    expect(createCall.data.status).toBe("pending");
    // Event payload reflects adminOverride
    const evPayload = JSON.parse(prismaMock.returnEvent.create.mock.calls[0][0].data.payloadJson);
    expect(evPayload.adminOverride).toBe(true);
  });

  it("manual mode preserves all customer + CRM fields on the ReturnCase", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: false },
    });

    await action({
      request: jsonReq(
        happyBody({
          customerName: "Alice",
          customerCity: "NYC",
          customerCountry: "US",
          customerAddress1: "100 Main St",
          customerAddress2: "Apt 5",
          customerProvince: "NY",
          customerZip: "10001",
          customerLandmark: "Near park",
          customerPhone: "+1 (555) 123-4567",
          crmTicketId: "T-1",
          crmNotes: "VIP customer",
          currency: "usd",
        }),
      ),
      params: {},
      context: {},
    } as never);

    const createCall = prismaMock.returnCase.create.mock.calls[0][0];
    expect(createCall.data).toMatchObject({
      customerName: "Alice",
      customerCity: "NYC",
      customerCountry: "US",
      customerAddress1: "100 Main St",
      customerAddress2: "Apt 5",
      customerProvince: "NY",
      customerZip: "10001",
      customerLandmark: "Near park",
      customerPhoneNorm: "+15551234567",
      customerEmailNorm: "alice@example.com",
      crmTicketId: "T-1",
      crmNotes: "VIP customer",
      currency: "USD",
      createdByChannel: "admin",
    });
  });
});

describe("end-to-end: create + items + event + response shape", () => {
  beforeEach(() => {
    wireTransactionAndCreate();
  });

  it("happy path returns success JSON with returnRequestNo", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: true },
    });
    buildReturnRequestIdMock.mockReturnValueOnce("R-AUTO-9");

    const res = await action({ request: jsonReq(happyBody()), params: {}, context: {} } as never);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      success: true,
      returnCase: {
        id: "rc-cov",
        returnRequestNo: "R-AUTO-9",
        status: "approved",
        shopifyOrderName: "#1042",
        resolutionType: "refund",
        createdByChannel: "admin",
      },
    });
  });

  it("items mapped with title/sku/price/qty/reasonCode + Fynd fields", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: false },
    });

    await action({
      request: jsonReq(
        happyBody({
          items: [
            {
              lineItemId: "li-1",
              qty: 2,
              reasonCode: "defect",
              notes: "torn",
              condition: "damaged",
              fyndShipmentId: "ship-1",
              fyndBagId: "bag-1",
              fyndArticleId: "art-1",
              fyndAffiliateLineId: "aff-1",
              fyndSellerIdentifier: "sell-1",
              fyndItemId: "item-1",
              fyndQuantityAvailable: 5,
              fyndPriceEffective: "199.00",
              fyndSize: "M",
            },
          ],
          lineItemsWithPrice: [
            {
              id: "li-1",
              title: "Cotton Tee",
              variantTitle: "Red / M",
              sku: "CT-RED-M",
              price: "29.99",
              imageUrl: "https://cdn/x.jpg",
            },
          ],
        }),
      ),
      params: {},
      context: {},
    } as never);

    const createCall = prismaMock.returnCase.create.mock.calls[0][0];
    const itemCreates = createCall.data.items.create as Array<Record<string, unknown>>;
    expect(itemCreates).toHaveLength(1);
    expect(itemCreates[0]).toMatchObject({
      shopifyLineItemId: "li-1",
      title: "Cotton Tee",
      variantTitle: "Red / M",
      sku: "CT-RED-M",
      price: "29.99",
      imageUrl: "https://cdn/x.jpg",
      qty: 2,
      reasonCode: "defect",
      notes: "torn",
      condition: "damaged",
      fyndShipmentId: "ship-1",
      fyndBagId: "bag-1",
      fyndArticleId: "art-1",
      fyndAffiliateLineId: "aff-1",
      fyndSellerIdentifier: "sell-1",
      fyndItemId: "item-1",
      fyndQuantityAvailable: 5,
      fyndPriceEffective: "199.00",
      fyndSize: "M",
    });
    // Top-level fyndShipmentId is set from items
    expect(createCall.data.fyndShipmentId).toBe("ship-1");
  });

  it("normalizes shopifyOrderName to include leading '#'", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: false },
    });

    await action({
      request: jsonReq(happyBody({ shopifyOrderName: "2050" })),
      params: {},
      context: {},
    } as never);

    const createCall = prismaMock.returnCase.create.mock.calls[0][0];
    expect(createCall.data.shopifyOrderName).toBe("#2050");
  });

  it("exchange resolution captures exchangePreference; refund nulls it", async () => {
    prismaMock.shop.findUnique.mockResolvedValue({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: false },
    });

    await action({
      request: jsonReq(
        happyBody({
          resolutionType: "exchange",
          exchangePreference: "Send size L",
        }),
      ),
      params: {},
      context: {},
    } as never);
    expect(prismaMock.returnCase.create.mock.calls[0][0].data).toMatchObject({
      resolutionType: "exchange",
      exchangePreference: "Send size L",
    });

    await action({
      request: jsonReq(
        happyBody({
          resolutionType: "refund",
          exchangePreference: "ignored",
        }),
      ),
      params: {},
      context: {},
    } as never);
    expect(prismaMock.returnCase.create.mock.calls[1][0].data).toMatchObject({
      resolutionType: "refund",
      exchangePreference: null,
    });
  });

  it("calls normalizeSourceChannel with provided sourceChannel", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: false },
    });
    normalizeSourceChannelMock.mockReturnValueOnce("gorgias");

    await action({
      request: jsonReq(happyBody({ sourceChannel: "GORGIAS" })),
      params: {},
      context: {},
    } as never);

    expect(normalizeSourceChannelMock).toHaveBeenCalledWith("GORGIAS");
    const createCall = prismaMock.returnCase.create.mock.calls[0][0];
    expect(createCall.data.sourceChannel).toBe("gorgias");
  });

  it("combines multiple Fynd shipment IDs by picking the first one", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: false },
    });

    await action({
      request: jsonReq(
        happyBody({
          items: [
            { lineItemId: "li-1", qty: 1, fyndShipmentId: "ship-A" },
            { lineItemId: "li-2", qty: 1, fyndShipmentId: "ship-B" },
          ],
        }),
      ),
      params: {},
      context: {},
    } as never);

    const createCall = prismaMock.returnCase.create.mock.calls[0][0];
    expect(createCall.data.fyndShipmentId).toBe("ship-A");
  });

  it("admin override with auto-approve still produces 'approved' status (and skips eligibility)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1", autoApproveEnabled: true },
    });

    const res = await action({
      request: jsonReq(happyBody({ adminOverride: true })),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(200);
    expect(checkReturnEligibilityMock).not.toHaveBeenCalled();
    const createCall = prismaMock.returnCase.create.mock.calls[0][0];
    expect(createCall.data.status).toBe("approved");
  });
});
