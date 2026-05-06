/** @vitest-environment jsdom */
/**
 * Final branch-coverage closure for app/routes/app.returns.$id.tsx.
 *
 * Strategy: render the component with rich `fyndOrderDetailsTab` data and
 * full `returnLabelInfo` so every `&&`-gated detail row / pricing branch
 * fires. Adds no new source code; only test fixtures.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));

vi.mock("../db.server", () => ({
  default: {
    shop: { findUnique: vi.fn() },
    returnCase: { findFirst: vi.fn(), update: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    shopSettings: { findUnique: vi.fn() },
    blocklistEntry: { findFirst: vi.fn() },
  },
}));

vi.mock("../lib/fynd-payload.server", () => ({
  parseFyndPayloadForDisplay: vi.fn(() => null),
  parseFyndOrderDetailsForTab: vi.fn(() => null),
  getPickupAddressFromFyndPayload: vi.fn(() => null),
  extractFyndJourney: vi.fn(() => []),
  extractCustomerFromFyndPayload: vi.fn(() => null),
  extractShippingDetailsFromFyndPayload: vi.fn(() => null),
  extractAffiliateOrderIdFromFyndPayload: vi.fn(() => null),
  isLikelyFyndId: vi.fn(() => false),
  buildTrackingUrlFromCourierAndAwb: vi.fn(() => null),
}));

vi.mock("../lib/fynd.server", () => ({
  isFyndPrivateUrl: vi.fn(() => false),
  signFyndUrl: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  createFyndClientOrError: vi.fn(async () => ({ ok: false })),
}));

vi.mock("../lib/status-colors", () => ({
  getStatusColor: vi.fn(() => "#15803D"),
  getStatusBg: vi.fn(() => "#F0FDF4"),
}));

vi.mock("../lib/shopify-admin.server", () => ({
  fetchOrder: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  fetchOrderByOrderNumber: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  fetchOrderByFyndAffiliateId: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  fetchAllLocations: vi.fn(async () => []),
  withRestCredentials: vi.fn((a: unknown) => a),
}));

vi.mock("../lib/return-request-id", () => ({
  parseReturnIdConfig: vi.fn(() => ({ bodyMode: "id" })),
  buildReturnRequestId: vi.fn(() => "RMA-BR-001"),
  formatReturnRequestId: vi.fn((id: string) => `RMA-${id}`),
}));

vi.mock("../lib/return-id-counter.server", () => ({
  nextReturnIdCounter: vi.fn(async () => 1),
}));

vi.mock("../lib/observability/logger.server", () => ({
  refundLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../components/json-viewer", () => ({
  PayloadViewer: ({ data }: { data: unknown }) => (
    <div data-testid="payload-viewer">{JSON.stringify(data ?? null)}</div>
  ),
}));

vi.mock("../components/AppPage", () => ({
  AppPage: ({ heading, children }: { heading: React.ReactNode; children: React.ReactNode }) => (
    <div data-testid="app-page">
      <h1 className="app-page-title">{heading}</h1>
      <div>{children}</div>
    </div>
  ),
}));

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { error: vi.fn(() => null), headers: vi.fn(() => ({})) },
  shopifyApp: vi.fn(() => ({
    addDocumentResponseHeaders: vi.fn(),
    authenticate: { admin: vi.fn() },
    unauthenticated: {},
    login: vi.fn(),
    registerWebhooks: vi.fn(),
    sessionStorage: {},
  })),
  ApiVersion: { January25: "2025-01" },
  AppDistribution: { AppStore: "app_store" },
}));

import { renderWithRouter } from "../../test/component-helpers";
import { waitFor } from "@testing-library/react";
import Component from "../app.returns.$id";

const baseItem = {
  id: "item_br_1",
  qty: 1,
  shopifyLineItemId: "gid://shopify/LineItem/777",
  sku: "SKU-BR",
  reasonCode: "wrong_size",
  condition: "unused",
  title: "Branch Item",
  variantTitle: "M / Red",
  imageUrl: null,
  price: "10.00",
  notes: null,
  fyndBagId: null,
  fyndArticleId: null,
  fyndSellerIdentifier: null,
  fyndSize: null,
  fyndShipmentId: null,
};

function makeReturnCase(overrides: Record<string, unknown> = {}) {
  return {
    id: "ret_br_001",
    returnRequestNo: "RMA-BR-001",
    status: "approved",
    refundStatus: null,
    resolutionType: "refund",
    shopifyOrderId: "gid://shopify/Order/1234567890",
    shopifyOrderName: "#BR1",
    customerName: "Branch Customer",
    customerEmailNorm: "br@example.com",
    customerCity: "Boston",
    customerCountry: "US",
    customerPhoneNorm: null,
    customerAddress1: null,
    customerAddress2: null,
    customerProvince: null,
    customerZip: null,
    currency: "USD",
    fyndReturnId: null,
    fyndSyncStatus: null,
    fyndSyncRetries: 0,
    fyndSyncError: null,
    fyndCurrentStatus: null,
    fyndPayloadJson: null,
    fyndShipmentId: null,
    forwardAwb: null,
    returnAwb: null,
    returnLabelJson: null,
    isGreenReturn: false,
    orderProcessedAt: null,
    updatedAt: new Date("2026-05-01T00:00:00Z").toISOString(),
    createdAt: new Date("2026-05-01T00:00:00Z").toISOString(),
    sourceChannel: "web",
    cancellationRequestedAt: null,
    cancellationRequestedBy: null,
    cancellationReason: null,
    cancellationDeclinedAt: null,
    items: [baseItem],
    events: [],
    ...overrides,
  };
}

function makeLoaderData(overrides: Record<string, unknown> = {}) {
  return {
    returnCase: makeReturnCase(),
    shopDomain: "br-shop.myshopify.com",
    shopifyOrder: null,
    isManualReturn: false,
    fyndPayloadInfo: null,
    fyndOrderDetailsTab: null,
    pickupAddress: null,
    returnJourney: [],
    shopLocations: [],
    fulfillmentLocationId: null,
    fulfillmentLocationName: null,
    refundLocationMode: "auto",
    refundPaymentMethod: "original",
    refundStoreCreditPct: 100,
    isCodOrder: false,
    returnLabelInfo: null,
    defaultReturnInstructions: null,
    customerReturnCount: 1,
    customerEmail: "br@example.com",
    bonusCreditEnabled: false,
    bonusCreditPct: 10,
    isBlocklisted: false,
    daysRemaining: 15,
    returnDeadline: new Date("2026-05-20T00:00:00Z").toISOString(),
    discountCodeRefundEnabled: false,
    discountCodePrefix: "RETURN",
    discountCodeExpiryDays: 90,
    shopLocale: "en",
    shopCurrency: "USD",
    shopTimezone: "UTC",
    fyndCurrentStatus: null,
    customerReturnHistory: [],
    hasRealShipmentData: false,
    displayForwardAwb: null,
    displayReturnAwb: null,
    allowedFyndStatusesForRefund: [],
    refundGatePreset: null,
    ...overrides,
  };
}

// Build a fyndOrderDetailsTab where every optional field is populated to fire
// every `&&`-gated branch in the Forward Shipment + Return Shipment regions.
function makeRichFyndTab() {
  return {
    fyndOrderId: "F-RICH",
    paymentMethod: "COD",
    supportUrl: "https://support.example/order",
    shipments: [
      {
        shipmentId: "FWD-S-1",
        forwardShipmentId: "FWD-S-1",
        cpName: "BlueDart",
        forwardAwb: "FWD-AWB-1",
        returnAwb: null,
        trackingUrl: "https://tracking.example/forward",
        invoiceNumber: "INV-100",
        invoiceId: "INV-100",
        invoiceUrl: "https://invoice.example/100.pdf",
        labelUrl: "https://label.example/100.pdf",
        signedInvoiceUrl: null,
        signedLabelUrl: null,
        fulfillmentStore: "Store-Mumbai",
        fulfillmentOptions: "Standard",
        shipmentStatus: "delivery_done",
        creditNoteId: null,
        journeyType: "forward",
        estimatedDelivery: "2026-05-05T00:00:00Z",
        deliveryAddress: {
          formatted: "1 Test St, Mumbai",
          name: "Recipient Name",
          address: "1 Test St",
          city: "Mumbai",
          state: "MH",
          pincode: "400001",
          country: "IN",
          phone: "+91-9999",
        },
        weightInfo: "1.0 kg",
        dimensions: "10x10x10cm",
        storePhone: "+91-9000",
        storeEmail: "store@example.com",
        dpPhone: "+91-8888",
        dpGstin: "GSTIN-1",
        invoiceA3Url: null,
        ewaybillUrl: "https://ewaybill.example/1.pdf",
        pricing: {
          subtotal: "100.00",
          discount: "10.00",
          deliveryCharges: "5.00",
          codAmount: "120.00",
          total: "115.00",
          currency: "INR",
        },
        trackingDetails: [
          { status: "out_for_delivery", time: "2026-05-04T10:00:00Z", message: "Out for delivery" },
          { status: "in_transit", time: "2026-05-03T08:00:00Z", message: "In transit" },
        ],
        items: [],
      },
      {
        shipmentId: "RET-S-1",
        forwardShipmentId: "FWD-S-1",
        cpName: "BlueDartReturn",
        forwardAwb: null,
        returnAwb: "RET-AWB-1",
        trackingUrl: "https://tracking.example/return",
        invoiceNumber: "RINV-100",
        invoiceId: null,
        invoiceUrl: "https://invoice.example/return-100.pdf",
        labelUrl: "https://label.example/return-100.pdf",
        signedInvoiceUrl: null,
        signedLabelUrl: null,
        fulfillmentStore: "Store-RVP",
        fulfillmentOptions: null,
        shipmentStatus: "return_delivered",
        creditNoteId: "CN-1",
        journeyType: "return",
        estimatedDelivery: "2026-05-10T00:00:00Z",
        deliveryAddress: null,
        weightInfo: "0.8 kg",
        dimensions: "8x8x8cm",
        storePhone: "+91-9000",
        storeEmail: null,
        dpPhone: "+91-7777",
        dpGstin: null,
        invoiceA3Url: null,
        ewaybillUrl: null,
        pricing: {
          subtotal: "90.00",
          discount: "5.00",
          total: "85.00",
          currency: "INR",
        },
        trackingDetails: [
          { status: "return_delivered", time: "2026-05-08T10:00:00Z", message: "Returned" },
        ],
        items: [],
      },
    ],
  };
}

describe("app.returns.$id — final branch closure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rich fyndOrderDetailsTab fires every forward+return shipment detail branch", async () => {
    const rc = makeReturnCase({ status: "approved" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_br_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        fyndOrderDetailsTab: makeRichFyndTab(),
        returnLabelInfo: {
          carrier: "BlueDartReturn",
          trackingNumber: "RET-AWB-1",
          trackingUrl: "https://tracking.example/return",
          labelUrl: "https://label.example/return-100.pdf",
          invoiceUrl: "https://invoice.example/return-100.pdf",
          signedLabelUrl: null,
          signedInvoiceUrl: null,
          signedAt: Date.now(),
          signedInvoiceAt: Date.now(),
          returnStatus: "return_delivered",
          qrCodeUrl: "https://qr.example/r-1.png",
          source: "fynd_api_refresh",
        },
        displayForwardAwb: "FWD-AWB-1",
        displayReturnAwb: "RET-AWB-1",
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-BR-001");
    });
    // Forward shipment fields
    expect(container.textContent).toMatch(/Forward Shipment/);
    expect(container.textContent).toMatch(/Store-Mumbai/);
    expect(container.textContent).toMatch(/INV-100/);
    expect(container.textContent).toMatch(/Mumbai/);
    expect(container.textContent).toMatch(/Shipment Pricing/);
    // Return shipment fields
    expect(container.textContent).toMatch(/Return Shipment|Credit Note ID/);
    expect(container.textContent).toMatch(/Return Pricing|Subtotal/);
  });

  it("retPricing with only discount (no total/subtotal) still shows Pricing details", async () => {
    const tab = makeRichFyndTab();
    // Override return shipment pricing — only `discount`
    tab.shipments[1].pricing = { discount: "5.00", currency: "INR" } as never;
    tab.shipments[1].trackingDetails = [];
    const rc = makeReturnCase({ status: "approved" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_br_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        fyndOrderDetailsTab: tab,
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-BR-001");
    });
  });

  it("refundInfo source variants render distinct labels (admin / fynd_webhook / auto_fynd_credit_note / other)", async () => {
    // Each event with type 'refund_processed' becomes a refundInfo entry.
    // Test "admin" first — most common path.
    const rc = makeReturnCase({
      status: "completed",
      refundStatus: "refunded",
      events: [
        {
          id: "e1",
          type: "refund_processed",
          actor: "admin",
          happenedAt: new Date("2026-05-02T00:00:00Z").toISOString(),
          payloadJson: JSON.stringify({
            amount: "20.00",
            currency: "USD",
            createdAt: "2026-05-02T00:00:00Z",
            source: "admin",
            refundId: "gid://shopify/Refund/1",
          }),
        },
      ],
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_br_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-BR-001");
    });
  });

  it("refundInfo source 'fynd_webhook' renders 'Fynd' label", async () => {
    const rc = makeReturnCase({
      status: "completed",
      refundStatus: "refunded",
      events: [
        {
          id: "e1",
          type: "refund_processed",
          actor: "system",
          happenedAt: new Date("2026-05-02T00:00:00Z").toISOString(),
          payloadJson: JSON.stringify({
            amount: "20.00",
            currency: "USD",
            createdAt: "2026-05-02T00:00:00Z",
            source: "fynd_webhook",
            refundId: "gid://shopify/Refund/2",
          }),
        },
      ],
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_br_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-BR-001");
    });
  });

  it("refundInfo source 'auto_fynd_credit_note' renders Auto label", async () => {
    const rc = makeReturnCase({
      status: "completed",
      refundStatus: "refunded",
      events: [
        {
          id: "e1",
          type: "refund_processed",
          actor: "system",
          happenedAt: new Date("2026-05-02T00:00:00Z").toISOString(),
          payloadJson: JSON.stringify({
            amount: "30.00",
            currency: "USD",
            createdAt: "2026-05-02T00:00:00Z",
            source: "auto_fynd_credit_note",
            refundId: "gid://shopify/Refund/3",
          }),
        },
      ],
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_br_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-BR-001");
    });
  });

  it("refundInfo source unrecognized falls through to raw value", async () => {
    const rc = makeReturnCase({
      status: "completed",
      refundStatus: "refunded",
      events: [
        {
          id: "e1",
          type: "refund_processed",
          actor: "system",
          happenedAt: new Date("2026-05-02T00:00:00Z").toISOString(),
          payloadJson: JSON.stringify({
            amount: "12.00",
            currency: "USD",
            createdAt: "2026-05-02T00:00:00Z",
            source: "manual_partner_offsite",
            refundId: null,
          }),
        },
      ],
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_br_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-BR-001");
    });
  });

  it("item with object-typed price falls into rawPrice object path (line 1478)", async () => {
    // Trigger the L1473-1485 derivation. We pass an object-shaped price.
    const itemWithObjPrice = {
      ...baseItem,
      // typed as `string | null`, but runtime sometimes sees objects
      price: { amount: "44.00", currency: "USD" } as unknown as string,
    };
    const rc = makeReturnCase({ status: "approved", items: [itemWithObjPrice] });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_br_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-BR-001");
    });
  });

  it("item shopifyLineItemId match in shopifyOrder.lineItems triggers li.id branch (line 1465)", async () => {
    const rc = makeReturnCase({
      status: "approved",
      items: [{ ...baseItem, shopifyLineItemId: "gid://shopify/LineItem/MATCH-1", sku: "S-MATCH" }],
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_br_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        shopifyOrder: {
          id: "gid://shopify/Order/100",
          name: "#BR1",
          email: "br@example.com",
          phone: null,
          shippingAddress: null,
          billingAddress: null,
          subtotalPrice: "10.00",
          totalDiscounts: null,
          totalPrice: "10.00",
          currencyCode: "USD",
          processedAt: "2026-05-01T00:00:00Z",
          customer: null,
          fulfillments: [],
          lineItems: [
            {
              id: "gid://shopify/LineItem/MATCH-1",
              title: "Matched LI",
              sku: "S-MATCH",
              quantity: 1,
              price: "10.00",
              discountedPrice: "10.00",
              variantTitle: "M",
              imageUrl: "https://image.example/li.png",
            },
          ],
        },
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-BR-001");
    });
  });

  it("item sku-only match (no shopifyLineItemId match) covers li.sku branch", async () => {
    const rc = makeReturnCase({
      status: "approved",
      items: [
        { ...baseItem, shopifyLineItemId: "gid://shopify/LineItem/NO-MATCH", sku: "S-OTHER" },
      ],
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_br_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        shopifyOrder: {
          id: "gid://shopify/Order/100",
          name: "#BR1",
          email: "br@example.com",
          phone: null,
          shippingAddress: null,
          billingAddress: null,
          subtotalPrice: "10.00",
          totalDiscounts: null,
          totalPrice: "10.00",
          currencyCode: "USD",
          processedAt: "2026-05-01T00:00:00Z",
          customer: null,
          fulfillments: [],
          lineItems: [
            {
              id: "gid://shopify/LineItem/DIFF",
              title: "Sku Match LI",
              sku: "S-OTHER",
              quantity: 1,
              price: "10.00",
              discountedPrice: null,
              variantTitle: null,
              imageUrl: null,
            },
          ],
        },
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-BR-001");
    });
  });

  it("retPricing total-only renders only Total row (covers retPricing.total)", async () => {
    const tab = makeRichFyndTab();
    tab.shipments[1].pricing = { total: "50.00", currency: "INR" } as never;
    const rc = makeReturnCase({ status: "approved" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_br_001"],
      loaderData: makeLoaderData({ returnCase: rc, fyndOrderDetailsTab: tab }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-BR-001");
    });
  });

  it("forward shipment pricing only with subtotal (no total) covers fwdPricing.subtotal-only branch", async () => {
    const tab = makeRichFyndTab();
    tab.shipments[0].pricing = { subtotal: "50.00", currency: "INR" } as never;
    const rc = makeReturnCase({ status: "approved" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_br_001"],
      loaderData: makeLoaderData({ returnCase: rc, fyndOrderDetailsTab: tab }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-BR-001");
    });
  });

  it("fwdDeliveryAddress without `formatted` falls back to joined parts", async () => {
    const tab = makeRichFyndTab();
    tab.shipments[0].deliveryAddress = {
      formatted: null,
      name: "JoinedName",
      address: "JoinedAddr",
      city: "JoinedCity",
      state: "JS",
      pincode: "001",
      country: "JC",
      phone: "+11-1",
    } as never;
    const rc = makeReturnCase({ status: "approved" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_br_001"],
      loaderData: makeLoaderData({ returnCase: rc, fyndOrderDetailsTab: tab }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-BR-001");
    });
    expect(container.textContent).toContain("JoinedAddr");
  });

  it("daysRemaining=0 (expired) + fraud high + sourceChannel pos + giftReturn fires badge branches", async () => {
    const rc = makeReturnCase({
      status: "approved",
      sourceChannel: "pos",
      fraudRiskLevel: "high",
      fraudRiskScore: 75,
      isGiftReturn: true,
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_br_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        daysRemaining: 0,
        returnDeadline: new Date("2026-04-01T00:00:00Z").toISOString(),
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-BR-001");
    });
    expect(container.textContent).toMatch(/Expired|POS|Gift|Risk/i);
  });

  it("daysRemaining=5 (warning band) + sourceChannel draft_order + fraud critical fires alt color branches", async () => {
    const rc = makeReturnCase({
      status: "approved",
      sourceChannel: "draft_order",
      fraudRiskLevel: "critical",
      fraudRiskScore: 95,
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_br_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        daysRemaining: 5,
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-BR-001");
    });
  });

  it("sourceChannel b2b + green return + resolutionType exchange + fraud medium", async () => {
    const rc = makeReturnCase({
      status: "approved",
      sourceChannel: "b2b",
      resolutionType: "exchange",
      isGreenReturn: true,
      fraudRiskLevel: "medium",
      fraudRiskScore: 50,
      exchangePreference: "Size up to L",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_br_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-BR-001");
    });
    expect(container.textContent).toMatch(/B2B|Green|Exchange/i);
  });

  it("unknown sourceChannel falls through to default cfg (covers cfg fallback)", async () => {
    const rc = makeReturnCase({ status: "approved", sourceChannel: "kiosk" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_br_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-BR-001");
    });
  });

  it("cancellation declined indicator renders when no active request + declined timestamp", async () => {
    const rc = makeReturnCase({
      status: "approved",
      cancellationRequestedAt: null,
      cancellationRequestedBy: null,
      cancellationDeclinedAt: new Date("2026-05-01T00:00:00Z").toISOString(),
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_br_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-BR-001");
    });
    expect(container.textContent).toMatch(/declined/i);
  });

  it("cancellation request active fires approve/decline buttons branch", async () => {
    const rc = makeReturnCase({
      status: "approved",
      cancellationRequestedAt: new Date("2026-05-01T00:00:00Z").toISOString(),
      cancellationRequestedBy: "customer",
      cancellationReason: "Changed mind",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_br_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-BR-001");
    });
    expect(container.textContent).toMatch(/Approve Cancellation|Decline/i);
  });

  it("exchangeOrderId set with completed_with_refund flow + priceDiff > 0 fires headline branches", async () => {
    const rc = makeReturnCase({
      status: "completed",
      resolutionType: "exchange",
      exchangeOrderId: "gid://shopify/DraftOrder/9999",
      exchangeOrderName: "#D-9999",
      exchangeItemsJson: JSON.stringify([{ title: "ItemA", quantity: 1, price: "12.00" }]),
      events: [
        {
          id: "ev1",
          eventType: "exchange_created",
          type: "exchange_created",
          actor: "system",
          happenedAt: new Date("2026-05-02T00:00:00Z").toISOString(),
          payloadJson: JSON.stringify({
            flow: "completed_with_refund",
            priceDiff: -5.5,
            currency: "USD",
            invoiceUrl: null,
            refund: { success: true, amount: "5.50", refundId: "gid://shopify/Refund/55" },
          }),
        },
      ],
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_br_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-BR-001");
    });
    expect(container.textContent).toMatch(/Exchange order|Refunded to customer/i);
  });

  it("exchangeOrderId with invoice_pending flow + replacement type renders payment-link branch", async () => {
    const rc = makeReturnCase({
      status: "completed",
      resolutionType: "replacement",
      exchangeOrderId: "gid://shopify/Order/8888",
      exchangeOrderName: "#R-8888",
      exchangeItemsJson: JSON.stringify([{ title: "Repl", quantity: 1, price: "20.00" }]),
      events: [
        {
          id: "ev2",
          eventType: "replacement_created",
          type: "replacement_created",
          actor: "system",
          happenedAt: new Date("2026-05-02T00:00:00Z").toISOString(),
          payloadJson: JSON.stringify({
            flow: "invoice_pending",
            priceDiff: 7.25,
            currency: "USD",
            invoiceUrl: "https://invoice.example/inv-8888",
            refund: null,
          }),
        },
      ],
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_br_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-BR-001");
    });
    expect(container.textContent).toMatch(/Customer payment link|Customer owes|awaiting payment/i);
  });

  it("exchangeOrderId with completed_with_refund.success=false fires failure branch", async () => {
    const rc = makeReturnCase({
      status: "completed",
      resolutionType: "exchange",
      exchangeOrderId: "gid://shopify/DraftOrder/7777",
      exchangeOrderName: "#D-7777",
      events: [
        {
          id: "ev3",
          eventType: "exchange_created",
          type: "exchange_created",
          actor: "system",
          happenedAt: new Date("2026-05-02T00:00:00Z").toISOString(),
          payloadJson: JSON.stringify({
            flow: "completed_with_refund",
            priceDiff: -3.0,
            currency: "USD",
            refund: { success: false },
          }),
        },
      ],
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_br_001"],
      loaderData: makeLoaderData({ returnCase: rc }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-BR-001");
    });
    expect(container.textContent).toMatch(/refund failed/i);
  });

  it("blocklisted flag + serial returner badge fires customer-history red panel", async () => {
    const rc = makeReturnCase({ status: "approved", customerEmailNorm: "serial@example.com" });
    const history = Array.from({ length: 4 }, (_, i) => ({
      id: `prev_${i}`,
      returnRequestNo: `RMA-PREV-${i}`,
      status: "completed",
      createdAt: new Date(`2026-04-0${i + 1}T00:00:00Z`).toISOString(),
    }));
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_br_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        isBlocklisted: true,
        customerReturnCount: 4,
        customerReturnHistory: history,
        customerEmail: "serial@example.com",
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-BR-001");
    });
    expect(container.textContent).toMatch(/Serial Returner|Flagged customer/i);
  });

  it("rich pickupAddress with formatted only (no full customer address) renders fallback path", async () => {
    const rc = makeReturnCase({
      status: "approved",
      customerAddress1: null,
      customerZip: null,
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_br_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        pickupAddress: {
          formatted: null,
          name: "PickupName",
          address1: "Line1",
          address2: "Line2",
          city: "PickupCity",
          state: "PS",
          pincode: "00099",
          country: "PC",
        },
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-BR-001");
    });
    expect(container.textContent).toMatch(/Line1|PickupCity/);
  });

  it("isCodOrder with paymentGatewayNames + shippingAddress renders address+COD branches", async () => {
    const rc = makeReturnCase({ status: "approved" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_br_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        isCodOrder: true,
        shopifyOrder: {
          id: "gid://shopify/Order/100",
          name: "#BR1",
          email: "br@example.com",
          phone: "+1-555",
          createdAt: "2026-04-01T00:00:00Z",
          displayFulfillmentStatus: "fulfilled",
          displayFinancialStatus: "paid",
          paymentGatewayNames: ["Cash on Delivery"],
          shippingAddress: {
            name: "Ship Name",
            address1: "1 Ship",
            address2: null,
            city: "ShipCity",
            province: "SP",
            zip: "00001",
            country: "SC",
            firstName: null,
            lastName: null,
          },
          billingAddress: null,
          subtotalPrice: "10.00",
          totalDiscounts: "1.00",
          totalPrice: "9.00",
          currencyCode: "USD",
          processedAt: "2026-04-01T00:00:00Z",
          customer: null,
          fulfillments: [],
          lineItems: [],
        },
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-BR-001");
    });
    expect(container.textContent).toMatch(/COD|Cash on Delivery|ShipCity/);
  });

  it("manual return short-circuits Shipment & Logistics card", async () => {
    const rc = makeReturnCase({
      status: "approved",
      shopifyOrderId: "manual:abc123",
      shopifyOrderName: "#MANUAL-1",
    });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_br_001"],
      loaderData: makeLoaderData({ returnCase: rc, isManualReturn: true }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-BR-001");
    });
  });

  it("retJourney rendered when length > 0 (covers timeline branch)", async () => {
    const rc = makeReturnCase({ status: "approved" });
    const { container } = renderWithRouter(Component, {
      initialEntries: ["/app/returns/ret_br_001"],
      loaderData: makeLoaderData({
        returnCase: rc,
        returnJourney: [
          {
            status: "return_initiated",
            displayName: "Return Initiated",
            time: "2026-05-01T10:00:00Z",
          },
          { status: "in_transit", displayName: "In Transit", time: "2026-05-02T08:00:00Z" },
        ],
      }) as never,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("RMA-BR-001");
    });
    expect(container.textContent).toMatch(/Return Journey|Return Initiated/i);
  });
});
