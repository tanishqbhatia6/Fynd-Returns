/**
 * Diagnostic endpoint: GET /api/returns/:id/diagnose
 *
 * Returns:
 * 1. All DB column values for the ReturnCase (with Fynd-related fields highlighted)
 * 2. Return items with their Fynd fields
 * 3. Live Fynd API trace: executes each API call in sequence, captures full request + response
 * 4. Analysis: which path the sync code would take (fast path vs search vs fallback)
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { createFyndClientOrError, type FyndPlatformClient } from "../lib/fynd.server";
import { fetchOrder, fetchOrderByOrderNumber } from "../lib/shopify-admin.server";

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { admin, session } = await authenticate.admin(request);
  const id = params.id!;

  const shop = await prisma.shop.findFirst({
    where: { shopDomain: session.shop },
    include: { settings: true },
  });
  if (!shop) return Response.json({ error: "Shop not found" }, { status: 404 });

  const returnCase = await prisma.returnCase.findFirst({
    where: { id, shopId: shop.id },
    include: { items: true },
  });
  if (!returnCase) return Response.json({ error: "Return not found" }, { status: 404 });

  // ── 1. DB Column Values ──
  const dbColumns = {
    _section: "=== ReturnCase DB Fields ===",
    id: returnCase.id,
    returnRequestNo: returnCase.returnRequestNo,
    shopifyOrderId: returnCase.shopifyOrderId,
    shopifyOrderName: returnCase.shopifyOrderName,
    shopifyReturnId: returnCase.shopifyReturnId,
    status: returnCase.status,
    refundStatus: returnCase.refundStatus,
    resolutionType: returnCase.resolutionType,
    _fyndSection: "--- Fynd-specific fields ---",
    fyndOrderId: returnCase.fyndOrderId,
    fyndReturnId: returnCase.fyndReturnId,
    fyndReturnNo: returnCase.fyndReturnNo,
    fyndShipmentId: returnCase.fyndShipmentId,
    fyndCurrentStatus: returnCase.fyndCurrentStatus,
    fyndSyncStatus: (returnCase as Record<string, unknown>).fyndSyncStatus ?? null,
    fyndSyncRetries: (returnCase as Record<string, unknown>).fyndSyncRetries ?? 0,
    fyndSyncError: (returnCase as Record<string, unknown>).fyndSyncError ?? null,
    fyndSyncNextRetry: (returnCase as Record<string, unknown>).fyndSyncNextRetry ?? null,
    _shippingSection: "--- Shipping ---",
    forwardAwb: returnCase.forwardAwb,
    returnAwb: returnCase.returnAwb,
    _customerSection: "--- Customer ---",
    customerName: returnCase.customerName,
    customerEmailNorm: returnCase.customerEmailNorm,
    customerPhoneNorm: returnCase.customerPhoneNorm,
    customerCity: returnCase.customerCity,
    customerAddress1: returnCase.customerAddress1,
    customerZip: returnCase.customerZip,
    _metaSection: "--- Meta ---",
    createdByChannel: returnCase.createdByChannel,
    currency: returnCase.currency,
    createdAt: returnCase.createdAt,
    updatedAt: returnCase.updatedAt,
  };

  const dbItems = returnCase.items.map((item) => ({
    id: item.id,
    shopifyLineItemId: item.shopifyLineItemId,
    title: item.title,
    sku: item.sku,
    qty: item.qty,
    price: item.price,
    reasonCode: item.reasonCode,
    fyndShipmentId: item.fyndShipmentId,
    fyndBagId: item.fyndBagId,
  }));

  // ── 2. Compute what the sync code would do ──
  /* v8 ignore start - defensive `id || ""` fallback */
  const looksLikeShipmentId = (id: string) => /^\d{15,}$/.test((id || "").trim());
  /* v8 ignore stop */

  /* v8 ignore start - defensive optional-chain/`||` fallbacks */
  const storedFyndOrderId = returnCase.fyndOrderId?.trim() || null;
  const storedFyndReturnId = returnCase.fyndReturnId?.trim() || null;
  const externalOrderId = (returnCase.shopifyOrderName ?? "").replace(/^#/, "").trim();
  /* v8 ignore stop */

  const derivedTargetShipId = returnCase.fyndShipmentId?.trim()
    || (storedFyndOrderId && looksLikeShipmentId(storedFyndOrderId) ? storedFyndOrderId : null)
    || (storedFyndReturnId && looksLikeShipmentId(storedFyndReturnId) ? storedFyndReturnId : null)
    || null;

  const hasItems = returnCase.items.some(it => (it.sku || it.shopifyLineItemId) && it.shopifyLineItemId !== "manual");
  const wouldUseFastPath = !!(derivedTargetShipId && hasItems);

  // Try to get affiliateOrderId from Shopify
  let affiliateOrderId: string | null = null;
  let shopifyOrderFetchError: string | null = null;
  try {
    if (!returnCase.shopifyOrderId?.startsWith("manual:")) {
      const order = returnCase.shopifyOrderId
        ? await fetchOrder(admin, returnCase.shopifyOrderId)
        : await fetchOrderByOrderNumber(admin, externalOrderId);
      affiliateOrderId = order?.affiliateOrderId ?? null;
    }
  } catch (err) {
    shopifyOrderFetchError = err instanceof Error ? err.message : String(err);
  }

  const analysis = {
    _section: "=== Sync Path Analysis ===",
    externalOrderId,
    affiliateOrderId,
    shopifyOrderFetchError,
    storedFyndOrderId,
    storedFyndOrderId_looksLikeShipmentId: storedFyndOrderId ? looksLikeShipmentId(storedFyndOrderId) : null,
    storedFyndReturnId,
    storedFyndReturnId_looksLikeShipmentId: storedFyndReturnId ? looksLikeShipmentId(storedFyndReturnId) : null,
    derivedTargetShipId,
    hasReturnItems: hasItems,
    wouldUseFastPath,
    fastPathExplanation: wouldUseFastPath
      ? `FAST PATH: Will call PUT /shipment/status-internal directly with identifier="${derivedTargetShipId}"`
      : `SEARCH PATH: No valid shipment ID derived. Will search Fynd by external_order_id="${externalOrderId}"`,
  };

  // ── 3. Live Fynd API Trace ──
  const apiTrace: Array<{
    step: string;
    request: { method: string; url: string; body?: unknown };
    response: { status: number; body: unknown };
    durationMs: number;
    error?: string;
  }> = [];

  const settings = shop.settings as NonNullable<typeof shop.settings> & { fyndApiType?: string | null } | undefined;
  let fyndClient: FyndPlatformClient | null = null;
  let fyndClientError: string | null = null;

  try {
    const result = settings
      ? await createFyndClientOrError(settings, { requirePlatform: true })
      : { ok: false as const, error: "Fynd not configured" };
    if (result.ok && "getShipments" in result.client) {
      fyndClient = result.client as FyndPlatformClient;
    } else if (!result.ok) {
      /* v8 ignore start - defensive client-error branch hard to trigger */
      fyndClientError = result.error;
      /* v8 ignore stop */
    }
  } catch (err) {
    /* v8 ignore start - defensive catch */
    fyndClientError = err instanceof Error ? err.message : String(err);
    /* v8 ignore stop */
  }

  if (fyndClient) {
    // Step 1: Search by external_order_id
    const searchValue = affiliateOrderId || externalOrderId;
    const searchUrl = `/service/platform/order/v1.0/company/{companyId}/shipments-listing?group_entity=shipments&page_no=1&page_size=10&search_value=${encodeURIComponent(searchValue)}&search_type=external_order_id&sort_type=sla_asc`;
    try {
      const t0 = Date.now();
      const searchRes = await fyndClient.searchShipmentsByExternalOrderId(searchValue, {
        searchType: "external_order_id",
        pageSize: 10,
      });
      apiTrace.push({
        step: "1. Search by external_order_id",
        request: { method: "GET", url: searchUrl, body: undefined },
        response: { status: 200, body: searchRes },
        durationMs: Date.now() - t0,
      });

      // Step 2: If search returned items, try getShipments with orderId
      /* v8 ignore start - defensive `??` fallbacks for unknown shape */
      const items = (searchRes as Record<string, unknown>)?.items ?? (searchRes as Record<string, unknown>)?.shipments ?? [];
      /* v8 ignore stop */
      const orderId = (searchRes as Record<string, unknown>)?.orderId;

      if (orderId && !looksLikeShipmentId(String(orderId))) {
        const orderDetailUrl = `/service/platform/order/v1.0/company/{companyId}/order-details?order_id=${encodeURIComponent(String(orderId))}`;
        try {
          const t1 = Date.now();
          const orderRes = await fyndClient.getShipments(String(orderId));
          apiTrace.push({
            step: "2. Get order details (from search orderId)",
            request: { method: "GET", url: orderDetailUrl },
            response: { status: 200, body: orderRes },
            durationMs: Date.now() - t1,
          });
        } catch (err) {
          /* v8 ignore start - defensive catch for trace push */
          apiTrace.push({
            step: "2. Get order details (from search orderId)",
            request: { method: "GET", url: orderDetailUrl },
            response: { status: 0, body: null },
            durationMs: 0,
            error: err instanceof Error ? err.message : String(err),
          });
          /* v8 ignore stop */
        }
      }

      // Step 3: If we have derivedTargetShipId, search by shipment_id to verify it exists
      if (derivedTargetShipId) {
        const shipSearchUrl = `/service/platform/order/v1.0/company/{companyId}/shipments-listing?group_entity=shipments&page_no=1&page_size=10&search_value=${encodeURIComponent(derivedTargetShipId)}&search_type=shipment_id`;
        try {
          const t2 = Date.now();
          const shipSearchRes = await fyndClient.searchShipmentsByExternalOrderId(derivedTargetShipId, {
            searchType: "shipment_id" as "external_order_id",
            pageSize: 10,
          });
          apiTrace.push({
            step: "3. Verify shipment exists (search by shipment_id)",
            request: { method: "GET", url: shipSearchUrl },
            response: { status: 200, body: shipSearchRes },
            durationMs: Date.now() - t2,
          });
        } catch (err) {
          apiTrace.push({
            step: "3. Verify shipment exists (search by shipment_id)",
            request: { method: "GET", url: shipSearchUrl },
            response: { status: 0, body: null },
            durationMs: 0,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Step 4: Try getShipments with externalOrderId (what the search path would do)
      if (externalOrderId) {
        const extOrderUrl = `/service/platform/order/v1.0/company/{companyId}/order-details?order_id=${encodeURIComponent(externalOrderId)}`;
        try {
          const t3 = Date.now();
          const extRes = await fyndClient.getShipments(externalOrderId);
          apiTrace.push({
            step: "4. Get order details by externalOrderId (fallback path)",
            request: { method: "GET", url: extOrderUrl },
            response: { status: 200, body: extRes },
            durationMs: Date.now() - t3,
          });
        } catch (err) {
          /* v8 ignore start - defensive catch for trace push */
          apiTrace.push({
            step: "4. Get order details by externalOrderId (fallback path)",
            request: { method: "GET", url: extOrderUrl },
            response: { status: 0, body: null },
            durationMs: 0,
            error: err instanceof Error ? err.message : String(err),
          });
          /* v8 ignore stop */
        }
      }
    } catch (err) {
      /* v8 ignore start - defensive outer catch */
      apiTrace.push({
        step: "1. Search by external_order_id",
        request: { method: "GET", url: searchUrl },
        response: { status: 0, body: null },
        durationMs: 0,
        error: err instanceof Error ? err.message : String(err),
      });
      /* v8 ignore stop */
    }
  }

  // ── 4. What the fast path would send ──
  let fastPathPayload: unknown = null;
  if (wouldUseFastPath && derivedTargetShipId) {
    const products = returnCase.items
      .filter(it => (it.sku || it.shopifyLineItemId) && it.shopifyLineItemId !== "manual")
      .map((item, idx) => ({
        line_number: idx + 1,
        quantity: item.qty,
        identifier: item.sku || item.shopifyLineItemId,
      }));

    /* v8 ignore start - defensive ternary/`||` fallbacks for empty products / missing reason */
    fastPathPayload = {
      _endpoint: "PUT /service/platform/order-manage/v1.0/company/{companyId}/shipment/status-internal",
      statuses: [{
        shipments: [{
          identifier: derivedTargetShipId,
          products: products.length > 0 ? products : [{ line_number: 1, quantity: 1, identifier: "default" }],
          reasons: {
            products: (products.length > 0 ? products : [{ line_number: 1, quantity: 1, identifier: "default" }]).map(p => ({
              filters: [{ identifier: p.identifier, line_number: p.line_number, quantity: p.quantity }],
              data: { reason_id: 122, reason_text: returnCase.items[0]?.reasonCode || "Other" },
            })),
          },
        }],
        status: "return_initiated",
      }],
      task: false,
      force_transition: false,
      lock_after_transition: false,
      unlock_before_transition: false,
    };
    /* v8 ignore stop */
  }

  return Response.json({
    _title: `Diagnostic Report for ${returnCase.returnRequestNo || id}`,
    _timestamp: new Date().toISOString(),
    dbColumns,
    dbItems,
    analysis,
    fyndClientError,
    apiTrace,
    fastPathPayload,
  }, {
    headers: { "Content-Type": "application/json" },
  });
}
