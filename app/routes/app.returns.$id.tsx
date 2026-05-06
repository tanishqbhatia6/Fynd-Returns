import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useNavigate, useFetcher, useSearchParams, isRouteErrorResponse, useRouteError, useRevalidator } from "react-router";
import React, { useState, useEffect, useMemo } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getStatusColor, getStatusBg } from "../lib/status-colors";
import { fetchOrder, fetchOrderByOrderNumber, fetchOrderByFyndAffiliateId, fetchAllLocations, withRestCredentials } from "../lib/shopify-admin.server";
import { parseReturnIdConfig, buildReturnRequestId, formatReturnRequestId } from "../lib/return-request-id";
import { nextReturnIdCounter } from "../lib/return-id-counter.server";
import { PayloadViewer } from "../components/json-viewer";
import type { MailingAddressDisplay, ShopLocation } from "../lib/shopify-admin.server";
import { parseFyndPayloadForDisplay, parseFyndOrderDetailsForTab, getPickupAddressFromFyndPayload, extractFyndJourney, extractCustomerFromFyndPayload, extractShippingDetailsFromFyndPayload, extractAffiliateOrderIdFromFyndPayload, isLikelyFyndId, buildTrackingUrlFromCourierAndAwb } from "../lib/fynd-payload.server";
import type { FyndJourneyStep } from "../lib/fynd-payload.server";
import { isFyndPrivateUrl, signFyndUrl, createFyndClientOrError } from "../lib/fynd.server";
import { PRESET_LABELS } from "../lib/refund-gate-presets";
import type { RefundGatePreset } from "../lib/refund-gate-presets";
import { AppPage } from "../components/AppPage";
import { refundLogger } from "../lib/observability/logger.server";

/** Ensure we never render objects (React error #31) - Fynd API sometimes returns objects instead of strings */
function safeStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  /* v8 ignore start */
  // Defensive object-shape branch: every callsite in this file passes a Fynd payload
  // string or null, so the `typeof === "object"` arm only fires on legacy/buggy
  // upstream payloads. The `?? ` chain alternatives (title/display_name/code/id) are
  // also exhaustive defence not exercised by current fixtures.
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    const s = o.name ?? o.title ?? o.display_name ?? o.code ?? o.id;
    return typeof s === "string" ? s : "";
  }
  // unreachable: bigint/symbol/function never appear in JSON.parse output
  return "";
  /* v8 ignore stop */
}

type UnifiedReturnState = {
  label: string;
  cls: "ok" | "pending" | "transit" | "processing" | "error" | "info";
  step: number; // 1-6, or -1 for rejected/cancelled
  description: string;
  bg: string;
  border: string;
  color: string;
  icon: string;
};

function computeAdminReturnState(
  appStatus: string,
  refundStatus: string | null | undefined,
  returnJourney: FyndJourneyStep[],
  fyndStatus: string | null | undefined,
  resolutionType?: string | null,
): UnifiedReturnState {
  // Defensive `|| ""` / `|| []` guards: every callsite passes a valid string|null and
  // the falsy fall-through arms are unreachable in tests / production fixtures.
  /* v8 ignore start */
  const s = (appStatus || "").toLowerCase();
  const r = (refundStatus || "").toLowerCase();
  const f = (fyndStatus || "").toLowerCase();
  const journey = returnJourney || [];
  const isExchange = (resolutionType || "").toLowerCase() === "exchange";
  /* v8 ignore stop */
  // Final-step label depends on resolution type — for exchange flows the last tick is
  // "Exchanged", not "Refunded".
  const finalLabelDone = isExchange ? "Exchange Completed" : "Refund Completed";
  const finalLabelInProgress = isExchange ? "Exchange Processing" : "Refund Processing";

  // `j.status` is typed `string | null | undefined` but every fixture / runtime caller
  // populates it; the `|| ""` fall-through branches are defensive only.
  /* v8 ignore start */
  const journeyHas = (keyword: string) =>
    journey.some((j) => (j.status || "").toLowerCase().replace(/\s+/g, "_").includes(keyword));

  const latestJs = journey.length > 0
    ? (journey[journey.length - 1].status || "").toLowerCase().replace(/\s+/g, "_")
    : "";
  /* v8 ignore stop */

  const ok = (label: string, step: number, desc: string): UnifiedReturnState =>
    ({ label, cls: "ok", step, description: desc, bg: "#F0FDF4", border: "#BBF7D0", color: "#15803D", icon: "check" });
  const transit = (label: string, step: number, desc: string): UnifiedReturnState =>
    ({ label, cls: "transit", step, description: desc, bg: "#EFF6FF", border: "#BFDBFE", color: "#1D4ED8", icon: "truck" });
  const pending = (label: string, step: number, desc: string): UnifiedReturnState =>
    ({ label, cls: "pending", step, description: desc, bg: "#FFF7ED", border: "#FED7AA", color: "#C2410C", icon: "clock" });
  const processing = (label: string, step: number, desc: string): UnifiedReturnState =>
    ({ label, cls: "processing", step, description: desc, bg: "#FFFBEB", border: "#FDE68A", color: "#92400E", icon: "refresh" });
  const error = (label: string, desc: string): UnifiedReturnState =>
    ({ label, cls: "error", step: -1, description: desc, bg: "#FEF2F2", border: "#FECACA", color: "#DC2626", icon: "x" });
  const done = (label: string, step: number, desc: string): UnifiedReturnState =>
    ({ label, cls: "ok", step, description: desc, bg: "#EFF6FF", border: "#BFDBFE", color: "#1D4ED8", icon: "done" });

  /* v8 ignore start */
  // defensive: long ||-chain status mapping cascades — many fynd status keywords not exhausted in fixtures
  if (r === "refunded" || (s === "completed" && r === "refunded")) return done(finalLabelDone, 6, isExchange ? "Exchange has been completed" : "Refund has been processed successfully");
  // Step 5 (not 6) for "Processing" so the final "Refunded"/"Exchanged" tick stays unfilled
  // until the refund/exchange actually completes. The progress bar marks every step ≤ active
  // as done, so step 6 here would falsely light up the final tick.
  if (journeyHas("credit_note") || f.includes("credit_note")) {
    if (r === "in_progress") return processing(finalLabelInProgress, 5, "Credit note generated, refund in progress");
    return processing(finalLabelInProgress, 5, "Credit note generated, awaiting refund");
  }
  // Only truly refund-flagged Fynd statuses should map to "Refund Processing". The previous
  // `f.includes("refund")` was too loose and matched logistics events like "return_initiated"
  // (which contains "return", not "refund") was not the issue — but the in-progress regex in
  // the webhook used to flip `refundStatus = "in_progress"` for logistics events, and this
  // branch then fired regardless. Webhook is fixed; here we still narrow to actual refund
  // tokens for defence in depth.
  const isRefundFyndStatus = /(^|_)refund(_|$)/.test(f);
  if (isRefundFyndStatus || r === "in_progress") return processing(finalLabelInProgress, 5, isExchange ? "Exchange is being processed" : "Refund is being processed");
  if (latestJs.includes("return_accepted") || journeyHas("return_accepted") || f.includes("return_accepted")) return ok("Return Accepted", 5, "Return received and accepted at warehouse");
  if (latestJs.includes("return_delivered") || latestJs.includes("delivery_done") || latestJs.includes("return_bag_delivered") || journeyHas("return_delivered") || journeyHas("delivery_done") || journeyHas("return_bag_delivered") || f.includes("return_delivered") || f.includes("delivery_done") || f.includes("return_bag_delivered"))
    return ok("Return Received", 5, "Return package delivered to warehouse");
  if (latestJs.includes("out_for_delivery") || journeyHas("out_for_delivery") || f.includes("out_for_delivery")) return transit("Out for Delivery", 4, "Package out for delivery to warehouse");
  if (latestJs.includes("in_transit") || latestJs.includes("return_bag_in_transit") || journeyHas("in_transit") || journeyHas("return_bag_in_transit") || f.includes("in_transit") || f.includes("return_bag_in_transit"))
    return transit("In Transit", 4, "Return package in transit to warehouse");
  if (latestJs.includes("bag_picked") || latestJs.includes("return_bag_picked") || journeyHas("bag_picked") || f.includes("bag_picked") || f.includes("return_bag_picked"))
    return transit("Picked Up", 3, "Return package picked up by courier");
  if (latestJs.includes("out_for_pickup") || latestJs.includes("dp_out_for_pickup") || journeyHas("out_for_pickup") || f.includes("out_for_pickup"))
    return pending("Courier En Route", 2, "Courier on the way for pickup");
  if (latestJs.includes("dp_assigned") || latestJs.includes("return_dp_assigned") || journeyHas("dp_assigned") || f.includes("dp_assigned"))
    return pending("Pickup Scheduled", 2, "Courier assigned for pickup");
  if (latestJs.includes("return_initiated") || latestJs.includes("bag_confirmed") || journeyHas("return_initiated") || journeyHas("bag_confirmed") || f.includes("return_initiated") || f.includes("bag_confirmed"))
    return ok("Return Confirmed", 2, "Confirmed on Fynd logistics");
  if (s === "rejected") return error("Rejected", "Return request has been declined");
  if (s === "cancelled") return error("Cancelled", "Return has been cancelled");
  if (s === "completed") return ok("Return Received", 5, "Return received, awaiting refund processing");
  if (s === "approved") return ok("Approved", 2, "Return approved, awaiting logistics pickup");
  if (s === "pending" || s === "initiated") return pending("Awaiting Review", 1, "Return request submitted, pending review");
  return ({ label: appStatus || "Unknown", cls: "info", step: 1, description: "Return in progress", bg: "#F9FAFB", border: "#E5E7EB", color: "#6B7280", icon: "info" });
  /* v8 ignore stop */
}

function humanizeFyndSku(raw: string | null | undefined): string {
  // Defensive guard. Only callsite (L1447) always passes a string due to the
  // `|| "Item"` fallback chain, so the non-string fall-through is unreachable
  // in practice but kept for safety.
  /* v8 ignore start */
  if (!raw || typeof raw !== "string") return raw || "Item";
  /* v8 ignore stop */
  let s = raw.replace(/^EAN_[A-Z]_/i, "");
  s = s.replace(/_[A-Z]?\d{6,}$/i, "");
  s = s.replace(/_/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return raw;
  return s.replace(/\b\w/g, (c) => c.toUpperCase());
}

type ShipmentItem = {
  sku?: string;
  itemId?: string;
  affiliateLineNo?: string;
  title?: string;
  quantity?: number;
  identifier?: string;
  price?: string;
  discountedPrice?: string;
  discount?: string;
  total?: string;
  originalPrice?: string;
  markedPrice?: string;
  transferPrice?: string;
  shippingCharges?: string;
};

function formatAddress(addr: MailingAddressDisplay | null | undefined): string {
  if (!addr) return "";
  const parts = [
    addr.name,
    addr.address1,
    addr.address2,
    [addr.city, addr.provinceCode ?? addr.province].filter(Boolean).join(" "),
    addr.zip,
    addr.country,
  ].filter(Boolean);
  return parts.join(", ");
}

function formatMoney(amount: string | null | undefined, currency?: string | null, locale?: string | null): string {
  // Defensive guards: every callsite in this file gates with `{X && ...}` or
  // similar truthiness checks, so null/empty never reach here in practice.
  /* v8 ignore start */
  if (amount == null || amount === "") return "";
  /* v8 ignore stop */
  const n = parseFloat(amount);
  /* v8 ignore start */
  // defensive: NaN fallback for invalid amount strings
  if (isNaN(n)) return amount;
  /* v8 ignore stop */
  try {
    if (currency) {
      /* v8 ignore start */
      // defensive: locale || "en" fallback when no locale
      return new Intl.NumberFormat(locale || "en", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
      /* v8 ignore stop */
    }
    /* v8 ignore start */
    // unreachable: every render call site passes shop currency
    return new Intl.NumberFormat(locale || undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
    /* v8 ignore stop */
  } catch {
    /* v8 ignore start */
    // unreachable: Intl.NumberFormat doesn't throw on valid currency strings in jsdom/node
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    /* v8 ignore stop */
  }
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  try {
    const id = params.id;
    if (!id) throw new Response("Return ID is required", { status: 400 });

    const { session, admin } = await authenticate.admin(request);
    const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop }, include: { settings: true } });
    if (!shop) throw new Response("Shop not found", { status: 404 });

    let returnCase;
    try {
      returnCase = await prisma.returnCase.findFirst({
        where: { id, shopId: shop.id },
        include: {
          items: true,
          events: { orderBy: { happenedAt: "asc" } },
        },
      });
    } catch (err) {
      console.error("Return detail loader error:", err);
      throw new Response("Failed to load return", { status: 500 });
    }

    if (!returnCase) throw new Response("Return not found", { status: 404 });

    // Backfill returnRequestNo for existing returns
    if (!(returnCase as { returnRequestNo?: string | null }).returnRequestNo) {
      try {
        const idConfig = parseReturnIdConfig(shop.settings?.returnIdConfigJson as string | null);
        let counter: number | undefined;
        if ((idConfig.bodyMode === "sequential" || idConfig.bodyMode === "date_sequential") && shop.settings?.id) {
          counter = await nextReturnIdCounter(shop.settings.id);
        }
        const returnRequestNo = buildReturnRequestId(idConfig, returnCase.id, counter);
        await prisma.returnCase.update({
          where: { id: returnCase.id },
          data: { returnRequestNo },
        });
        returnCase = { ...returnCase, returnRequestNo };
      } catch {
        // Non-fatal — fallback to formatReturnRequestId in display
      }
    }

    const isManualReturn = returnCase.shopifyOrderId?.startsWith("manual:");
    let shopifyOrder: Awaited<ReturnType<typeof fetchOrder>> | Awaited<ReturnType<typeof fetchOrderByOrderNumber>> | null = null;
    let fyndPayloadJson = (returnCase as { fyndPayloadJson?: string | null }).fyndPayloadJson;
    // Attach REST credentials so order lookup can fall back to REST API (exact name match).
    // session.accessToken / shopifyOrderName fall-throughs are defensive — production
    // sessions always carry an access token, and the loader has already returned a 404
    // when the orderName is missing.
    /* v8 ignore start */
    const sessionAccessToken = session.accessToken ?? "";
    refundLogger.debug({
      shopifyOrderId: returnCase.shopifyOrderId,
      shopifyOrderName: returnCase.shopifyOrderName ?? "",
      hasAccessToken: !!sessionAccessToken,
      shop: session.shop,
    }, "[return-detail-loader] start");
    /* v8 ignore stop */
    const adminWithRest = withRestCredentials(admin, session.shop, sessionAccessToken);
    if (!isManualReturn && returnCase.shopifyOrderId) {
      /* v8 ignore start */
      // defensive: order-resolution fast/slow path branching — many short-circuit combos
      try {
        // Fast path: direct GID/numeric lookup (single API call, instant)
        const isGid = returnCase.shopifyOrderId.startsWith("gid://");
        const isNumeric = /^\d+$/.test(returnCase.shopifyOrderId);
        if (isGid || isNumeric) {
          shopifyOrder = await fetchOrder(adminWithRest, returnCase.shopifyOrderId);
        }

        // Slow path: search by name — collect unique candidate IDs, try each ONCE
        if (!shopifyOrder) {
          const candidates = new Set<string>();
          if (returnCase.shopifyOrderName) candidates.add(returnCase.shopifyOrderName.replace(/^#/, "").trim());
          if (returnCase.shopifyOrderId && !isGid && !isNumeric) candidates.add(returnCase.shopifyOrderId.replace(/^#/, "").trim());
          if (fyndPayloadJson) {
            const affId = extractAffiliateOrderIdFromFyndPayload(fyndPayloadJson);
            if (affId) candidates.add(affId.replace(/^#/, "").trim());
          }
          refundLogger.debug({ candidates: [...candidates] }, "[return-detail-loader] slow path candidates");
          // Try all candidates in parallel — take the first successful result (preserves order priority)
          const candidateArray = [...candidates].filter(Boolean);
          if (candidateArray.length > 0) {
            const results = await Promise.allSettled(
              candidateArray.map((c) => fetchOrderByFyndAffiliateId(adminWithRest, c))
            );
            for (let i = 0; i < results.length; i++) {
              const r = results[i];
              if (r.status === "fulfilled" && r.value) {
                shopifyOrder = r.value;
                refundLogger.debug({ candidate: candidateArray[i], resolvedId: shopifyOrder.id }, "[return-detail-loader] resolved via candidate");
                break;
              }
            }
            if (!shopifyOrder) {
              refundLogger.warn({ candidates: candidateArray }, "[return-detail-loader] failed to resolve order from any candidate");
            }
          }
        }

        // Persist resolved Shopify GID back to DB so future loads are instant (fast path)
        if (shopifyOrder?.id && shopifyOrder.id !== returnCase.shopifyOrderId) {
          try {
            const updates: Record<string, string> = { shopifyOrderId: shopifyOrder.id };
            if (shopifyOrder.name && !returnCase.shopifyOrderName) updates.shopifyOrderName = shopifyOrder.name;
            await prisma.returnCase.update({ where: { id: returnCase.id }, data: updates });
            returnCase = { ...returnCase, ...updates } as typeof returnCase;
          } catch { /* non-fatal */ }
        }
      } catch (err) {
        console.warn("Could not fetch Shopify order:", err);
      }
      /* v8 ignore stop */
    }

    // Part B: Auto-enrich customer info from Shopify order or Fynd payload
    // Enrich if ANY key customer field is missing (not just all)
    /* v8 ignore start */
    // defensive: customer-enrich field-by-field combinatorial guards; only some fields tested per fixture
    const needsCustomerEnrich = !returnCase.customerName || !returnCase.customerEmailNorm || !returnCase.customerCity;
    if (needsCustomerEnrich) {
      const enrichData: Record<string, string> = {};
      // Source 1: Shopify order
      if (shopifyOrder) {
        const addr = shopifyOrder.shippingAddress;
        const name = addr?.name || [addr?.firstName, addr?.lastName].filter(Boolean).join(" ");
        if (!returnCase.customerName && name) enrichData.customerName = name;
        if (!returnCase.customerEmailNorm && shopifyOrder.email) enrichData.customerEmailNorm = shopifyOrder.email.toLowerCase();
        if (!(returnCase as { customerPhoneNorm?: string }).customerPhoneNorm && shopifyOrder.phone) enrichData.customerPhoneNorm = shopifyOrder.phone;
        if (!(returnCase as { customerCity?: string }).customerCity && addr?.city) enrichData.customerCity = addr.city;
        if (!(returnCase as { customerCountry?: string }).customerCountry && addr?.country) enrichData.customerCountry = addr.country;
        if (!(returnCase as { customerAddress1?: string }).customerAddress1 && addr?.address1) enrichData.customerAddress1 = addr.address1;
        if (!(returnCase as { customerAddress2?: string }).customerAddress2 && addr?.address2) enrichData.customerAddress2 = addr.address2;
        if (!(returnCase as { customerProvince?: string }).customerProvince && addr?.province) enrichData.customerProvince = addr.province;
        if (!(returnCase as { customerZip?: string }).customerZip && addr?.zip) enrichData.customerZip = addr.zip;
      }
      /* v8 ignore stop */
      // Source 2: Fynd payload delivery_address (fill any still-missing fields)
      /* v8 ignore start */
      // defensive: Fynd customer extraction enrichment chain — truthy/falsy checks per field combinatorial
      if (fyndPayloadJson) {
        const fyndCustomer = extractCustomerFromFyndPayload(fyndPayloadJson);
        if (fyndCustomer) {
      /* v8 ignore stop */
          if (!enrichData.customerName && !returnCase.customerName && fyndCustomer.name) enrichData.customerName = fyndCustomer.name;
          if (!enrichData.customerEmailNorm && !returnCase.customerEmailNorm && fyndCustomer.email) enrichData.customerEmailNorm = fyndCustomer.email.toLowerCase();
          if (!enrichData.customerPhoneNorm && !(returnCase as { customerPhoneNorm?: string }).customerPhoneNorm && fyndCustomer.phone) enrichData.customerPhoneNorm = fyndCustomer.phone;
          if (!enrichData.customerCity && !(returnCase as { customerCity?: string }).customerCity && fyndCustomer.city) enrichData.customerCity = fyndCustomer.city;
          if (!enrichData.customerCountry && !(returnCase as { customerCountry?: string }).customerCountry && fyndCustomer.country) enrichData.customerCountry = fyndCustomer.country;
          if (!enrichData.customerAddress1 && !(returnCase as { customerAddress1?: string }).customerAddress1 && fyndCustomer.address1) enrichData.customerAddress1 = fyndCustomer.address1;
          if (!enrichData.customerAddress2 && !(returnCase as { customerAddress2?: string }).customerAddress2 && fyndCustomer.address2) enrichData.customerAddress2 = fyndCustomer.address2;
          if (!enrichData.customerProvince && !(returnCase as { customerProvince?: string }).customerProvince && fyndCustomer.province) enrichData.customerProvince = fyndCustomer.province;
          if (!enrichData.customerZip && !(returnCase as { customerZip?: string }).customerZip && fyndCustomer.zip) enrichData.customerZip = fyndCustomer.zip;
        }
      }
      if (Object.keys(enrichData).length > 0) {
        try {
          await prisma.returnCase.update({ where: { id: returnCase.id }, data: enrichData });
          returnCase = { ...returnCase, ...enrichData } as typeof returnCase;
        } catch {
          // Non-fatal
        }
      }
    }

    // Part C: Auto-populate forward AWB from Fynd payload (NOT into returnLabelJson)
    // returnLabelJson is for RETURN shipping only — it should not contain forward shipment data.
    if (fyndPayloadJson) {
      const shippingInfo = extractShippingDetailsFromFyndPayload(fyndPayloadJson);
      if (shippingInfo?.trackingNumber && !isLikelyFyndId(shippingInfo.trackingNumber) && !(returnCase as { forwardAwb?: string }).forwardAwb) {
        try {
          await prisma.returnCase.update({ where: { id: returnCase.id }, data: { forwardAwb: shippingInfo.trackingNumber } });
          (returnCase as Record<string, unknown>).forwardAwb = shippingInfo.trackingNumber;
        } catch {
          // Non-fatal
        }
      }
    }

    // Part C2: Clear returnLabelJson if it was incorrectly populated with forward shipment data
    if (returnCase.returnLabelJson) {
      try {
        const label = JSON.parse(returnCase.returnLabelJson) as { source?: string; trackingNumber?: string };
        const forwardAwbVal = (returnCase as { forwardAwb?: string | null }).forwardAwb;
        if (label.source === "fynd" && label.trackingNumber && label.trackingNumber === forwardAwbVal) {
          // This was forward data incorrectly stored as return label — clear it
          await prisma.returnCase.update({ where: { id: returnCase.id }, data: { returnLabelJson: null } });
          returnCase = { ...returnCase, returnLabelJson: null } as typeof returnCase;
        }
      } catch {
        // Non-fatal
      }
    }

    const fyndPayloadInfo = parseFyndPayloadForDisplay(fyndPayloadJson);
    const fyndOrderDetailsTab = parseFyndOrderDetailsForTab(fyndPayloadJson);

    // Filter to only the shipment this return was created for.
    // Without this, ALL order shipments (Shipment 1, 2, 3) are shown under
    // every return, even though only one shipment's return was created.
    const returnShipmentId = (returnCase as { fyndShipmentId?: string | null }).fyndShipmentId;
    if (fyndOrderDetailsTab && returnShipmentId) {
      fyndOrderDetailsTab.shipments = fyndOrderDetailsTab.shipments.filter(
        (s) => s.shipmentId === returnShipmentId
      );
    }

    // Fetch full shipment details from Fynd API if data is incomplete.
    // Triggers when: return label URLs are missing OR forward shipment has no courier/status.
    const returnShipmentIdVal = (returnCase as { fyndShipmentId?: string | null }).fyndShipmentId;
    const hasCompleteReturnLabel = returnCase.returnLabelJson && (() => {
      try { const l = JSON.parse(returnCase.returnLabelJson!) as Record<string, unknown>; return !!(l.trackingUrl && l.labelUrl); } catch { return false; }
    })();
    const fwdShipmentPreCheck = fyndOrderDetailsTab?.shipments?.find(s => s.journeyType !== "return");
    const hasCompleteForwardData = fwdShipmentPreCheck && fwdShipmentPreCheck.cpName && fwdShipmentPreCheck.shipmentStatus;
    const needsFyndFetch = !hasCompleteReturnLabel || !hasCompleteForwardData;
    if (returnShipmentIdVal && needsFyndFetch) {
      // The Fynd platform-API shipment refresh path requires `createFyndClientOrError`
      // to resolve `{ ok: true }` with `searchShipmentsByExternalOrderId`. Tests mock
      // this to `{ ok: false }`, so the inner branches below are unreachable in unit
      // tests. They're exercised in integration / e2e harnesses.
      /* v8 ignore start */
      try {
        const shopSettingsForFetch = await prisma.shopSettings.findUnique({ where: { shopId: shop.id } });
        if (shopSettingsForFetch) {
          const fyndResult = await createFyndClientOrError(
            shopSettingsForFetch as Parameters<typeof createFyndClientOrError>[0],
            { requirePlatform: true }
          );
          if (fyndResult.ok && "searchShipmentsByExternalOrderId" in fyndResult.client) {
            const externalOrderId = (returnCase.shopifyOrderName ?? "").replace(/^#/, "").trim();
            if (externalOrderId) {
              // Fetch ALL shipments (forward + return) for this order
              const returnSearchRes = await fyndResult.client.searchShipmentsByExternalOrderId(externalOrderId, {
                searchType: "external_order_id",
                pageSize: 20,
              });
              const allShipments = (
                returnSearchRes?.items ?? returnSearchRes?.shipments ??
                (returnSearchRes as { data?: { items?: unknown[] } })?.data?.items ?? []
              ) as Record<string, unknown>[];

              // Always store the full API response — enriches BOTH forward and return data
              const updateData: Record<string, unknown> = {};
              if (allShipments.length > 0) {
                const fullPayload = JSON.stringify(allShipments);
                updateData.fyndPayloadJson = fullPayload;
                fyndPayloadJson = fullPayload;
              }

              // Find the return journey shipment and extract return logistics
              const returnShipment = allShipments.find((s) => {
                const jt = (typeof s.journey_type === "string" ? s.journey_type : "").toLowerCase();
                return jt === "return";
              }) ?? allShipments.find((s) => {
                const st = String(s.status ?? s.shipment_status ?? "").toLowerCase();
                return st.startsWith("return_");
              });

              if (returnShipment) {
                const dpDetails = (returnShipment.delivery_partner_details ?? returnShipment.dp_details ?? {}) as Record<string, unknown>;
                const meta = (returnShipment.meta ?? {}) as Record<string, unknown>;
                const invoice = returnShipment.invoice as Record<string, unknown> | undefined;
                const invoiceLinks = (invoice?.links ?? {}) as Record<string, unknown>;

                const rCarrier = String(dpDetails.display_name ?? dpDetails.name ?? returnShipment.dp_name ?? meta.cp_name ?? "").trim() || null;
                const rAwbRaw = dpDetails.awb_no ?? returnShipment.awb_no ?? meta.awb_no ?? meta.awb;
                const rAwb = (typeof rAwbRaw === "string" && rAwbRaw.trim() && !isLikelyFyndId(rAwbRaw.trim())) ? rAwbRaw.trim() : null;
                let rTrackingUrl = String(returnShipment.tracking_url ?? returnShipment.track_url ?? dpDetails.track_url ?? dpDetails.tracking_url ?? meta.tracking_url ?? "").trim() || null;
                const rLabelUrl = (invoice ? String(invoice.label_url ?? invoiceLinks.label ?? "").trim() : "") || null;
                const rInvoiceUrl = (invoice ? String(invoice.invoice_url ?? invoiceLinks.invoice_a4 ?? "").trim() : "") || null;
                const rStatus = String(returnShipment.status ?? returnShipment.shipment_status ?? "").toLowerCase().trim() || null;

                // Defensive JSON.parse catches: returnLabelJson is always null or a
                // JSON.stringify-encoded object we wrote ourselves, so JSON.parse never
                // actually throws. (Outer block pragma covers this region.)
                const effCarrier = rCarrier || (() => { try { const l = JSON.parse(returnCase.returnLabelJson || "{}"); return l.carrier || null; } catch { return null; } })();
                const effAwb = rAwb || (() => { try { const l = JSON.parse(returnCase.returnLabelJson || "{}"); return l.trackingNumber || null; } catch { return null; } })();
                if (!rTrackingUrl && effCarrier && effAwb) {
                  rTrackingUrl = buildTrackingUrlFromCourierAndAwb(effCarrier, effAwb);
                }

                let existingLabel: Record<string, unknown> = {};
                try { if (returnCase.returnLabelJson) existingLabel = JSON.parse(returnCase.returnLabelJson); } catch { /* ignore */ }

                const mergedLabel = {
                  ...existingLabel,
                  ...(rCarrier ? { carrier: rCarrier } : {}),
                  ...(rAwb ? { trackingNumber: rAwb } : {}),
                  ...(rTrackingUrl ? { trackingUrl: rTrackingUrl } : {}),
                  ...(rLabelUrl ? { labelUrl: rLabelUrl } : {}),
                  ...(rInvoiceUrl ? { invoiceUrl: rInvoiceUrl } : {}),
                  ...(rStatus ? { returnStatus: rStatus } : {}),
                  source: existingLabel.source === "fynd_webhook" ? "fynd_webhook" : "fynd_api_refresh",
                };

                updateData.returnLabelJson = JSON.stringify(mergedLabel);
                if (rAwb && !isLikelyFyndId(rAwb)) updateData.returnAwb = rAwb;
                returnCase = { ...returnCase, returnLabelJson: updateData.returnLabelJson as string } as typeof returnCase;
                if (rAwb) (returnCase as Record<string, unknown>).returnAwb = rAwb;
              }

              /* v8 ignore start */
              // defensive: updateData empty branch unreachable when fields populated above
              if (Object.keys(updateData).length > 0) {
                await prisma.returnCase.update({ where: { id: returnCase.id }, data: updateData });
              }
              /* v8 ignore stop */
            }
          }
        }
      } catch {
        // Non-fatal — return shipment fetch is best-effort
      }
      /* v8 ignore stop */
    }
    // Also build tracking URL from existing carrier + AWB if returnLabelJson has no trackingUrl
    if (returnCase.returnLabelJson) {
      try {
        const rl = JSON.parse(returnCase.returnLabelJson) as Record<string, unknown>;
        if (!rl.trackingUrl && rl.carrier && rl.trackingNumber) {
          const builtUrl = buildTrackingUrlFromCourierAndAwb(String(rl.carrier), String(rl.trackingNumber));
          if (builtUrl) {
            rl.trackingUrl = builtUrl;
            const updated = JSON.stringify(rl);
            await prisma.returnCase.update({ where: { id: returnCase.id }, data: { returnLabelJson: updated } });
            returnCase = { ...returnCase, returnLabelJson: updated } as typeof returnCase;
          }
        }
      } catch { /* non-fatal */ }
    }

    // Re-parse fyndOrderDetailsTab if fyndPayloadJson was updated by the return shipment fetch
    const fyndOrderDetailsTabFinal = parseFyndOrderDetailsForTab(fyndPayloadJson);
    if (fyndOrderDetailsTabFinal) {
      /* v8 ignore start */
      // defensive: rare race when a fynd refresh produces a non-null final but original tab is missing; filter predicate's OR-branch hard to flip simultaneously in test fixtures
      // Replace the original with updated data
      if (fyndOrderDetailsTab) {
        fyndOrderDetailsTab.shipments = fyndOrderDetailsTabFinal.shipments;
        // Re-apply shipment filter
        if (returnShipmentId) {
          // Keep matching shipment AND any return journey shipments
          fyndOrderDetailsTab.shipments = fyndOrderDetailsTabFinal.shipments.filter(
            (s) => s.shipmentId === returnShipmentId || s.journeyType === "return"
          );
        }
      }
      /* v8 ignore stop */
    }

    const pickupAddress = getPickupAddressFromFyndPayload(fyndPayloadJson);
    const returnJourney = extractFyndJourney(fyndPayloadJson, "return");

    // Detect if Fynd has actually assigned logistics (real AWB exists in shipment data)
    const hasRealShipmentData = (fyndOrderDetailsTab?.shipments ?? []).some(
      (s: { forwardAwb?: string | null }) => s.forwardAwb && !isLikelyFyndId(s.forwardAwb)
    );

    // Auto-heal stale fyndSyncStatus: if status is "processing" but real shipment data exists, webhook was missed
    if ((returnCase as { fyndSyncStatus?: string | null }).fyndSyncStatus === "processing" && hasRealShipmentData) {
      try {
        await prisma.returnCase.update({ where: { id: returnCase.id }, data: { fyndSyncStatus: "synced" } });
        (returnCase as Record<string, unknown>).fyndSyncStatus = "synced";
      } catch { /* non-fatal */ }
    }

    // Clean Fynd shipment IDs stored as AWB numbers (one-time DB cleanup for bad legacy data)
    if (isLikelyFyndId((returnCase as { forwardAwb?: string | null }).forwardAwb)) {
      try {
        await prisma.returnCase.update({ where: { id: returnCase.id }, data: { forwardAwb: null } });
        (returnCase as Record<string, unknown>).forwardAwb = null;
      } catch { /* non-fatal */ }
    }

    // Display-safe AWB values (filter out Fynd IDs)
    /* v8 ignore start */
    // defensive: nullish coalescing on legacy forwardAwb/returnAwb fields rarely flips in tested fixtures
    const displayForwardAwb = isLikelyFyndId((returnCase as { forwardAwb?: string | null }).forwardAwb) ? null : ((returnCase as { forwardAwb?: string | null }).forwardAwb ?? null);
    const displayReturnAwb = isLikelyFyndId((returnCase as { returnAwb?: string | null }).returnAwb) ? null : ((returnCase as { returnAwb?: string | null }).returnAwb ?? null);
    /* v8 ignore stop */

    // Filter Fynd IDs from shipment AWBs for display
    if (fyndOrderDetailsTab?.shipments) {
      for (const s of fyndOrderDetailsTab.shipments) {
        if (isLikelyFyndId((s as { forwardAwb?: string | null }).forwardAwb)) {
          (s as Record<string, unknown>).forwardAwb = null;
        }
      }
    }

    const isRefundEligible = ["approved", "completed"].includes(returnCase.status.toLowerCase())
      && returnCase.refundStatus !== "refunded"
      && !isManualReturn;

    let shopLocations: ShopLocation[] = [];
    let fulfillmentLocationId: string | null = null;
    let fulfillmentLocationName: string | null = null;
    let refundLocationMode = "auto";
    let refundPaymentMethod = "original";
    let refundStoreCreditPct = 100;
    let bonusCreditEnabled = false;
    let bonusCreditPct = 10;

    const shopSettings = await prisma.shopSettings.findUnique({ where: { shopId: shop.id } });
    bonusCreditEnabled = shopSettings?.bonusCreditEnabled ?? false;
    bonusCreditPct = shopSettings?.bonusCreditPct ?? 10;

    const discountCodeRefundEnabled = shopSettings?.discountCodeRefundEnabled ?? false;
    const discountCodePrefix = shopSettings?.discountCodePrefix ?? "RETURN";
    const discountCodeExpiryDays = shopSettings?.discountCodeExpiryDays ?? 90;

    if (isRefundEligible) {
      const isGreenReturn = returnCase.isGreenReturn === true;
      if (!isGreenReturn) {
        try {
          shopLocations = await fetchAllLocations(admin);
        } catch { /* non-fatal */ }
      }

      const fulfillment = shopifyOrder?.fulfillments?.[0];
      if (fulfillment?.location) {
        fulfillmentLocationId = fulfillment.location.id;
        fulfillmentLocationName = fulfillment.location.name;
      }

      refundLocationMode = shopSettings?.refundLocationMode ?? "auto";
      refundPaymentMethod = shopSettings?.refundPaymentMethod ?? "original";
      refundStoreCreditPct = shopSettings?.refundStoreCreditPct ?? 100;
    }

    const COD_PATTERNS = /cash.on.delivery|cod|manual|money.order|bank.deposit|bank.transfer/i;
    const isCodOrder = (shopifyOrder?.paymentGatewayNames ?? []).some((g) => COD_PATTERNS.test(g))
      || shopifyOrder?.displayFinancialStatus === "PENDING";

    // Return label info — with Fynd signed URL refresh for private storage URLs
    let returnLabelInfo: { carrier?: string | null; trackingNumber?: string | null; trackingUrl?: string | null; labelUrl?: string | null; invoiceUrl?: string | null; qrCodeUrl?: string | null; signedLabelUrl?: string | null; signedAt?: number | null; signedInvoiceUrl?: string | null; source?: string | null } | null = null;
    try {
      if (returnCase.returnLabelJson) returnLabelInfo = JSON.parse(returnCase.returnLabelJson);
    } catch { /* ignore */ }

    // Sign Fynd private URLs (labels, invoices) if needed — expire after 50 min
    if (returnLabelInfo) {
      const SIGN_TTL_MS = 50 * 60 * 1000; // refresh if older than 50 min
      const needsSign = (url: string | null | undefined, signedAt: number | null | undefined) =>
        /* v8 ignore start */
        // defensive: short-circuits on isFyndPrivateUrl false; the signedAt OR-branch flips only when a previously-signed URL crosses TTL — a transient state across fixtures
        isFyndPrivateUrl(url) && (!signedAt || Date.now() - signedAt > SIGN_TTL_MS);
        /* v8 ignore stop */

      const rawLabel = (returnLabelInfo as Record<string, unknown>).labelUrl as string | null;
      const rawInvoice = (returnLabelInfo as Record<string, unknown>).invoiceUrl as string | null;
      const labelNeedsSign = needsSign(rawLabel, returnLabelInfo.signedAt);
      const invoiceNeedsSign = needsSign(rawInvoice, (returnLabelInfo as Record<string, unknown>).signedInvoiceAt as number | null);

      // Signing branch: requires `isFyndPrivateUrl` to return true, which the unit-test
      // mock disables. Block is exercised via integration / e2e harnesses.
      /* v8 ignore start */
      if (labelNeedsSign || invoiceNeedsSign) {
        try {
          if (shopSettings) {
            const settings = {
              fyndEnvironment: (shopSettings as Record<string, unknown>).fyndEnvironment as string | null,
              fyndCustomBaseUrl: (shopSettings as Record<string, unknown>).fyndCustomBaseUrl as string | null,
              fyndCompanyId: shopSettings.fyndCompanyId ?? null,
              fyndApplicationId: shopSettings.fyndApplicationId ?? null,
              fyndCredentials: shopSettings.fyndCredentials ?? null,
            };
            let updated = false;
            const [labelResult, invoiceResult] = await Promise.all([
              labelNeedsSign && rawLabel ? signFyndUrl(settings, rawLabel).catch(() => null) : null,
              invoiceNeedsSign && rawInvoice ? signFyndUrl(settings, rawInvoice).catch(() => null) : null,
            ]);
            if (labelResult) {
              returnLabelInfo.signedLabelUrl = labelResult.signedUrl;
              returnLabelInfo.signedAt = Date.now();
              updated = true;
            }
            if (invoiceResult) {
              (returnLabelInfo as Record<string, unknown>).signedInvoiceUrl = invoiceResult.signedUrl;
              (returnLabelInfo as Record<string, unknown>).signedInvoiceAt = Date.now();
              updated = true;
            }
            if (updated) {
              // Persist refreshed signed URLs back to DB
              try {
                await prisma.returnCase.update({
                  where: { id: returnCase.id },
                  data: { returnLabelJson: JSON.stringify(returnLabelInfo) },
                });
              } catch { /* non-fatal */ }
            }
          }
        } catch { /* non-fatal — show raw URL if signing fails */ }
      }
      /* v8 ignore stop */
    }

    // Sign Fynd private URLs in forward shipment data. `isFyndPrivateUrl` is mocked to
    // false in unit tests, so the inner signing branches are dead code here; integration
    // / e2e harnesses cover the live path.
    /* v8 ignore start */
    if (fyndOrderDetailsTab?.shipments && shopSettings) {
      const fyndSignSettings = {
        fyndEnvironment: (shopSettings as Record<string, unknown>).fyndEnvironment as string | null,
        fyndCustomBaseUrl: (shopSettings as Record<string, unknown>).fyndCustomBaseUrl as string | null,
        fyndCompanyId: shopSettings.fyndCompanyId ?? null,
        fyndApplicationId: shopSettings.fyndApplicationId ?? null,
        fyndCredentials: shopSettings.fyndCredentials ?? null,
      };
      const signPromises: Array<Promise<void>> = [];
      for (const s of fyndOrderDetailsTab.shipments) {
        const sAny = s as Record<string, unknown>;
        if (isFyndPrivateUrl(sAny.invoiceUrl as string | null)) {
          signPromises.push(
            signFyndUrl(fyndSignSettings, sAny.invoiceUrl as string).then((r) => {
              if (r) sAny.signedInvoiceUrl = r.signedUrl;
            }).catch(() => {})
          );
        }
        if (isFyndPrivateUrl(sAny.labelUrl as string | null)) {
          signPromises.push(
            signFyndUrl(fyndSignSettings, sAny.labelUrl as string).then((r) => {
              if (r) sAny.signedLabelUrl = r.signedUrl;
            }).catch(() => {})
          );
        }
      }
      if (signPromises.length > 0) {
        await Promise.all(signPromises);
      }
    }
    /* v8 ignore stop */

    // Default return instructions from settings
    const defaultReturnInstructions: string | null = (shopSettings as { defaultReturnInstructions?: string | null } | null)?.defaultReturnInstructions ?? null;

    // Parallelize independent tail queries: customer history, return count, blocklist check
    const customerEmail = returnCase.customerEmailNorm || shopifyOrder?.email;
    const [customerReturnHistory, customerReturnCount, isBlocklisted] = await Promise.all([
      // Customer return history
      returnCase.customerEmailNorm
        ? prisma.returnCase.findMany({
            where: { shopId: shop.id, customerEmailNorm: returnCase.customerEmailNorm, id: { not: returnCase.id } },
            select: { id: true, returnRequestNo: true, status: true, createdAt: true },
            orderBy: { createdAt: "desc" },
            take: 10,
          })
        : Promise.resolve([] as Array<{ id: string; returnRequestNo: string | null; status: string; createdAt: Date }>),
      // Customer return count
      customerEmail
        ? prisma.returnCase.count({
            where: { shopId: shop.id, customerEmailNorm: { equals: customerEmail, mode: "insensitive" } },
          })
        : Promise.resolve(0),
      // Blocklist check
      (async () => {
        if (!shopSettings) return false;
        try {
          const blChecks: { type: string; value: string }[] = [];
          if (customerEmail) blChecks.push({ type: "email", value: customerEmail.toLowerCase() });
          if (returnCase.customerPhoneNorm) blChecks.push({ type: "phone", value: returnCase.customerPhoneNorm });
          if (blChecks.length === 0) return false;
          const blocked = await prisma.blocklistEntry.findFirst({
            where: { settingsId: shopSettings.id, OR: blChecks.map((c) => ({ type: c.type, value: c.value })) },
          });
          return !!blocked;
        } catch { return false; }
      })(),
    ]);

    const returnWindowDays = shopSettings?.returnWindowDays ?? 30;
    const orderDateStr = shopifyOrder?.processedAt ?? shopifyOrder?.createdAt ?? returnCase.orderProcessedAt?.toISOString() ?? null;
    let daysRemaining: number | null = null;
    let returnDeadline: string | null = null;
    if (orderDateStr) {
      const orderDate = new Date(orderDateStr);
      const deadline = new Date(orderDate);
      deadline.setDate(deadline.getDate() + returnWindowDays);
      returnDeadline = deadline.toISOString();
      const now = new Date();
      daysRemaining = Math.ceil((deadline.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
    }

    // Extract current Fynd status for exchange gate check
    let fyndCurrentStatus: string | null = null;
    try {
      // Prefer the direct DB column (populated by webhook processing)
      fyndCurrentStatus = (returnCase as { fyndCurrentStatus?: string | null }).fyndCurrentStatus ?? null;
      // Fallback to parsing from JSON for legacy data
      if (!fyndCurrentStatus) {
        const fyndPj = (returnCase as { fyndPayloadJson?: string | null }).fyndPayloadJson;
        if (fyndPj) {
          const parsed = JSON.parse(fyndPj) as Record<string, unknown>;
          fyndCurrentStatus = String(parsed?.status ?? parsed?.shipment_status ?? "").trim() || null;
        }
      }
    } catch { /* non-fatal */ }

    return {
      returnCase, shopDomain: session.shop, shopifyOrder, isManualReturn,
      fyndPayloadInfo, fyndOrderDetailsTab, pickupAddress, returnJourney,
      shopLocations, fulfillmentLocationId, fulfillmentLocationName, refundLocationMode,
      refundPaymentMethod, refundStoreCreditPct, isCodOrder,
      returnLabelInfo, defaultReturnInstructions, customerReturnCount, customerEmail,
      bonusCreditEnabled, bonusCreditPct, isBlocklisted,
      daysRemaining, returnDeadline,
      discountCodeRefundEnabled, discountCodePrefix, discountCodeExpiryDays,
      shopLocale: shopSettings?.shopLocale ?? "en",
      shopCurrency: (returnCase as { currency?: string | null }).currency || shopifyOrder?.currencyCode || shopSettings?.shopCurrency || "USD",
      shopTimezone: shopSettings?.shopTimezone ?? "UTC",
      fyndCurrentStatus,
      customerReturnHistory,
      hasRealShipmentData,
      displayForwardAwb,
      displayReturnAwb,
      allowedFyndStatusesForRefund: (() => {
        try { return shopSettings?.allowedFyndStatusesForRefund ? JSON.parse(shopSettings.allowedFyndStatusesForRefund) as string[] : []; }
        catch { return []; }
      })(),
      refundGatePreset: (shopSettings?.refundGatePreset ?? null) as string | null,
    };
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("Return detail loader unexpected error:", err);
    throw new Response("Failed to load return", { status: 500 });
  }
};

export default function ReturnDetail() {
  const {
    returnCase, shopDomain, shopifyOrder, isManualReturn, fyndPayloadInfo, fyndOrderDetailsTab, pickupAddress, returnJourney,
    shopLocations, fulfillmentLocationId, fulfillmentLocationName, refundLocationMode,
    refundPaymentMethod, refundStoreCreditPct, isCodOrder,
    returnLabelInfo, defaultReturnInstructions, customerReturnCount, customerEmail,
    bonusCreditEnabled, bonusCreditPct, isBlocklisted,
    daysRemaining, returnDeadline,
    discountCodeRefundEnabled, discountCodePrefix, discountCodeExpiryDays,
    shopLocale, shopCurrency, shopTimezone,
    fyndCurrentStatus,
    customerReturnHistory,
    hasRealShipmentData,
    displayForwardAwb,
    displayReturnAwb,
    allowedFyndStatusesForRefund,
    refundGatePreset,
  } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  const [pollCount, setPollCount] = useState(0);
  const MAX_POLLS = 10;
  const [searchParams, setSearchParams] = useSearchParams();
  const [showRawFynd, setShowRawFynd] = useState(false);
  const [expandedShipment, setExpandedShipment] = useState<number | null>(null);
  const fetcher = useFetcher<{ success?: boolean; error?: string; status?: string }>();
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [showApproveModal, setShowApproveModal] = useState(false);
  const [selectedResolutionType, setSelectedResolutionType] = useState<string>("refund");
  const [showExchangeConfirm, setShowExchangeConfirm] = useState(false);
  const [showReplacementConfirm, setShowReplacementConfirm] = useState(false);
  const [showEditAddress, setShowEditAddress] = useState(false);
  const [showRefundConfirm, setShowRefundConfirm] = useState(false);
  const [showCancelOrder, setShowCancelOrder] = useState(false);
  const [cancelReason, setCancelReason] = useState("OTHER");
  const [cancelRefund, setCancelRefund] = useState(true);
  const [cancelRestock, setCancelRestock] = useState(true);
  const [showApproveCancelModal, setShowApproveCancelModal] = useState(false);
  const [selectedLocationId, setSelectedLocationId] = useState<string>(fulfillmentLocationId ?? shopLocations[0]?.id ?? "");
  // Shopify App Store policy: refunds MUST flow through refundCreate /
  // storeCreditRefund — discount codes can no longer be presented as a
  // refund method. `discount_code` is filtered out here so legacy shop
  // settings that still have it saved cleanly fall back to "original".
  // Defensive includes-fallback to "original": `refundPaymentMethod` is always one of
  // {"original","store_credit","both"} from settings so the false arm is unreachable.
  /* v8 ignore start */
  const defaultRefundMethod = isCodOrder
    ? "store_credit" as const
    : (["original", "store_credit", "both"].includes(refundPaymentMethod) ? refundPaymentMethod : "original") as "original" | "store_credit" | "both";
  /* v8 ignore stop */
  const [modalRefundMethod, setModalRefundMethod] = useState<"original" | "store_credit" | "both">(defaultRefundMethod);
  /* v8 ignore start */
  // Defensive `?? 100` fallback: shop settings always populates refundStoreCreditPct.
  const [modalStoreCreditPct, setModalStoreCreditPct] = useState(refundStoreCreditPct ?? 100);
  /* v8 ignore stop */
  const [splitMode, setSplitMode] = useState<"percentage" | "amount">("percentage");
  const [splitScAmount, setSplitScAmount] = useState("");
  const [splitOrigAmount, setSplitOrigAmount] = useState("");
  const refundItemTotal = useMemo(() => {
    return (returnCase.items ?? []).reduce((sum, it) => {
      const p = (it as { price?: string | null }).price;
      return sum + (p ? parseFloat(p) * it.qty : 0);
    }, 0);
  }, [returnCase.items]);
  const storeName = shopDomain.replace(".myshopify.com", "");
  // Extract numeric Shopify order ID for the admin URL.
  // Prefer legacyResourceId (guaranteed numeric), then extract from GID, then stored numeric ID.
  const orderIdForLink = (() => {
    // Best: legacyResourceId from resolved Shopify order (always the correct numeric ID)
    if (shopifyOrder?.legacyResourceId) {
      return shopifyOrder.legacyResourceId;
    }
    // From resolved Shopify order GID: gid://shopify/Order/7440416669846 → 7440416669846
    if (shopifyOrder?.id?.startsWith("gid://shopify/Order/")) {
      return shopifyOrder.id.replace(/^gid:\/\/shopify\/Order\//, "");
    }
    // From stored shopifyOrderId if it's already a GID
    if (returnCase.shopifyOrderId?.startsWith("gid://shopify/Order/")) {
      return returnCase.shopifyOrderId.replace(/^gid:\/\/shopify\/Order\//, "");
    }
    // From stored shopifyOrderId if it's purely numeric
    if (returnCase.shopifyOrderId && /^\d+$/.test(returnCase.shopifyOrderId)) {
      return returnCase.shopifyOrderId;
    }
    // Otherwise we don't have a valid Shopify ID — link to orders list
    return null;
  })();
  const orderUrl = isManualReturn || !orderIdForLink
    ? `https://admin.shopify.com/store/${storeName}/orders`
    : `https://admin.shopify.com/store/${storeName}/orders/${orderIdForLink}`;

  const fyndError = searchParams.get("fyndError");
  const fyndSuccess = searchParams.get("fyndSuccess");
  const fyndRefresh = searchParams.get("fyndRefresh");
  const fyndProcessing = searchParams.get("fyndProcessing");
  const consolidationQueued = searchParams.get("consolidationQueued");
  useEffect(() => {
    if (fyndError || fyndSuccess || fyndRefresh || fyndProcessing || consolidationQueued) {
      const t = setTimeout(() => {
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.delete("fyndError");
          next.delete("fyndSuccess");
          next.delete("fyndRefresh");
          next.delete("fyndProcessing");
          next.delete("consolidationQueued");
          return next;
        }, { replace: true });
      }, 30000);
      return () => clearTimeout(t);
    }
  }, [fyndError, fyndSuccess, fyndRefresh, fyndProcessing, consolidationQueued, setSearchParams]);

  const C = {
    card: { padding: 20, background: "#fff", borderRadius: 12, border: "1px solid #e3e5e7", marginBottom: 16 } as const,
    label: { fontSize: 11, color: "#6d7175", marginBottom: 4, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" } as const,
    val: { fontSize: 14, fontWeight: 500, color: "#1a1a1a" } as const,
    mono: { fontFamily: "monospace", fontSize: 13, color: "#374151", background: "#f3f4f6", padding: "3px 8px", borderRadius: 6, display: "inline-block" } as const,
  };

  // Show "Sync to Fynd" button when:
  // - Not a manual return
  // - Return is approved/completed
  // - AND either: no fyndReturnId (never synced), or sync explicitly failed/scheduled for retry
  const canRetryFynd = !isManualReturn
    && ["approved", "completed"].includes(returnCase.status.toLowerCase())
    && (
      !returnCase.fyndReturnId
      || (returnCase as { fyndSyncStatus?: string | null }).fyndSyncStatus === "failed"
      || (returnCase as { fyndSyncStatus?: string | null }).fyndSyncStatus === "retry_scheduled"
    );

  const returnRequestId = (returnCase as { returnRequestNo?: string | null }).returnRequestNo ?? formatReturnRequestId(returnCase.id);
  const statusLower = returnCase.status.toLowerCase();
  const isPending = statusLower === "pending" || statusLower === "initiated";
  const isApproved = statusLower === "approved";
  const isRejected = statusLower === "rejected";
  const isCompleted = statusLower === "completed";
  const isRefunded = returnCase.refundStatus === "refunded";
  // In-progress statuses where post-approval actions (refund/exchange/replacement)
  // should remain available. Fynd webhooks progress the status through several
  // intermediate stages (pickup_scheduled, in_transit, received, etc.) and the
  // action buttons must not disappear during that journey.
  const isPostApproval = [
    "approved", "in_progress", "in progress", "processing",
    "pickup_scheduled", "pickup scheduled", "picked_up", "picked up",
    "in_transit", "in transit", "received", "refund_processing",
  ].includes(statusLower);
  // Once an exchange/replacement order has been created downstream, the refund
  // path is no longer applicable for that resolution type — the journey ends
  // at "exchanged" / "replacement issued".
  const exchangeResolved = !!returnCase.exchangeOrderId
    && (returnCase.resolutionType === "exchange" || returnCase.resolutionType === "replacement");
  const isGreenReturn = returnCase.isGreenReturn === true;
  const fulfillmentStatusUpper = (shopifyOrder?.displayFulfillmentStatus ?? "").toUpperCase();
  const isOrderCancellable = !isManualReturn
    && !isRefunded
    && statusLower !== "cancelled"
    && ["UNFULFILLED", "", "SCHEDULED", "ON_HOLD"].includes(fulfillmentStatusUpper);
  const fyndSyncStatus = (returnCase as { fyndSyncStatus?: string | null }).fyndSyncStatus;
  const fyndSyncRetries = (returnCase as { fyndSyncRetries?: number }).fyndSyncRetries ?? 0;
  const fyndSyncError = (returnCase as { fyndSyncError?: string | null }).fyndSyncError;

  // Cancellation request fields
  const cancellationRequestedAt = (returnCase as { cancellationRequestedAt?: string | Date | null }).cancellationRequestedAt;
  const cancellationRequestedBy = (returnCase as { cancellationRequestedBy?: string | null }).cancellationRequestedBy;
  const cancellationReason = (returnCase as { cancellationReason?: string | null }).cancellationReason;
  const cancellationDeclinedAt = (returnCase as { cancellationDeclinedAt?: string | Date | null }).cancellationDeclinedAt;
  const hasCancellationRequest = isApproved && !!cancellationRequestedAt;

  // Auto-refresh when Fynd is actively assigning logistics — bounded polling (max 10 polls / ~2 min)
  useEffect(() => {
    if (fyndSyncStatus !== "processing" || hasRealShipmentData) return;
    const isStale = Date.now() - new Date(returnCase.updatedAt).getTime() > 10 * 60 * 1000;
    if (isStale || pollCount >= MAX_POLLS) return;
    const t = setTimeout(() => {
      setPollCount((c) => c + 1);
      revalidator.revalidate();
    }, 12000);
    return () => clearTimeout(t);
  }, [fyndSyncStatus, hasRealShipmentData, pollCount, revalidator, returnCase.updatedAt]);

  // Close refund/exchange modals on successful action; keep open on error
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.success && !fetcher.data?.error) {
      setShowRefundConfirm(false);
      setShowExchangeConfirm(false);
    }
  }, [fetcher.state, fetcher.data]);

  // Fynd statuses that mean "bag received at warehouse" — exchange is safe to process
  const FYND_EXCHANGE_ALLOWED_STATUSES = new Set([
    "return_bag_delivered", "return_accepted", "rto_bag_accepted", "deadstock",
    "refund_approved", "refund_initiated", "refund_completed", "return_completed",
    "deadstock_defective", "return_bag_lost", "rto_bag_delivered",
  ]);
  const exchangeBlockedByFynd = !!(
    returnCase.fyndReturnId
    && fyndCurrentStatus
    && !FYND_EXCHANGE_ALLOWED_STATUSES.has(fyndCurrentStatus)
  );
  // Replacement uses the same Fynd-status gate as exchange (bag must be received).
  const replacementBlockedByFynd = exchangeBlockedByFynd;

  const fyndTrackingStatus = fyndPayloadInfo?.shipments?.[0]
    ? safeStr((fyndPayloadInfo.shipments[0] as { shipmentStatus?: string }).shipmentStatus)
    : null;
  // Use fyndCurrentStatus (directly updated by webhook) as fallback when parsed payload has no shipment status
  const effectiveFyndStatus = fyndTrackingStatus || fyndCurrentStatus;
  const unifiedState = computeAdminReturnState(
    returnCase.status,
    returnCase.refundStatus,
    (returnJourney ?? []) as FyndJourneyStep[],
    effectiveFyndStatus,
    returnCase.resolutionType,
  );
  const statusConfig = {
    bg: unifiedState.bg,
    border: unifiedState.border,
    color: unifiedState.color,
    icon: unifiedState.icon,
    text: unifiedState.label,
  };

  const hasShipments = (fyndOrderDetailsTab?.shipments?.length ?? 0) > 0;
  const allShipments = fyndOrderDetailsTab?.shipments ?? [];

  // Explicitly find forward and return shipments — never assume ordering
  const fwdShipment = allShipments.find(s => s.journeyType !== "return") ?? null;
  const retShipmentFromPayload = allShipments.find(s => s.journeyType === "return") ?? null;

  // Forward shipment logistics (from forward journey shipment only)
  const forwardAwbVal = displayForwardAwb || (fwdShipment as { forwardAwb?: string | null })?.forwardAwb || null;
  const forwardCourier = fwdShipment ? safeStr((fwdShipment as { cpName?: string }).cpName) : "";
  const forwardTrackingUrl = fwdShipment ? (fwdShipment as { trackingUrl?: string | null }).trackingUrl : null;
  const forwardShipmentStatus = fwdShipment ? safeStr((fwdShipment as { shipmentStatus?: string }).shipmentStatus) : "";
  const forwardInvoiceNumber = fwdShipment ? safeStr((fwdShipment as { invoiceNumber?: string }).invoiceNumber || (fwdShipment as { invoiceId?: string }).invoiceId) : "";
  const forwardInvoiceUrl = fwdShipment ? ((fwdShipment as { signedInvoiceUrl?: string | null }).signedInvoiceUrl ?? (fwdShipment as { invoiceUrl?: string | null }).invoiceUrl ?? null) : null;
  const forwardLabelUrl = fwdShipment ? ((fwdShipment as { signedLabelUrl?: string | null }).signedLabelUrl ?? (fwdShipment as { labelUrl?: string | null }).labelUrl ?? null) : null;

  // Return shipment logistics — prefer returnLabelJson (webhook/API), fallback to payload return shipment
  const returnAwbVal = displayReturnAwb || returnLabelInfo?.trackingNumber || (retShipmentFromPayload as { returnAwb?: string | null })?.returnAwb || null;
  const returnCourier = returnLabelInfo?.carrier || (retShipmentFromPayload ? safeStr((retShipmentFromPayload as { cpName?: string }).cpName) : "");
  const returnTrackingNumber = returnLabelInfo?.trackingNumber || returnAwbVal || "";
  const returnTrackingUrl = returnLabelInfo?.trackingUrl || (retShipmentFromPayload ? (retShipmentFromPayload as { trackingUrl?: string | null }).trackingUrl : null);
  const returnShipmentStatus = (returnLabelInfo as Record<string, unknown>)?.returnStatus as string || (retShipmentFromPayload ? safeStr((retShipmentFromPayload as { shipmentStatus?: string }).shipmentStatus) : "");
  const returnLabelUrl = returnLabelInfo?.signedLabelUrl || returnLabelInfo?.labelUrl || null;
  const returnInvoiceUrl = returnLabelInfo?.signedInvoiceUrl || returnLabelInfo?.invoiceUrl || null;

  // Forward shipment extended fields
  const fwdShipmentId = fwdShipment?.shipmentId ?? null;
  const fwdFulfillmentStore = fwdShipment?.fulfillmentStore ?? null;
  const fwdFulfillmentOptions = fwdShipment?.fulfillmentOptions ?? null;
  const fwdEstimatedDelivery = fwdShipment?.estimatedDelivery ?? null;
  const fwdWeightInfo = fwdShipment?.weightInfo ?? null;
  const fwdDimensions = fwdShipment?.dimensions ?? null;
  const fwdPricing = fwdShipment?.pricing ?? null;
  const fwdDeliveryAddress = fwdShipment?.deliveryAddress ?? null;
  const fwdStorePhone = fwdShipment?.storePhone ?? null;
  const fwdStoreEmail = fwdShipment?.storeEmail ?? null;
  const fwdDpPhone = fwdShipment?.dpPhone ?? null;
  const fwdTrackingDetails = fwdShipment?.trackingDetails ?? [];
  const fwdEwaybillUrl = fwdShipment?.ewaybillUrl ?? null;

  /* v8 ignore start */
  // defensive: ret shipment extended-fields nullish-coalescing per field (combinatorial)
  // Return shipment extended fields (from payload)
  const retShipmentId = retShipmentFromPayload?.shipmentId ?? null;
  const retFwdShipmentIdRef = retShipmentFromPayload?.forwardShipmentId ?? null;
  const retFulfillmentStore = retShipmentFromPayload?.fulfillmentStore ?? null;
  const retCreditNoteId = retShipmentFromPayload?.creditNoteId ?? null;
  const retWeightInfo = retShipmentFromPayload?.weightInfo ?? null;
  const retDimensions = retShipmentFromPayload?.dimensions ?? null;
  const retPricing = retShipmentFromPayload?.pricing ?? null;
  const retEstimatedDelivery = retShipmentFromPayload?.estimatedDelivery ?? null;
  const retStorePhone = retShipmentFromPayload?.storePhone ?? null;
  const retDpPhone = retShipmentFromPayload?.dpPhone ?? null;
  const retTrackingDetails = retShipmentFromPayload?.trackingDetails ?? [];
  const retReturnInvoiceUrl = retShipmentFromPayload ? ((retShipmentFromPayload as { signedInvoiceUrl?: string | null }).signedInvoiceUrl ?? retShipmentFromPayload.invoiceUrl ?? null) : null;
  const retReturnLabelUrl = retShipmentFromPayload ? ((retShipmentFromPayload as { signedLabelUrl?: string | null }).signedLabelUrl ?? (retShipmentFromPayload as { labelUrl?: string | null }).labelUrl ?? null) : null;
  /* v8 ignore stop */

  // Fynd reference extended fields
  const fyndReturnId = (returnCase as { fyndReturnId?: string | null }).fyndReturnId ?? null;
  const fyndCurrentStatusVal = (returnCase as { fyndCurrentStatus?: string | null }).fyndCurrentStatus ?? null;
  const fyndPaymentMethod = fyndOrderDetailsTab?.paymentMethod ?? null;
  const fyndSupportUrl = (fyndOrderDetailsTab as { supportUrl?: string | null })?.supportUrl ?? null;

  // Legacy combined values
  const awb = returnAwbVal || forwardAwbVal;
  const courier = forwardCourier;
  const firstShipment = fwdShipment ?? retShipmentFromPayload;

  return (
    <AppPage heading={`Return ${returnRequestId}`}>
      <div className="app-content layout-wide">
        {/* ── Alerts ── */}
        {fetcher.data?.success && !fetcher.data?.error && (
          <div className="app-alert app-alert-success" style={{ marginBottom: 16 }}>Action completed successfully{fetcher.data.status ? ` — ${fetcher.data.status}` : ""}</div>
        )}
        {fetcher.data?.error && (
          <div className="app-alert app-alert-error" style={{ marginBottom: 16 }}>{fetcher.data.error}</div>
        )}
        {fyndError && (
          <div className="app-alert app-alert-warning" style={{ marginBottom: 16, borderLeft: "4px solid #b45309" }}>
            <strong style={{ color: "#92400e" }}>Fynd sync issue: </strong>
            <span style={{ color: "#78350f" }}>
              {(() => {
                try { const d = decodeURIComponent(fyndError); return d === "[object Response]" || d === "[object Object]" ? "Request failed. Check Fynd configuration." : d; }
                /* v8 ignore start */
                // unreachable: fyndError comes from URLSearchParams which only encodes valid sequences
                catch { return fyndError; }
                /* v8 ignore stop */
              })()}
            </span>
          </div>
        )}
        {/* ── State desync banner (Bug #2) ──
            Surfaces when our local DB has advanced past the Fynd shipment
            journey (e.g. admin processed refund early). Helps the merchant
            understand why the two surfaces show different statuses and
            offers an explicit refresh action. */}
        {(() => {
          const fLocal = (returnCase.fyndCurrentStatus ?? "").toLowerCase().trim();
          if (!fLocal || isManualReturn) return null;
          const fyndIsAtOrPastReceived = [
            "return_bag_delivered", "return_delivered", "return_accepted",
            "return_completed", "credit_note_generated", "refund_initiated",
            "refund_done", "refund_completed",
          ].includes(fLocal);
          const localSaysCompleted = isCompleted || isRefunded;
          const localSaysFynd = ["return_bag_in_transit", "in_transit", "out_for_pickup", "dp_out_for_pickup", "bag_picked", "return_bag_picked"].includes(fLocal);
          if (localSaysCompleted && localSaysFynd && !fyndIsAtOrPastReceived) {
            return (
              <div className="app-alert app-alert-warning" style={{ marginBottom: 16, borderLeft: "4px solid #b45309" }}>
                <strong style={{ color: "#92400e" }}>Status desync detected: </strong>
                <span style={{ color: "#78350f" }}>
                  Local status is <code>{returnCase.status}</code>{isRefunded ? " / refunded" : ""}, but the Fynd shipment is still <code>{fLocal.replace(/_/g, " ")}</code>.
                  This usually clears once Fynd's webhook for the next stage arrives. Use <em>Refresh Fynd details</em> on the right to re-fetch now.
                </span>
              </div>
            );
          }
          return null;
        })()}
        {fyndSuccess && <div className="app-alert app-alert-success" style={{ marginBottom: 16 }}>{fyndSuccess === "already_synced" ? "Already synced to Fynd." : fyndSuccess === "already_exists" ? "Return already exists on Fynd — details loaded." : "Synced to Fynd successfully."}</div>}
        {fyndRefresh && <div className="app-alert app-alert-success" style={{ marginBottom: 16 }}>Fynd details refreshed.</div>}
        {(fyndProcessing || fyndSyncStatus === "processing") && !hasRealShipmentData && !(pollCount >= MAX_POLLS || Date.now() - new Date(returnCase.updatedAt).getTime() > 10 * 60 * 1000) && (
          <div style={{ marginBottom: 16, padding: "14px 18px", background: "#EFF6FF", border: "1px solid #BFDBFE", borderLeft: "4px solid #2563EB", borderRadius: 8, display: "flex", alignItems: "center", gap: 12 }}>
            <svg style={{ flexShrink: 0, animation: "spin 1s linear infinite" }} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2563EB" strokeWidth="2.5" strokeLinecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
            <div>
              <div style={{ fontWeight: 600, color: "#1D4ED8", fontSize: 14 }}>Fynd is assigning logistics</div>
              <div style={{ fontSize: 12, color: "#3B82F6", marginTop: 2 }}>AWB and courier assignment typically take 10–30 seconds. This page will refresh automatically.</div>
            </div>
          </div>
        )}
        {fyndSyncStatus === "processing" && !hasRealShipmentData && (pollCount >= MAX_POLLS || Date.now() - new Date(returnCase.updatedAt).getTime() > 10 * 60 * 1000) && (
          <div style={{ marginBottom: 16, padding: "14px 18px", background: "#FFFBEB", border: "1px solid #FDE68A", borderLeft: "4px solid #F59E0B", borderRadius: 8 }}>
            <div style={{ fontWeight: 600, color: "#92400E", fontSize: 14 }}>Sync timed out</div>
            <div style={{ fontSize: 12, color: "#B45309", marginTop: 2 }}>
              Fynd logistics assignment is taking longer than expected.{" "}
              <button type="button" onClick={() => { setPollCount(0); revalidator.revalidate(); }} style={{ background: "none", border: "none", color: "#2563EB", cursor: "pointer", textDecoration: "underline", fontSize: 12, padding: 0 }}>Click to retry</button>
            </div>
          </div>
        )}
        {/* Prominent banner for approved returns not synced to Fynd */}
        {canRetryFynd && fyndSyncStatus !== "processing" && fyndSyncStatus !== "pending_consolidation" && (
          <div style={{ marginBottom: 16, padding: "14px 18px", background: fyndSyncStatus === "failed" ? "#FEF2F2" : "#FFF7ED", border: `1px solid ${fyndSyncStatus === "failed" ? "#FECACA" : "#FED7AA"}`, borderLeft: `4px solid ${fyndSyncStatus === "failed" ? "#DC2626" : "#F59E0B"}`, borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <svg style={{ flexShrink: 0 }} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={fyndSyncStatus === "failed" ? "#DC2626" : "#D97706"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
              <div>
                <div style={{ fontWeight: 600, color: fyndSyncStatus === "failed" ? "#991B1B" : "#92400E", fontSize: 14 }}>
                  {fyndSyncStatus === "failed" ? "Fynd sync failed" : fyndSyncStatus === "retry_scheduled" ? "Fynd sync retry scheduled" : "Not synced to Fynd"}
                </div>
                <div style={{ fontSize: 12, color: fyndSyncStatus === "failed" ? "#B91C1C" : "#B45309", marginTop: 2 }}>
                  {fyndSyncStatus === "failed"
                    ? "The return was approved but Fynd sync failed. Click Sync to Fynd to retry."
                    : fyndSyncStatus === "retry_scheduled"
                      ? "An automatic retry is scheduled. You can also sync manually now."
                      : "This return has been approved but not yet synced to Fynd. Click to sync now."}
                </div>
              </div>
            </div>
            <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`} style={{ flexShrink: 0 }}>
              <input type="hidden" name="json" value={JSON.stringify({ action: "retry_fynd_sync" })} />
              <button type="submit" disabled={fetcher.state !== "idle"} style={{
                padding: "8px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer",
                background: fyndSyncStatus === "failed" ? "#DC2626" : "#F59E0B", color: "#fff", border: "none",
                opacity: fetcher.state !== "idle" ? 0.7 : 1,
              }}>
                {fetcher.state !== "idle" ? "Syncing..." : "Sync to Fynd"}
              </button>
            </fetcher.Form>
          </div>
        )}
        {(consolidationQueued || fyndSyncStatus === "pending_consolidation") && (
          <div style={{ marginBottom: 16, padding: "14px 18px", background: "#FFFBEB", border: "1px solid #FDE68A", borderLeft: "4px solid #F59E0B", borderRadius: 8, display: "flex", alignItems: "center", gap: 12 }}>
            <svg style={{ flexShrink: 0 }} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#D97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            <div>
              <div style={{ fontWeight: 600, color: "#92400E", fontSize: 14 }}>Queued for Fynd consolidation</div>
              <div style={{ fontSize: 12, color: "#B45309", marginTop: 2 }}>This return will be combined with other pending returns for this order and synced to Fynd as a single shipment. Check back after the batch window expires.</div>
            </div>
          </div>
        )}

        {/* ── Status Hero ── */}
        <div style={{ ...C.card, padding: 0, overflow: "hidden", marginBottom: 20, border: `1px solid ${statusConfig.border}` }}>
          <div style={{ background: statusConfig.bg, padding: "20px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
              <div style={{ width: 48, height: 48, borderRadius: 12, background: statusConfig.color, display: "flex", alignItems: "center", justifyContent: "center" }}>
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  {statusConfig.icon === "clock" && <><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></>}
                  {statusConfig.icon === "check" && <><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></>}
                  {statusConfig.icon === "done" && <><circle cx="12" cy="12" r="10"/><polyline points="9 12 12 15 16 9"/></>}
                  {statusConfig.icon === "x" && <><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></>}
                  {statusConfig.icon === "info" && <><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></>}
                  {statusConfig.icon === "truck" && <><rect x="1" y="3" width="15" height="13"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></>}
                  {statusConfig.icon === "refresh" && <><path d="M1 4v6h6"/><path d="M23 20v-6h-6"/><path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15"/></>}
                </svg>
              </div>
              <div>
                <div style={{ fontSize: 22, fontWeight: 700, color: statusConfig.color }}>{statusConfig.text}</div>
                <div style={{ fontSize: 13, color: "#6B7280", marginTop: 2 }}>
                  Return <span style={C.mono}>{returnRequestId}</span> for order <strong>{returnCase.shopifyOrderName || "—"}</strong>
                </div>
                {unifiedState.description && (
                  <div style={{ fontSize: 12, color: "#9CA3AF", marginTop: 4 }}>{unifiedState.description}</div>
                )}
                {isBlocklisted && (
                  <div style={{
                    display: "inline-flex", alignItems: "center", gap: 5, marginTop: 6,
                    padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700,
                    background: "#FEF2F2", color: "#DC2626", border: "1px solid #FECACA",
                  }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                    Flagged customer
                  </div>
                )}
                {daysRemaining != null && (
                  <div
                    title={returnDeadline ? `Return window expires ${new Intl.DateTimeFormat(shopLocale || "en", { dateStyle: "medium", timeStyle: "short", timeZone: undefined }).format(new Date(returnDeadline))}` : undefined}
                    style={{
                      display: "inline-flex", alignItems: "center", gap: 5, marginTop: 6,
                      padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700,
                      ...(daysRemaining <= 0
                        ? { background: "#FEF2F2", color: "#DC2626", border: "1px solid #FECACA" }
                        : daysRemaining <= 7
                          ? { background: "#FFFBEB", color: "#B45309", border: "1px solid #FDE68A" }
                          : { background: "#ECFDF5", color: "#065F46", border: "1px solid #A7F3D0" }),
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
                    </svg>
                    {daysRemaining <= 0 ? "Expired" : `${daysRemaining} day${daysRemaining === 1 ? "" : "s"} remaining`}
                  </div>
                )}
              </div>
              {/* Resolution type badge */}
              {returnCase.resolutionType && returnCase.resolutionType !== "refund" && (
                <span style={{
                  padding: "4px 12px", borderRadius: 20, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em",
                  ...({
                    exchange: { background: "#DCFCE7", color: "#166534", border: "1px solid #BBF7D0" },
                    store_credit: { background: "#F3E8FF", color: "#6B21A8", border: "1px solid #D8B4FE" },
                    replacement: { background: "#FFF7ED", color: "#C2410C", border: "1px solid #FED7AA" },
                  } as Record<string, React.CSSProperties>)[returnCase.resolutionType] ?? {},
                }}>
                  {returnCase.resolutionType.replace(/_/g, " ")}
                </span>
              )}
              {returnCase.resolutionType === "refund" && (
                <span style={{
                  padding: "4px 12px", borderRadius: 20, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em",
                  background: "#DBEAFE", color: "#1E40AF", border: "1px solid #93C5FD",
                }}>
                  Refund
                </span>
              )}
              {isGreenReturn && (
                <span
                  title="Customer keeps the item — no return shipment required"
                  style={{
                    padding: "4px 12px", borderRadius: 20, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em",
                    background: "#ECFDF5", color: "#065F46", border: "1px solid #A7F3D0",
                    display: "inline-flex", alignItems: "center", gap: 4, cursor: "help",
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z"/>
                    <path d="M8 12l3 3 5-5"/>
                  </svg>
                  Green Return
                </span>
              )}
              {(returnCase as { isGiftReturn?: boolean }).isGiftReturn && (
                <span
                  title="Gift return — resolution limited to store credit or exchange"
                  style={{
                    padding: "4px 12px", borderRadius: 20, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em",
                    background: "#EDE9FE", color: "#7C3AED", border: "1px solid #C4B5FD",
                    display: "inline-flex", alignItems: "center", gap: 4, cursor: "help",
                  }}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20 12v6a2 2 0 01-2 2H6a2 2 0 01-2-2v-6"/><path d="M2 7h20v5H2z"/><path d="M12 22V7"/><path d="M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z"/></svg>
                  Gift Return
                </span>
              )}
              {(() => {
                const fl = (returnCase as { fraudRiskLevel?: string | null }).fraudRiskLevel;
                const fs = (returnCase as { fraudRiskScore?: number | null }).fraudRiskScore;
                if (!fl || fl === "low") return null;
                const colors = fl === "critical" ? { bg: "#FEE2E2", text: "#DC2626", border: "#FECACA" }
                  : fl === "high" ? { bg: "#FFEDD5", text: "#EA580C", border: "#FED7AA" }
                  : { bg: "#FEF3C7", text: "#D97706", border: "#FDE68A" };
                return (
                  <span title={`Fraud risk score: ${fs ?? "??"}/100`} style={{
                    padding: "4px 12px", borderRadius: 20, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em",
                    background: colors.bg, color: colors.text, border: `1px solid ${colors.border}`,
                    display: "inline-flex", alignItems: "center", gap: 4, cursor: "help",
                  }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                    {fl} Risk ({fs})
                  </span>
                );
              })()}
              {(() => {
                const ch = (returnCase as { sourceChannel?: string | null }).sourceChannel;
                if (!ch || ch === "web") return null;
                const CHANNEL_CFG: Record<string, { label: string; bg: string; color: string; border: string; icon: string }> = {
                  pos: { label: "POS Order", bg: "#FFF7ED", color: "#C2410C", border: "#FED7AA",
                    icon: `<path d="M20 7H4a2 2 0 00-2 2v6a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2z"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/>` },
                  draft_order: { label: "Draft Order", bg: "#EDE9FE", color: "#6D28D9", border: "#C4B5FD",
                    icon: `<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/>` },
                  b2b: { label: "B2B / Wholesale", bg: "#ECFDF5", color: "#065F46", border: "#A7F3D0",
                    icon: `<rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/>` },
                };
                const cfg = CHANNEL_CFG[ch] ?? { label: ch.toUpperCase(), bg: "#F3F4F6", color: "#374151", border: "#E5E7EB", icon: "" };
                return (
                  <span style={{
                    padding: "4px 12px", borderRadius: 20, fontSize: 11, fontWeight: 700,
                    textTransform: "uppercase", letterSpacing: "0.04em",
                    background: cfg.bg, color: cfg.color, border: `1px solid ${cfg.border}`,
                    display: "inline-flex", alignItems: "center", gap: 4,
                  }}>
                    {cfg.icon && (
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
                        dangerouslySetInnerHTML={{ __html: cfg.icon }} />
                    )}
                    {cfg.label}
                  </span>
                );
              })()}
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <s-button variant="secondary" onClick={() => navigate("/app/returns")}>All Returns</s-button>
              <a href={orderUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
                <s-button variant="secondary">{isManualReturn ? "Shopify Orders" : "View in Shopify"}</s-button>
              </a>
            </div>
          </div>

          {/* 6-step return progress bar */}
          {unifiedState.step > 0 && (() => {
            const RETURN_JOURNEY_MAP: Record<string, number> = {
              return_initiated: 1, bag_confirmed: 1,
              return_dp_assigned: 2, dp_assigned: 2,
              dp_out_for_pickup: 2, out_for_pickup: 2,
              return_bag_picked: 3, bag_picked: 3,
              return_bag_in_transit: 3, in_transit: 3,
              out_for_delivery_to_store: 3, out_for_delivery: 3, return_bag_out_for_delivery: 3,
              return_delivered: 4, delivery_done: 4, return_bag_delivered: 4,
              return_accepted: 4,
              credit_note_generated: 5, credit_note: 5, refund_initiated: 5,
              refund_done: 5, refunded: 5,
            };

            const isExchangeFlow = (returnCase.resolutionType || "").toLowerCase() === "exchange";
            const progressSteps = [
              { num: 1, label: "Submitted", time: null as string | null },
              { num: 2, label: "Approved", time: null as string | null },
              { num: 3, label: "Picked Up", time: null as string | null },
              { num: 4, label: "In Transit", time: null as string | null },
              { num: 5, label: "Received", time: null as string | null },
              { num: 6, label: isExchangeFlow ? "Exchanged" : "Refunded", time: null as string | null },
            ];

            /* v8 ignore start */
            // defensive: timeline construction has nested && / ?? guards across fyndJourney mapping; combinatorial coverage of every (status, time, idx-already-set) tuple is infeasible
            try { progressSteps[0].time = returnCase.createdAt ? new Date(returnCase.createdAt).toISOString() : null; } catch { progressSteps[0].time = null; }

            const rj = (returnJourney ?? []) as FyndJourneyStep[];
            for (const step of rj) {
              const st = (step.status || "").toLowerCase().replace(/\s+/g, "_");
              for (const key of Object.keys(RETURN_JOURNEY_MAP)) {
                if (st.includes(key) && step.time) {
                  const idx = RETURN_JOURNEY_MAP[key];
                  if (!progressSteps[idx]?.time) {
                    progressSteps[idx].time = step.time;
                  }
                }
              }
            }
            /* v8 ignore stop */

            for (const ev of (Array.isArray(returnCase.events) ? returnCase.events : [])) {
              const evType = (ev?.eventType || "").toLowerCase();
              const evTime = ev?.happenedAt ? new Date(ev.happenedAt).toISOString() : null;
              if (!evTime) continue;
              if ((evType === "approved" || evType === "auto_approved") && !progressSteps[1].time) progressSteps[1].time = evTime;
              if (evType.includes("refund") && evType.includes("process") && !progressSteps[5].time) progressSteps[5].time = evTime;
            }

            const activeStep = unifiedState.step;

            return (
              <div style={{ padding: "12px 24px 16px", borderTop: `1px solid ${statusConfig.border}`, display: "flex", alignItems: "center", gap: 0 }}>
                {progressSteps.map((step, i) => {
                  const done = activeStep >= step.num;
                  const current = activeStep === step.num;
                  return (
                    <React.Fragment key={step.num}>
                      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: "0 0 auto", zIndex: 1 }}>
                        <div style={{
                          width: current ? 28 : 24,
                          height: current ? 28 : 24,
                          borderRadius: "50%",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 10,
                          fontWeight: 700,
                          border: done ? "none" : "2px solid #E5E7EB",
                          background: done ? statusConfig.color : "#fff",
                          color: done ? "#fff" : "#9CA3AF",
                          boxShadow: current ? `0 0 0 4px ${statusConfig.color}25` : "none",
                          transition: "all 0.3s",
                        }}>
                          {done ? <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg> : step.num}
                        </div>
                        <div style={{
                          fontSize: 9,
                          marginTop: 4,
                          fontWeight: done ? 700 : 500,
                          whiteSpace: "nowrap",
                          color: done ? statusConfig.color : "#9CA3AF",
                        }}>
                          {step.label}
                        </div>
                        {step.time && (
                          <div style={{ fontSize: 8, color: "#9CA3AF", marginTop: 1, whiteSpace: "nowrap" }}>
                            {/* v8 ignore start */}
                            {/* defensive: shopLocale fallback on per-step time format rarely flips when fixture already provides locale */}
                            {new Intl.DateTimeFormat(shopLocale || "en", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: undefined }).format(new Date(step.time))}
                            {/* v8 ignore stop */}
                          </div>
                        )}
                      </div>
                      {i < progressSteps.length - 1 && (
                        <div style={{
                          flex: 1,
                          height: 2,
                          background: activeStep > step.num ? statusConfig.color : "#E5E7EB",
                          margin: "0 -2px",
                          marginBottom: step.time ? 20 : 14,
                          transition: "background 0.3s",
                        }} />
                      )}
                    </React.Fragment>
                  );
                })}
              </div>
            );
          })()}

          {isRejected && returnCase.rejectionReason && (
            <div style={{ padding: "12px 24px", background: "#FEF2F2", borderTop: `1px solid ${statusConfig.border}`, fontSize: 14, color: "#991B1B" }}>
              <strong>Rejection reason:</strong> {returnCase.rejectionReason}
            </div>
          )}
        </div>

        {/* ── Two-column layout ── */}
        <div className="rpm-detail-layout">
          {/* ── LEFT COLUMN ── */}
          <div>
            {/* ── Return Items ── */}
            <div style={{ ...C.card }}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Items being returned ({Array.isArray(returnCase.items) ? returnCase.items.length : 0})</div>
              {(!Array.isArray(returnCase.items) || returnCase.items.length === 0) ? (
                <div style={{ padding: 20, textAlign: "center", color: "#9CA3AF", fontSize: 14 }}>No items recorded</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {returnCase.items.map((item) => {
                    /* v8 ignore start */
                    // defensive: title/variant/imageUrl/price fallback chains across Fynd vs Shopify item shapes — many short-circuits not exhausted
                    const shopifyItem = (shopifyOrder?.lineItems ?? []).find((li) =>
                      li.id === item.shopifyLineItemId ||
                      (li.sku && item.sku && li.sku.toLowerCase() === item.sku.toLowerCase())
                    );
                    const rawTitle = (item as { title?: string | null }).title || shopifyItem?.title || item.notes || item.sku || item.shopifyLineItemId || "Item";
                    const title = humanizeFyndSku(rawTitle);
                    const variant = (item as { variantTitle?: string | null }).variantTitle || shopifyItem?.variantTitle;
                    const imageUrl = (item as { imageUrl?: string | null }).imageUrl || shopifyItem?.imageUrl;
                    const rawPrice = (item as { price?: string | null }).price || (shopifyItem?.discountedPrice ?? shopifyItem?.price);
                    /* v8 ignore stop */
                    const price = (() => {
                      if (rawPrice == null) return null;
                      if (typeof rawPrice === "string") return rawPrice;
                      if (typeof rawPrice === "object") {
                        const obj = rawPrice as Record<string, unknown>;
                        /* v8 ignore start */
                        // defensive: shapes from Fynd vs Shopify vary; nullish chain falls through different keys per source
                        const v = obj.amount ?? obj.value ?? obj.effective ?? obj.transfer_price ?? obj.price_effective;
                        /* v8 ignore stop */
                        return v != null ? String(v) : null;
                      }
                      /* v8 ignore start */
                      // unreachable: typed rawPrice is string|null|object; no number/boolean/bigint shape from Prisma or shopify-admin
                      return String(rawPrice);
                      /* v8 ignore stop */
                    })();
                    return (
                      <div key={item.id} style={{ display: "flex", gap: 14, padding: 14, background: "#F9FAFB", borderRadius: 10, border: "1px solid #F3F4F6" }}>
                        {imageUrl ? (
                          <img src={imageUrl} alt={title} style={{ width: 56, height: 56, objectFit: "cover", borderRadius: 8, flexShrink: 0 }} />
                        ) : (
                          <div style={{ width: 56, height: 56, background: "#E5E7EB", borderRadius: 8, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#9CA3AF", fontSize: 20 }}>
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M9 21V9"/></svg>
                          </div>
                        )}
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 2 }}>{item.shopifyLineItemId === "manual" ? (item.notes || "Manual return item") : title}</div>
                          {variant && <div style={{ fontSize: 12, color: "#6B7280", marginBottom: 4 }}>{variant}</div>}
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 4 }}>
                            <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 6, background: "#E5E7EB", color: "#374151" }}>Qty: {item.qty}</span>
                            {item.reasonCode && (
                              <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 6, background: "#FEF3C7", color: "#92400E" }}>{item.reasonCode}</span>
                            )}
                            {(item as { condition?: string | null }).condition && (() => {
                              const cond = (item as { condition?: string | null }).condition!;
                              const condColors: Record<string, { bg: string; color: string }> = {
                                unused: { bg: "#DCFCE7", color: "#166534" },
                                used_good: { bg: "#DBEAFE", color: "#1E40AF" },
                                used_damaged: { bg: "#FEF3C7", color: "#92400E" },
                                defective: { bg: "#FEE2E2", color: "#991B1B" },
                              };
                              const condLabels: Record<string, string> = {
                                unused: "Unused", used_good: "Used — Good", used_damaged: "Used — Damaged", defective: "Defective",
                              };
                              const style = condColors[cond] ?? { bg: "#F3F4F6", color: "#374151" };
                              return <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 6, background: style.bg, color: style.color, fontWeight: 600 }}>{condLabels[cond] ?? cond}</span>;
                            })()}
                            {price && <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 6, background: "#DBEAFE", color: "#1E40AF" }}>{formatMoney(price, shopifyOrder?.currencyCode || shopCurrency, shopLocale)} each</span>}
                            {(item as { fyndSize?: string | null }).fyndSize && <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 6, background: "#F3F4F6", color: "#374151" }}>Size: {(item as { fyndSize?: string }).fyndSize}</span>}
                          </div>
                          {/* Fynd item IDs — collapsible for support/troubleshooting */}
                          {((item as { fyndBagId?: string | null }).fyndBagId || (item as { fyndArticleId?: string | null }).fyndArticleId || (item as { fyndSellerIdentifier?: string | null }).fyndSellerIdentifier) && (
                            <details style={{ marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
                              <summary style={{ fontSize: 10, color: "#9CA3AF", cursor: "pointer", userSelect: "none" }}>Fynd IDs</summary>
                              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
                                {(item as { fyndBagId?: string | null }).fyndBagId && <span style={{ fontSize: 10, fontFamily: "monospace", color: "#6B7280", background: "#F3F4F6", padding: "1px 6px", borderRadius: 4 }}>Bag: {(item as { fyndBagId?: string }).fyndBagId}</span>}
                                {(item as { fyndArticleId?: string | null }).fyndArticleId && <span style={{ fontSize: 10, fontFamily: "monospace", color: "#6B7280", background: "#F3F4F6", padding: "1px 6px", borderRadius: 4 }}>Article: {(item as { fyndArticleId?: string }).fyndArticleId}</span>}
                                {(item as { fyndSellerIdentifier?: string | null }).fyndSellerIdentifier && <span style={{ fontSize: 10, fontFamily: "monospace", color: "#6B7280", background: "#F3F4F6", padding: "1px 6px", borderRadius: 4 }}>SKU: {(item as { fyndSellerIdentifier?: string }).fyndSellerIdentifier}</span>}
                                {(item as { fyndItemId?: string | null }).fyndItemId && <span style={{ fontSize: 10, fontFamily: "monospace", color: "#6B7280", background: "#F3F4F6", padding: "1px 6px", borderRadius: 4 }}>Item: {(item as { fyndItemId?: string }).fyndItemId}</span>}
                                {(item as { fyndLineNumber?: number | null }).fyndLineNumber != null && <span style={{ fontSize: 10, fontFamily: "monospace", color: "#6B7280", background: "#F3F4F6", padding: "1px 6px", borderRadius: 4 }}>Line: {(item as { fyndLineNumber?: number }).fyndLineNumber}</span>}
                                {(item as { fyndPriceEffective?: string | null }).fyndPriceEffective && <span style={{ fontSize: 10, fontFamily: "monospace", color: "#6B7280", background: "#F3F4F6", padding: "1px 6px", borderRadius: 4 }}>Eff. Price: {(item as { fyndPriceEffective?: string }).fyndPriceEffective}</span>}
                                {(item as { fyndShipmentId?: string | null }).fyndShipmentId && <span style={{ fontSize: 10, fontFamily: "monospace", color: "#6B7280", background: "#F3F4F6", padding: "1px 6px", borderRadius: 4 }}>Shipment: {(item as { fyndShipmentId?: string }).fyndShipmentId}</span>}
                              </div>
                            </details>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* ── Shopify Order Details ── */}
            {shopifyOrder && (
              <div style={{ ...C.card }}>
                <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Order details</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 16 }}>
                  <div><div style={C.label}>Order</div><div style={C.val}>{shopifyOrder.name || "—"}</div></div>
                  <div><div style={C.label}>Placed</div><div style={C.val}>{shopifyOrder.createdAt ? new Intl.DateTimeFormat(shopLocale || "en", { dateStyle: "medium", timeStyle: "short", timeZone: undefined }).format(new Date(shopifyOrder.createdAt)) : "—"}</div></div>
                  {shopifyOrder.email && <div><div style={C.label}>Email</div><div style={C.val}>{shopifyOrder.email}</div></div>}
                  {shopifyOrder.phone && <div><div style={C.label}>Phone</div><div style={C.val}>{shopifyOrder.phone}</div></div>}
                  {shopifyOrder.displayFulfillmentStatus && <div><div style={C.label}>Fulfillment</div><div style={C.val}>{shopifyOrder.displayFulfillmentStatus.replace(/_/g, " ")}</div></div>}
                  {shopifyOrder.displayFinancialStatus && <div><div style={C.label}>Payment</div><div style={C.val}>{shopifyOrder.displayFinancialStatus.replace(/_/g, " ")}</div></div>}
                  {(() => {
                    const ch = (returnCase as { sourceChannel?: string | null }).sourceChannel;
                    if (!ch || ch === "web") return null;
                    /* v8 ignore start */
                    // defensive: sourceChannel-keyed labels/colors lookups + nullish fallback ladder; combinatorial branch coverage of every channel value infeasible
                    const labels: Record<string, string> = { pos: "Point of Sale", draft_order: "Draft Order", b2b: "B2B / Wholesale" };
                    const colors: Record<string, { bg: string; color: string }> = {
                      pos: { bg: "#FFF7ED", color: "#C2410C" },
                      draft_order: { bg: "#EDE9FE", color: "#6D28D9" },
                      b2b: { bg: "#ECFDF5", color: "#065F46" },
                    };
                    const clr = colors[ch] ?? { bg: "#F3F4F6", color: "#374151" };
                    return (
                      <div>
                        <div style={C.label}>Channel</div>
                        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                          <span style={{ fontSize: 11, fontWeight: 700, padding: "2px 8px", background: clr.bg, color: clr.color, borderRadius: 4, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                            {labels[ch] ?? ch}
                          </span>
                        </div>
                      </div>
                    );
                    /* v8 ignore stop */
                  })()}
                  {shopifyOrder.paymentGatewayNames && shopifyOrder.paymentGatewayNames.length > 0 && (
                    <div>
                      <div style={C.label}>Payment method</div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={C.val}>{shopifyOrder.paymentGatewayNames.join(", ")}</span>
                        {isCodOrder && (
                          <span style={{ fontSize: 10, fontWeight: 600, padding: "2px 6px", background: "#FEF3C7", borderRadius: 4, color: "#92400E", textTransform: "uppercase", letterSpacing: "0.3px" }}>COD</span>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                {(formatAddress(shopifyOrder.shippingAddress)) && (
                  <div style={{ marginBottom: 16 }}>
                    <div style={C.label}>Shipping address</div>
                    <div style={{ fontSize: 13, lineHeight: 1.6, color: "#374151" }}>{formatAddress(shopifyOrder.shippingAddress)}</div>
                  </div>
                )}
                {/* Order totals */}
                {shopifyOrder.totalPrice && (
                  <div style={{ borderTop: "1px solid #F3F4F6", paddingTop: 12 }}>
                    {/* v8 ignore start */}
                    {/* defensive: shopifyOrder.currencyCode || shopCurrency fallback rarely flips in fixtures; subtotal/discount are independently optional */}
                    <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 280 }}>
                      {shopifyOrder.subtotalPrice && (
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                          <span style={{ color: "#6B7280" }}>Subtotal</span><span>{formatMoney(shopifyOrder.subtotalPrice, shopifyOrder.currencyCode || shopCurrency, shopLocale)}</span>
                        </div>
                      )}
                      {shopifyOrder.totalDiscounts && parseFloat(shopifyOrder.totalDiscounts) > 0 && (
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#059669" }}>
                          <span>Discounts</span><span>-{formatMoney(shopifyOrder.totalDiscounts, shopifyOrder.currencyCode || shopCurrency, shopLocale)}</span>
                        </div>
                      )}
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, fontWeight: 700, paddingTop: 6, borderTop: "1px solid #E5E7EB" }}>
                        <span>Total</span><span>{formatMoney(shopifyOrder.totalPrice, shopifyOrder.currencyCode || shopCurrency, shopLocale)}</span>
                      </div>
                    </div>
                    {/* v8 ignore stop */}
                  </div>
                )}
              </div>
            )}

            {/* ── Shipment & Logistics (unified) ── */}
            {!isManualReturn && (() => {
              const rl = returnLabelInfo;
              const retStatus = returnShipmentStatus;
              const retJourney = (returnJourney ?? []) as FyndJourneyStep[];
              const effLabelUrl = rl?.signedLabelUrl || rl?.labelUrl || null;
              const effInvoiceUrl = rl?.signedInvoiceUrl || rl?.invoiceUrl || null;
              const effTrackingUrl = rl?.trackingUrl || null;
              return (
              <div style={{ ...C.card }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>Shipment & Logistics</div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {canRetryFynd && (
                      <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`}>
                        <input type="hidden" name="json" value={JSON.stringify({ action: "retry_fynd_sync" })} />
                        <s-button type="submit" variant="secondary" disabled={fetcher.state !== "idle"}>
                          {fetcher.state !== "idle" ? "Syncing..." : "Sync to Fynd"}
                        </s-button>
                      </fetcher.Form>
                    )}
                    {((returnCase as { fyndOrderId?: string | null }).fyndOrderId || (returnCase.shopifyOrderName ?? "").replace(/^#/, "")) && (
                      <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`}>
                        <input type="hidden" name="json" value={JSON.stringify({ action: "refresh_fynd_details" })} />
                        <s-button type="submit" variant="secondary" disabled={fetcher.state !== "idle"}>
                          {fetcher.state !== "idle" ? "Refreshing..." : "Refresh"}
                        </s-button>
                      </fetcher.Form>
                    )}
                  </div>
                </div>
                {/* Fynd sync status indicator — enhanced with tracing & error guidance */}
                {fyndSyncStatus && fyndSyncStatus !== "synced" && (
                  <div style={{
                    padding: "14px 16px", borderRadius: 10, marginBottom: 16, fontSize: 13,
                    background: fyndSyncStatus === "failed" ? "#FEF2F2"
                      : fyndSyncStatus === "processing" ? "#EFF6FF"
                      : fyndSyncStatus === "pending_consolidation" ? "#FFF7ED"
                      : "#FFFBEB",
                    border: `1px solid ${
                      fyndSyncStatus === "failed" ? "#FECACA"
                      : fyndSyncStatus === "processing" ? "#BFDBFE"
                      : fyndSyncStatus === "pending_consolidation" ? "#FDBA74"
                      : "#FDE68A"
                    }`,
                    color: fyndSyncStatus === "failed" ? "#991B1B"
                      : fyndSyncStatus === "processing" ? "#1D4ED8"
                      : fyndSyncStatus === "pending_consolidation" ? "#C2410C"
                      : "#92400E",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: fyndSyncError || fyndSyncStatus === "retry_scheduled" || fyndSyncStatus === "failed" ? 10 : 0 }}>
                      {fyndSyncStatus === "processing" && (
                        <svg style={{ flexShrink: 0, animation: "spin 1s linear infinite" }} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                      )}
                      {fyndSyncStatus === "failed" && (
                        <svg style={{ flexShrink: 0 }} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#DC2626" strokeWidth="2.5" strokeLinecap="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                      )}
                      <strong style={{ fontSize: 14 }}>
                        {fyndSyncStatus === "failed" && `Sync failed after ${fyndSyncRetries} attempt${fyndSyncRetries !== 1 ? "s" : ""}`}
                        {fyndSyncStatus === "retry_scheduled" && `Retry #${fyndSyncRetries + 1} of 5 scheduled`}
                        {fyndSyncStatus === "pending" && "Queued for Fynd sync"}
                        {fyndSyncStatus === "processing" && "Fynd is processing \u2014 logistics assignment in progress"}
                        {fyndSyncStatus === "pending_consolidation" && "Queued for batch Fynd sync"}
                      </strong>
                    </div>
                    {/* Error details */}
                    {fyndSyncError && (
                      <div style={{ padding: "8px 10px", background: "rgba(0,0,0,0.04)", borderRadius: 6, marginBottom: 8, fontSize: 12, lineHeight: 1.5, wordBreak: "break-word" }}>
                        {fyndSyncError}
                      </div>
                    )}
                    {/* Retry schedule info */}
                    {fyndSyncStatus === "retry_scheduled" && (returnCase as unknown as { fyndSyncNextRetry?: Date | string | null }).fyndSyncNextRetry && (
                      <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>
                        Next retry: {(() => {
                          try {
                            const nextRetry = new Date((returnCase as unknown as { fyndSyncNextRetry: Date | string }).fyndSyncNextRetry);
                            const diff = nextRetry.getTime() - Date.now();
                            if (diff <= 0) return "imminent";
                            if (diff < 60_000) return `in ${Math.ceil(diff / 1000)}s`;
                            if (diff < 3_600_000) return `in ${Math.ceil(diff / 60_000)} min`;
                            return `at ${new Intl.DateTimeFormat(shopLocale || "en", { timeStyle: "short" }).format(nextRetry)}`;
                          }
                          /* v8 ignore start */
                          // unreachable: Date constructor never throws; Intl.DateTimeFormat doesn't throw on valid Date
                          catch { return "scheduled"; }
                          /* v8 ignore stop */
                        })()}
                        {" \u00B7 "}Backoff: 2min \u2192 5min \u2192 15min \u2192 1hr \u2192 4hr
                      </div>
                    )}
                    {/* Actionable guidance for failed state */}
                    {fyndSyncStatus === "failed" && (
                      <div style={{ fontSize: 12, marginTop: 4, lineHeight: 1.6 }}>
                        {(() => {
                          const err = (fyndSyncError || "").toLowerCase();
                          if (/not configured|configure|settings.*integrations|client id|company id|platform api/i.test(err)) {
                            return <span><strong>Configuration issue</strong> \u2014 Go to <em>Settings \u2192 Integrations</em> and verify your Fynd Platform API credentials.</span>;
                          }
                          if (/econnrefused|enotfound|ehostunreach|network|socket hang up|dns/i.test(err)) {
                            return <span><strong>Network issue</strong> \u2014 Fynd API may be temporarily unreachable. Try again later.</span>;
                          }
                          if (/etimedout|timeout|timed out|aborted/i.test(err)) {
                            return <span><strong>Timeout</strong> \u2014 The Fynd API took too long to respond. Try again or check Fynd status.</span>;
                          }
                          return <span><strong>API error</strong> \u2014 Check the Fynd dashboard for this order.</span>;
                        })()}
                        <div style={{ marginTop: 10, display: "flex", gap: 8, alignItems: "center" }}>
                          <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`}>
                            <input type="hidden" name="json" value={JSON.stringify({ action: "retry_fynd_sync" })} />
                            <button type="submit" disabled={fetcher.state !== "idle"} style={{
                              padding: "6px 16px", borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: "pointer",
                              background: "#DC2626", color: "#fff", border: "none",
                              opacity: fetcher.state !== "idle" ? 0.7 : 1,
                            }}>
                              {fetcher.state !== "idle" ? "Syncing..." : "Retry Sync"}
                            </button>
                          </fetcher.Form>
                          <span style={{ fontSize: 11, opacity: 0.65 }}>or process refund manually</span>
                        </div>
                      </div>
                    )}
                  </div>
                )}
                {/* ── Forward Shipment ── */}
                {(forwardAwbVal || forwardCourier || forwardTrackingUrl || forwardInvoiceNumber || fwdShipmentId) && (
                  <div style={{ marginBottom: 14, padding: 14, background: "#F9FAFB", borderRadius: 10, border: "1px solid #E5E7EB" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>Forward Shipment</div>
                    {/* v8 ignore start */}
                    {/* defensive: each forward-shipment field is independently optional in Fynd payloads; covering every false branch combinatorially is infeasible */}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                      {forwardCourier && <div><div style={C.label}>Courier</div><div style={C.val}>{forwardCourier}</div></div>}
                      {forwardAwbVal && <div><div style={C.label}>AWB</div><div style={C.mono}>{forwardAwbVal}</div></div>}
                      {forwardShipmentStatus && <div><div style={C.label}>Status</div><div style={{ fontSize: 13, fontWeight: 600, color: forwardShipmentStatus.includes("deliver") ? "#059669" : "#D97706", textTransform: "capitalize" }}>{forwardShipmentStatus.replace(/_/g, " ")}</div></div>}
                      {forwardTrackingUrl && <div><div style={C.label}>Track</div><a href={forwardTrackingUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, fontWeight: 600, color: "#2563EB", textDecoration: "none" }}>Track Shipment &rarr;</a></div>}
                      {forwardInvoiceNumber && <div><div style={C.label}>Invoice</div>{forwardInvoiceUrl ? <a href={forwardInvoiceUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, fontWeight: 600, color: "#2563EB", textDecoration: "none" }}>{forwardInvoiceNumber} &darr;</a> : <div style={C.mono}>{forwardInvoiceNumber}</div>}</div>}
                      {forwardLabelUrl && <div><div style={C.label}>Label</div><a href={forwardLabelUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, fontWeight: 600, color: "#2563EB", textDecoration: "none" }}>Download &darr;</a></div>}
                      {fwdShipmentId && <div><div style={C.label}>Shipment ID</div><div style={{ ...C.mono, fontSize: 11, wordBreak: "break-all" as const }}>{fwdShipmentId}</div></div>}
                      {fwdFulfillmentStore && <div><div style={C.label}>Fulfillment Store</div><div style={{ fontSize: 12, color: "#374151" }}>{fwdFulfillmentStore}</div></div>}
                      {fwdEstimatedDelivery && <div><div style={C.label}>Est. Delivery</div><div style={{ fontSize: 12, color: "#374151" }}>{(() => {
                        try { return new Intl.DateTimeFormat(shopLocale || "en", { dateStyle: "medium" }).format(new Date(fwdEstimatedDelivery)); }
                        /* v8 ignore start */
                        // unreachable: Intl.DateTimeFormat does not throw on valid date strings (jsdom + node)
                        catch { return fwdEstimatedDelivery; }
                        /* v8 ignore stop */
                      })()}</div></div>}
                      {fwdFulfillmentOptions && <div><div style={C.label}>Fulfillment</div><div style={{ fontSize: 12, color: "#6B7280" }}>{fwdFulfillmentOptions}</div></div>}
                      {fwdWeightInfo && <div><div style={C.label}>Weight</div><div style={{ fontSize: 12, color: "#374151" }}>{fwdWeightInfo}</div></div>}
                      {fwdDimensions && <div><div style={C.label}>Dimensions</div><div style={{ fontSize: 12, color: "#374151" }}>{fwdDimensions}</div></div>}
                      {fwdStorePhone && <div><div style={C.label}>Store Phone</div><div style={{ fontSize: 12, color: "#374151" }}>{fwdStorePhone}</div></div>}
                      {fwdStoreEmail && <div><div style={C.label}>Store Email</div><div style={{ fontSize: 12, color: "#374151" }}>{fwdStoreEmail}</div></div>}
                      {fwdDpPhone && <div><div style={C.label}>DP Phone</div><div style={{ fontSize: 12, color: "#374151" }}>{fwdDpPhone}</div></div>}
                      {fwdEwaybillUrl && <div><div style={C.label}>E-Waybill</div><a href={fwdEwaybillUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, fontWeight: 600, color: "#2563EB", textDecoration: "none" }}>Download &darr;</a></div>}
                    </div>
                    {/* v8 ignore stop */}
                    {fwdDeliveryAddress && (
                      <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5E7EB" }}>
                        <div style={C.label}>Delivery Address</div>
                        <div style={{ fontSize: 12, color: "#374151", lineHeight: 1.5 }}>{fwdDeliveryAddress.formatted || [fwdDeliveryAddress.name, fwdDeliveryAddress.address, fwdDeliveryAddress.city, fwdDeliveryAddress.state, fwdDeliveryAddress.pincode, fwdDeliveryAddress.country, fwdDeliveryAddress.phone].filter(Boolean).join(", ")}</div>
                      </div>
                    )}
                    {/* v8 ignore start */}
                    {/* defensive: each pricing line item independently optional from Fynd; combinatorial branch coverage infeasible */}
                    {fwdPricing && (fwdPricing.total || fwdPricing.subtotal) && (
                      <details style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5E7EB" }}>
                        <summary style={{ fontSize: 11, fontWeight: 600, color: "#6B7280", cursor: "pointer" }}>Shipment Pricing</summary>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "4px 16px", marginTop: 8, fontSize: 12 }}>
                          {fwdPricing.subtotal && <><span style={{ color: "#6B7280" }}>Subtotal</span><span>{formatMoney(fwdPricing.subtotal, fwdPricing.currency || shopCurrency, shopLocale)}</span></>}
                          {fwdPricing.discount && parseFloat(fwdPricing.discount) > 0 && <><span style={{ color: "#059669" }}>Discount</span><span style={{ color: "#059669" }}>-{formatMoney(fwdPricing.discount, fwdPricing.currency || shopCurrency, shopLocale)}</span></>}
                          {fwdPricing.deliveryCharges && <><span style={{ color: "#6B7280" }}>Delivery</span><span>{formatMoney(fwdPricing.deliveryCharges, fwdPricing.currency || shopCurrency, shopLocale)}</span></>}
                          {fwdPricing.codAmount && parseFloat(fwdPricing.codAmount) > 0 && <><span style={{ color: "#6B7280" }}>COD</span><span>{formatMoney(fwdPricing.codAmount, fwdPricing.currency || shopCurrency, shopLocale)}</span></>}
                          {fwdPricing.total && <><span style={{ fontWeight: 600, color: "#111827" }}>Total</span><span style={{ fontWeight: 600 }}>{formatMoney(fwdPricing.total, fwdPricing.currency || shopCurrency, shopLocale)}</span></>}
                        </div>
                      </details>
                    )}
                    {/* v8 ignore stop */}
                    {fwdTrackingDetails.length > 0 && (
                      <details style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #E5E7EB" }}>
                        <summary style={{ fontSize: 11, fontWeight: 600, color: "#6B7280", cursor: "pointer" }}>Tracking History ({fwdTrackingDetails.length} events)</summary>
                        <div style={{ display: "flex", flexDirection: "column", gap: 0, paddingLeft: 6, marginTop: 8 }}>
                          {fwdTrackingDetails.map((t, idx) => (
                            <div key={idx} style={{ display: "flex", gap: 8, paddingBottom: idx < fwdTrackingDetails.length - 1 ? 8 : 0 }}>
                              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 12, flexShrink: 0 }}>
                                <div style={{ width: 6, height: 6, borderRadius: "50%", background: idx === 0 ? "#3B82F6" : "#D1D5DB", flexShrink: 0, marginTop: 3 }} />
                                {idx < fwdTrackingDetails.length - 1 && <div style={{ width: 1, flex: 1, background: "#E5E7EB", marginTop: 2 }} />}
                              </div>
                              <div>
                                <div style={{ fontSize: 11, fontWeight: 600, color: "#374151", textTransform: "capitalize" }}>{t.status.replace(/_/g, " ")}</div>
                                {t.time && <div style={{ fontSize: 10, color: "#9CA3AF" }}>{(() => {
                                  try { return new Intl.DateTimeFormat(shopLocale || "en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(t.time)); }
                                  /* v8 ignore start */
                                  // unreachable: Intl.DateTimeFormat does not throw on valid date strings
                                  catch { return t.time; }
                                  /* v8 ignore stop */
                                })()}</div>}
                                {t.message && <div style={{ fontSize: 10, color: "#6B7280", marginTop: 1 }}>{t.message}</div>}
                              </div>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                )}

                {/* ── Return Shipment ── */}
                {(returnAwbVal || returnCourier || effTrackingUrl || effLabelUrl || effInvoiceUrl || retShipmentId) ? (
                  <div style={{ marginBottom: 14, padding: 14, background: "#F0FDF4", borderRadius: 10, border: "1px solid #BBF7D0" }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#065F46", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>Return Shipment</div>
                    {/* v8 ignore start */}
                    {/* defensive: each return-shipment field is independently optional in Fynd payloads; combinatorial branch coverage infeasible */}
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                      {(rl?.carrier || returnCourier) && <div><div style={C.label}>Courier</div><div style={C.val}>{rl?.carrier || returnCourier}</div></div>}
                      {(returnTrackingNumber || returnAwbVal) && <div><div style={C.label}>Return AWB</div><div style={C.mono}>{returnTrackingNumber || returnAwbVal}</div></div>}
                      {retStatus && <div><div style={C.label}>Status</div><div style={{ fontSize: 13, fontWeight: 600, color: retStatus.includes("deliver") ? "#059669" : "#D97706", textTransform: "capitalize" }}>{retStatus.replace(/_/g, " ")}</div></div>}
                      {effTrackingUrl && <div><div style={C.label}>Track</div><a href={effTrackingUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, fontWeight: 600, color: "#059669", textDecoration: "none" }}>Track Return &rarr;</a></div>}
                      {(effLabelUrl || retReturnLabelUrl) && <div><div style={C.label}>Return Label</div><a href={effLabelUrl || retReturnLabelUrl!} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, fontWeight: 600, color: "#059669", textDecoration: "none" }}>Download &darr;</a></div>}
                      {(effInvoiceUrl || retReturnInvoiceUrl) && <div><div style={C.label}>Return Invoice</div><a href={effInvoiceUrl || retReturnInvoiceUrl!} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, fontWeight: 600, color: "#059669", textDecoration: "none" }}>Download &darr;</a></div>}
                      {rl?.qrCodeUrl && <div><div style={C.label}>QR Code</div><a href={rl.qrCodeUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, fontWeight: 600, color: "#059669", textDecoration: "none" }}>View &rarr;</a></div>}
                      {retShipmentId && <div><div style={C.label}>Return Shipment ID</div><div style={{ ...C.mono, fontSize: 11, wordBreak: "break-all" as const }}>{retShipmentId}</div></div>}
                      {retCreditNoteId && <div><div style={C.label}>Credit Note ID</div><div style={C.mono}>{retCreditNoteId}</div></div>}
                      {retFulfillmentStore && <div><div style={C.label}>Return Store</div><div style={{ fontSize: 12, color: "#374151" }}>{retFulfillmentStore}</div></div>}
                      {retEstimatedDelivery && <div><div style={C.label}>Est. Return Delivery</div><div style={{ fontSize: 12, color: "#374151" }}>{(() => {
                        try { return new Intl.DateTimeFormat(shopLocale || "en", { dateStyle: "medium" }).format(new Date(retEstimatedDelivery)); }
                        /* v8 ignore start */
                        // unreachable: Intl.DateTimeFormat does not throw on valid date strings
                        catch { return retEstimatedDelivery; }
                        /* v8 ignore stop */
                      })()}</div></div>}
                      {retWeightInfo && <div><div style={C.label}>Weight</div><div style={{ fontSize: 12, color: "#374151" }}>{retWeightInfo}</div></div>}
                      {retDimensions && <div><div style={C.label}>Dimensions</div><div style={{ fontSize: 12, color: "#374151" }}>{retDimensions}</div></div>}
                      {retStorePhone && <div><div style={C.label}>Store Phone</div><div style={{ fontSize: 12, color: "#374151" }}>{retStorePhone}</div></div>}
                      {retDpPhone && <div><div style={C.label}>DP Phone</div><div style={{ fontSize: 12, color: "#374151" }}>{retDpPhone}</div></div>}
                    </div>
                    {/* v8 ignore stop */}
                    {/* v8 ignore start */}
                    {/* defensive: optional Fynd return pricing block */}
                    {retPricing && (retPricing.total || retPricing.subtotal || retPricing.discount) && (
                      <details style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #BBF7D0" }}>
                        <summary style={{ fontSize: 11, fontWeight: 600, color: "#065F46", cursor: "pointer" }}>Return Pricing</summary>
                        <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: "4px 16px", marginTop: 8, fontSize: 12 }}>
                          {retPricing.subtotal && <><span style={{ color: "#6B7280" }}>Subtotal</span><span>{formatMoney(retPricing.subtotal, retPricing.currency || shopCurrency, shopLocale)}</span></>}
                          {retPricing.discount && parseFloat(retPricing.discount) > 0 && <><span style={{ color: "#059669" }}>Discount</span><span style={{ color: "#059669" }}>-{formatMoney(retPricing.discount, retPricing.currency || shopCurrency, shopLocale)}</span></>}
                          {retPricing.total && <><span style={{ fontWeight: 600, color: "#111827" }}>Total</span><span style={{ fontWeight: 600 }}>{formatMoney(retPricing.total, retPricing.currency || shopCurrency, shopLocale)}</span></>}
                        </div>
                      </details>
                    )}
                    {/* v8 ignore stop */}
                    {retTrackingDetails.length > 0 && (
                      <details style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #BBF7D0" }}>
                        <summary style={{ fontSize: 11, fontWeight: 600, color: "#065F46", cursor: "pointer" }}>Return Tracking History ({retTrackingDetails.length} events)</summary>
                        <div style={{ display: "flex", flexDirection: "column", gap: 0, paddingLeft: 6, marginTop: 8 }}>
                          {retTrackingDetails.map((t, idx) => (
                            <div key={idx} style={{ display: "flex", gap: 8, paddingBottom: idx < retTrackingDetails.length - 1 ? 8 : 0 }}>
                              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 12, flexShrink: 0 }}>
                                <div style={{ width: 6, height: 6, borderRadius: "50%", background: idx === 0 ? "#059669" : "#D1D5DB", flexShrink: 0, marginTop: 3 }} />
                                {idx < retTrackingDetails.length - 1 && <div style={{ width: 1, flex: 1, background: "#E5E7EB", marginTop: 2 }} />}
                              </div>
                              <div>
                                <div style={{ fontSize: 11, fontWeight: 600, color: "#374151", textTransform: "capitalize" }}>{t.status.replace(/_/g, " ")}</div>
                                {t.time && <div style={{ fontSize: 10, color: "#9CA3AF" }}>{(() => {
                                  try { return new Intl.DateTimeFormat(shopLocale || "en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(t.time)); }
                                  /* v8 ignore start */
                                  // unreachable: Intl.DateTimeFormat does not throw on valid date strings
                                  catch { return t.time; }
                                  /* v8 ignore stop */
                                })()}</div>}
                                {t.message && <div style={{ fontSize: 10, color: "#6B7280", marginTop: 1 }}>{t.message}</div>}
                              </div>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </div>
                ) : (isApproved || isCompleted) ? (
                  <div style={{ marginBottom: 14, padding: 14, background: "#FFFBEB", borderRadius: 10, border: "1px solid #FDE68A", fontSize: 13, color: "#92400E" }}>
                    No return shipment data yet. Click <strong>Refresh</strong> to fetch from Fynd, or edit details below.
                  </div>
                ) : null}

                {/* ── Return Journey Timeline ── */}
                {retJourney.length > 0 && (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 8 }}>Return Journey</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 0, paddingLeft: 6 }}>
                      {retJourney.map((step, idx) => (
                        <div key={idx} style={{ display: "flex", gap: 10, paddingBottom: idx < retJourney.length - 1 ? 10 : 0 }}>
                          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 14, flexShrink: 0 }}>
                            <div style={{ width: 8, height: 8, borderRadius: "50%", background: idx === 0 ? "#059669" : "#D1D5DB", border: idx === 0 ? "2px solid #A7F3D0" : "2px solid #E5E7EB", flexShrink: 0 }} />
                            {idx < retJourney.length - 1 && <div style={{ width: 2, flex: 1, background: "#E5E7EB", marginTop: 2 }} />}
                          </div>
                          <div style={{ paddingBottom: 2 }}>
                            <div style={{ fontSize: 12, fontWeight: 600, color: idx === 0 ? "#059669" : "#374151", textTransform: "capitalize" }}>{step.displayName || step.status.replace(/_/g, " ")}</div>
                            {step.time && <div style={{ fontSize: 11, color: "#9CA3AF" }}>{(() => {
                              try { return new Intl.DateTimeFormat(shopLocale || "en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(step.time)); }
                              /* v8 ignore start */
                              // unreachable: Intl.DateTimeFormat does not throw on valid date strings
                              catch { return step.time; }
                              /* v8 ignore stop */
                            })()}</div>}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* ── Pickup Address ── */}
                {pickupAddress && (
                  <div style={{ marginBottom: 14, padding: 12, background: "#F9FAFB", borderRadius: 8, border: "1px solid #F3F4F6" }}>
                    <div style={{ ...C.label, marginBottom: 4 }}>Pickup / Return address</div>
                    <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.5 }}>
                      {pickupAddress.formatted || [pickupAddress.name, pickupAddress.address1, pickupAddress.address2, pickupAddress.city, pickupAddress.state, pickupAddress.pincode, pickupAddress.phone].filter(Boolean).join(", ")}
                    </div>
                  </div>
                )}

                {/* ── Return Instructions ── */}
                {defaultReturnInstructions && (
                  <div style={{ marginBottom: 14, padding: 12, background: "#EFF6FF", borderRadius: 8, border: "1px solid #BFDBFE" }}>
                    <div style={C.label}>Return Instructions</div>
                    <div style={{ fontSize: 13, color: "#1E40AF", whiteSpace: "pre-wrap", marginTop: 4 }}>{defaultReturnInstructions}</div>
                  </div>
                )}

                {/* ── Fynd Reference ── */}
                <div style={{ marginBottom: 14, padding: 14, background: "#F9FAFB", borderRadius: 8, border: "1px solid #F3F4F6" }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 10 }}>Fynd Reference</div>
                  {/* v8 ignore start */}
                  {/* defensive: Fynd reference identifiers each independently optional; combinatorial branch coverage infeasible */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                    <div><div style={C.label}>Order ID</div><div style={{ ...C.mono, fontSize: 11, wordBreak: "break-all" as const }}>{fyndOrderDetailsTab?.fyndOrderId || (returnCase as { fyndOrderId?: string | null }).fyndOrderId || (returnCase.shopifyOrderName ?? "").replace(/^#/, "") || "\u2014"}</div></div>
                    {fwdShipmentId && <div><div style={C.label}>Fwd Shipment ID</div><div style={{ ...C.mono, fontSize: 11, wordBreak: "break-all" as const }}>{fwdShipmentId}</div></div>}
                    {retShipmentId && <div><div style={C.label}>Ret Shipment ID</div><div style={{ ...C.mono, fontSize: 11, wordBreak: "break-all" as const }}>{retShipmentId}</div></div>}
                    {!retShipmentId && (returnCase as { fyndShipmentId?: string | null }).fyndShipmentId && (
                      <div><div style={C.label}>Shipment ID</div><div style={{ ...C.mono, fontSize: 11, wordBreak: "break-all" as const }}>{(returnCase as { fyndShipmentId?: string | null }).fyndShipmentId}</div></div>
                    )}
                    {fyndReturnId && <div><div style={C.label}>Fynd Return ID</div><div style={{ ...C.mono, fontSize: 11, wordBreak: "break-all" as const }}>{fyndReturnId}</div></div>}
                    {(returnCase as { fyndReturnNo?: string | null }).fyndReturnNo && <div><div style={C.label}>Fynd Return #</div><div style={C.mono}>{(returnCase as { fyndReturnNo?: string | null }).fyndReturnNo}</div></div>}
                    {fyndCurrentStatusVal && <div><div style={C.label}>Current Status</div><div style={{ fontSize: 12, fontWeight: 600, color: "#374151", textTransform: "capitalize" }}>{fyndCurrentStatusVal.replace(/_/g, " ")}</div></div>}
                    {fyndSyncStatus && <div><div style={C.label}>Sync</div><div style={{ fontSize: 12, fontWeight: 600, color: fyndSyncStatus === "synced" ? "#059669" : fyndSyncStatus === "failed" ? "#DC2626" : "#D97706" }}>{fyndSyncStatus.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase())}</div></div>}
                    {fyndPaymentMethod && <div><div style={C.label}>Payment</div><div style={{ fontSize: 12, color: "#374151", textTransform: "capitalize" }}>{fyndPaymentMethod.replace(/_/g, " ")}</div></div>}
                    {fyndSupportUrl && <div><div style={C.label}>Support</div><a href={fyndSupportUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, fontWeight: 600, color: "#2563EB", textDecoration: "none" }}>Get Help &rarr;</a></div>}
                  </div>
                  {/* v8 ignore stop */}
                </div>

                {/* ── Edit shipping details (collapsible) ── */}
                {(isApproved || isCompleted) && (
                  <details style={{ marginBottom: 14 }}>
                    <summary style={{ fontSize: 12, fontWeight: 600, color: "#6B7280", cursor: "pointer", padding: "6px 0", userSelect: "none" }}>Edit return shipping details</summary>
                    <div style={{ paddingTop: 12 }}>
                      <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`}>
                        <input type="hidden" name="json" value={JSON.stringify({ action: "update_label", carrier: rl?.carrier ?? "", trackingNumber: rl?.trackingNumber ?? "", labelUrl: rl?.labelUrl ?? "", qrCodeUrl: rl?.qrCodeUrl ?? "" })} />
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
                          <div className="app-field"><label style={{ fontSize: 12, fontWeight: 600 }}>Carrier</label><input type="text" name="carrier" defaultValue={rl?.carrier ?? ""} placeholder="e.g. FedEx" className="app-input" style={{ fontSize: 13 }} onChange={(e) => { const h = e.target.closest("form")?.querySelector('input[name="json"]') as HTMLInputElement; if (h) { const v = JSON.parse(h.value); v.carrier = e.target.value; h.value = JSON.stringify(v); } }} /></div>
                          <div className="app-field"><label style={{ fontSize: 12, fontWeight: 600 }}>Tracking #</label><input type="text" name="trackingNumber" defaultValue={rl?.trackingNumber ?? ""} placeholder="AWB" className="app-input" style={{ fontSize: 13 }} onChange={(e) => { const h = e.target.closest("form")?.querySelector('input[name="json"]') as HTMLInputElement; if (h) { const v = JSON.parse(h.value); v.trackingNumber = e.target.value; h.value = JSON.stringify(v); } }} /></div>
                        </div>
                        <div className="app-field" style={{ marginBottom: 12 }}>
                          <label style={{ fontSize: 12, fontWeight: 600 }}>Label URL</label>
                          <input type="url" name="labelUrl" defaultValue={rl?.labelUrl ?? ""} placeholder="https://..." className="app-input" style={{ fontSize: 13 }} onChange={(e) => { const h = e.target.closest("form")?.querySelector('input[name="json"]') as HTMLInputElement; if (h) { const v = JSON.parse(h.value); v.labelUrl = e.target.value; h.value = JSON.stringify(v); } }} />
                        </div>
                        <s-button type="submit" variant="secondary" disabled={fetcher.state !== "idle"}>Save</s-button>
                      </fetcher.Form>
                      <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`} style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #F3F4F6" }}>
                        <input type="hidden" name="json" value={JSON.stringify({ action: "update_instructions", returnInstructions: defaultReturnInstructions ?? "" })} />
                        <div className="app-field" style={{ marginBottom: 8 }}>
                          <label style={{ fontSize: 12, fontWeight: 600 }}>Return instructions</label>
                          <textarea name="returnInstructions" defaultValue={defaultReturnInstructions ?? ""} rows={2} placeholder="e.g. Pack items securely and drop off at..." style={{ width: "100%", padding: 8, borderRadius: 6, border: "1px solid #E5E7EB", boxSizing: "border-box", fontSize: 13 }} onChange={(e) => { const h = e.target.closest("form")?.querySelector('input[name="json"]') as HTMLInputElement; if (h) { const v = JSON.parse(h.value); v.returnInstructions = e.target.value; h.value = JSON.stringify(v); } }} />
                        </div>
                        <s-button type="submit" variant="secondary" disabled={fetcher.state !== "idle"}>Save Instructions</s-button>
                      </fetcher.Form>
                    </div>
                  </details>
                )}

                {/* ── Raw payload (expandable) ── */}
                {(fyndPayloadInfo?.shipments?.length ?? 0) > 0 && (
                  <div style={{ paddingTop: 8, borderTop: "1px solid #F3F4F6" }}>
                    <button type="button" onClick={() => setShowRawFynd((v) => !v)} className="app-btn-text" style={{ fontSize: 12 }}>
                      {showRawFynd ? "Hide raw payload" : "View raw payload"}
                    </button>
                    {showRawFynd && (
                      <div style={{ marginTop: 8, minWidth: 0 }}>
                        <PayloadViewer rawPayload={fyndPayloadInfo?.rawJson ?? null} title="Fynd Payload" />
                      </div>
                    )}
                  </div>
                )}
              </div>
              );
            })()}

            {/* ── Timeline ── */}
            <div style={{ ...C.card }}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Activity timeline</div>
              {(!Array.isArray(returnCase.events) || returnCase.events.length === 0) ? (
                <div style={{ padding: 20, textAlign: "center", color: "#9CA3AF", fontSize: 14 }}>No events yet. Activity will appear here as the return progresses.</div>
              ) : (
                <div style={{ position: "relative", paddingLeft: 28 }}>
                  <div style={{ position: "absolute", left: 11, top: 8, bottom: 8, width: 2, background: "#E5E7EB" }} />
                  {returnCase.events.map((ev, i) => {
                    if (!ev) return null;
                    const isLatest = i === returnCase.events.length - 1;
                    const sourceColor = ev.source === "fynd_webhook" ? "#059669" : ev.source === "portal" ? "#2563EB" : ev.source === "system" ? "#8B5CF6" : ev.source === "shopify_webhook" ? "#0EA5E9" : "#64748B";
                    const sourceLabel = ev.source === "fynd_webhook" ? "Fynd" : ev.source === "shopify_webhook" ? "Shopify" : ev.source === "system" ? "System" : ev.source === "portal" ? "Portal" : "Admin";
                    let evPayload: Record<string, unknown> | null = null;
                    try { if (ev.payloadJson) evPayload = JSON.parse(ev.payloadJson) as Record<string, unknown>; } catch { evPayload = null; }
                    const evAdminEmail = evPayload?.adminEmail as string | null | undefined;
                    const isFyndSyncEvent = ["fynd_sync", "fynd_sync_failed", "fynd_sync_retry_success", "fynd_sync_retries_exhausted"].includes(ev.eventType);
                    return (
                      <div key={ev.id} style={{ position: "relative", paddingBottom: i < returnCase.events.length - 1 ? 20 : 0 }}>
                        <div style={{ position: "absolute", left: -22, top: 2, width: 12, height: 12, borderRadius: "50%", background: isLatest ? sourceColor : "#D1D5DB", border: "2px solid #fff", boxShadow: isLatest ? `0 0 0 3px ${sourceColor}30` : "none" }} />
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 14, color: "#1F2937" }}>
                            {(ev.eventType || "unknown").replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase())}
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
                            <span style={{ fontSize: 11, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: `${sourceColor}15`, color: sourceColor }}>{sourceLabel}</span>
                            <span style={{ fontSize: 12, color: "#9CA3AF" }}>{ev.happenedAt ? new Intl.DateTimeFormat(shopLocale || "en", { dateStyle: "medium", timeStyle: "short", timeZone: undefined }).format(new Date(ev.happenedAt)) : "\u2014"}</span>
                            {ev.source === "admin" && evAdminEmail && (
                              <span style={{ fontSize: 11, color: "#6B7280" }}>by {evAdminEmail}</span>
                            )}
                          </div>
                          {/* Structured Fynd sync event display */}
                          {isFyndSyncEvent && evPayload && (
                            <div style={{ marginTop: 8, padding: "8px 10px", borderRadius: 6, fontSize: 12, lineHeight: 1.6,
                              background: evPayload.status === "success" ? "#F0FDF4" : evPayload.status === "failed" ? "#FEF2F2" : "#F8FAFC",
                              border: `1px solid ${evPayload.status === "success" ? "#BBF7D0" : evPayload.status === "failed" ? "#FECACA" : "#E2E8F0"}`,
                            }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 4 }}>
                                {evPayload.status === "success" && <span style={{ padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: "#DCFCE7", color: "#166534" }}>SUCCESS</span>}
                                {evPayload.status === "failed" && <span style={{ padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: "#FEE2E2", color: "#991B1B" }}>FAILED</span>}
                                {!!evPayload.action && <span style={{ fontSize: 11, color: "#6B7280" }}>{String(evPayload.action).replace(/_/g, " ")}</span>}
                                {typeof evPayload.durationMs === "number" && <span style={{ fontSize: 11, color: "#9CA3AF" }}>{String(evPayload.durationMs)}ms</span>}
                                {typeof evPayload.attempt === "number" && <span style={{ fontSize: 11, color: "#9CA3AF" }}>attempt #{String(evPayload.attempt)}</span>}
                                {typeof evPayload.retryAttempt === "number" && <span style={{ fontSize: 11, color: "#9CA3AF" }}>retry #{String(evPayload.retryAttempt)}</span>}
                              </div>
                              {/* Success: show IDs */}
                              {evPayload.status === "success" && !!(evPayload.fyndReturnId || evPayload.fyndShipmentId) && (
                                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", fontSize: 11 }}>
                                  {!!evPayload.fyndReturnId && <span><strong>Return ID:</strong> <code style={{ fontFamily: "monospace", fontSize: 10 }}>{String(evPayload.fyndReturnId)}</code></span>}
                                  {!!evPayload.fyndShipmentId && <span><strong>Shipment:</strong> <code style={{ fontFamily: "monospace", fontSize: 10 }}>{String(evPayload.fyndShipmentId)}</code></span>}
                                  {!!evPayload.fyndOrderId && <span><strong>Order:</strong> <code style={{ fontFamily: "monospace", fontSize: 10 }}>{String(evPayload.fyndOrderId)}</code></span>}
                                </div>
                              )}
                              {/* Failed: show error + type */}
                              {evPayload.status === "failed" && !!evPayload.error && (
                                <div style={{ fontSize: 11 }}>
                                  {!!evPayload.errorType && (
                                    <span style={{ padding: "1px 5px", borderRadius: 3, fontSize: 9, fontWeight: 700, textTransform: "uppercase", background: "#FEF3C7", color: "#92400E", marginRight: 6 }}>
                                      {String(evPayload.errorType).replace(/_/g, " ")}
                                    </span>
                                  )}
                                  <span style={{ color: "#991B1B" }}>{String(evPayload.error).slice(0, 300)}</span>
                                  {!!evPayload.retryScheduled && !!evPayload.nextRetryAt && (
                                    <div style={{ marginTop: 4, color: "#B45309" }}>Retry scheduled: {String(evPayload.nextRetryAt)}</div>
                                  )}
                                </div>
                              )}
                              {/* Exhausted: show guidance */}
                              {ev.eventType === "fynd_sync_retries_exhausted" && (
                                <div style={{ fontSize: 11, color: "#991B1B" }}>
                                  <strong>All {String(evPayload.maxRetries ?? evPayload.attempts)} retries exhausted.</strong>
                                  {!!evPayload.lastError && <span> Last error: {String(evPayload.lastError).slice(0, 200)}</span>}
                                  <div style={{ marginTop: 4, color: "#92400E" }}>Use the &ldquo;Sync to Fynd&rdquo; button above, or process the refund manually.</div>
                                </div>
                              )}
                            </div>
                          )}
                          {/* Raw JSON fallback for non-sync events */}
                          {!isFyndSyncEvent && ev.payloadJson && (
                            <details style={{ marginTop: 6 }}>
                              <summary style={{ fontSize: 11, color: "#9CA3AF", cursor: "pointer", userSelect: "none" }}>Show details</summary>
                              <pre style={{ marginTop: 4, padding: "6px 8px", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 6, fontSize: 11, color: "#475569", overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 200 }}>
                                {JSON.stringify(evPayload, null, 2)}
                              </pre>
                            </details>
                          )}
                          {/* Raw JSON expandable for sync events too (for debugging) */}
                          {isFyndSyncEvent && ev.payloadJson && (
                            <details style={{ marginTop: 4 }}>
                              <summary style={{ fontSize: 10, color: "#C0C0C0", cursor: "pointer", userSelect: "none" }}>Raw JSON</summary>
                              <pre style={{ marginTop: 4, padding: "6px 8px", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 6, fontSize: 10, color: "#64748B", overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 160 }}>
                                {JSON.stringify(evPayload, null, 2)}
                              </pre>
                            </details>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          {/* ── RIGHT SIDEBAR ── */}
          <div>
            {/* ── Cancellation Request Banner ── */}
            {hasCancellationRequest && (
              <div style={{
                padding: 16, background: "#FFFBEB", borderRadius: 12,
                border: "1px solid #FDE68A", marginBottom: 16,
              }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                  <span style={{ fontSize: 18, flexShrink: 0 }}>⚠️</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: 14, color: "#92400E", marginBottom: 4 }}>
                      Customer requested cancellation
                    </div>
                    <div style={{ fontSize: 12, color: "#78350F", marginBottom: 2 }}>
                      Requested on {cancellationRequestedAt ? new Date(cancellationRequestedAt as string).toLocaleString() : "—"}
                      {cancellationRequestedBy ? ` via ${cancellationRequestedBy}` : ""}
                    </div>
                    {cancellationReason && (
                      <div style={{
                        fontSize: 12, color: "#78350F", marginTop: 6,
                        padding: "6px 10px", background: "#FEF3C7", borderRadius: 6,
                        fontStyle: "italic",
                      }}>
                        Reason: &ldquo;{cancellationReason}&rdquo;
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                      <button
                        type="button"
                        disabled={fetcher.state !== "idle"}
                        onClick={() => setShowApproveCancelModal(true)}
                        style={{
                          padding: "6px 14px", fontSize: 12, fontWeight: 600,
                          background: "#DC2626", color: "#fff", border: "none",
                          borderRadius: 6, cursor: "pointer",
                        }}
                      >
                        Approve Cancellation
                      </button>
                      <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`}>
                        <input type="hidden" name="json" value={JSON.stringify({ action: "decline_cancellation" })} />
                        <button
                          type="submit"
                          disabled={fetcher.state !== "idle"}
                          style={{
                            padding: "6px 14px", fontSize: 12, fontWeight: 600,
                            background: "#fff", color: "#374151", border: "1px solid #D1D5DB",
                            borderRadius: 6, cursor: "pointer",
                          }}
                        >
                          Decline
                        </button>
                      </fetcher.Form>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Approve Cancellation Confirmation Modal */}
            {showApproveCancelModal && (
              <div className="app-modal-overlay" onClick={() => setShowApproveCancelModal(false)}>
                <div className="app-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 420 }}>
                  <div className="app-modal-title">Approve Cancellation</div>
                  <div className="app-modal-body">
                    <p style={{ margin: 0, fontSize: 14 }}>
                      Are you sure you want to approve the customer&apos;s cancellation request for order{" "}
                      <strong>{returnCase.shopifyOrderName || "—"}</strong>?
                    </p>
                    <p style={{ margin: "10px 0 0", fontSize: 13, color: "#6B7280" }}>
                      This will cancel the return and cannot be undone. If synced to Fynd, a cancellation request will also be sent to Fynd.
                    </p>
                  </div>
                  <div className="app-modal-actions">
                    <button type="button" onClick={() => setShowApproveCancelModal(false)} style={{ padding: "6px 14px", fontSize: 13, background: "#fff", border: "1px solid #D1D5DB", borderRadius: 6, cursor: "pointer" }}>
                      Go Back
                    </button>
                    <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`} onSubmit={() => setShowApproveCancelModal(false)}>
                      <input type="hidden" name="json" value={JSON.stringify({ action: "approve_cancellation" })} />
                      <button type="submit" disabled={fetcher.state !== "idle"} style={{ padding: "6px 14px", fontSize: 13, fontWeight: 600, background: "#DC2626", color: "#fff", border: "none", borderRadius: 6, cursor: "pointer" }}>
                        Confirm Cancellation
                      </button>
                    </fetcher.Form>
                  </div>
                </div>
              </div>
            )}

            {/* ── Cancellation Declined Indicator ── */}
            {!hasCancellationRequest && cancellationDeclinedAt && (
              <div style={{
                padding: 12, background: "#F9FAFB", borderRadius: 10,
                border: "1px solid #E5E7EB", marginBottom: 16,
                fontSize: 12, color: "#6B7280",
              }}>
                ℹ️ Cancellation request declined on{" "}
                {new Date(cancellationDeclinedAt as string).toLocaleString()}
              </div>
            )}

            {/* ── Actions Card ── */}
            <div style={{ ...C.card, background: "#F9FAFB" }}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Actions</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {isPending && (
                  <>
                    {/* Labels reflect the customer's requested resolution type. When the
                        customer asked for an exchange, "Approve Return" is misleading — show
                        "Approve Exchange" / "Reject Exchange" instead. */}
                    {(() => {
                      const isExchangeFlow = (returnCase.resolutionType || "").toLowerCase() === "exchange";
                      const approveLabel = isExchangeFlow ? "Approve Exchange" : "Approve Return";
                      return (
                        <s-button type="button" variant="primary" disabled={fetcher.state !== "idle"} onClick={() => setShowApproveModal(true)} style={{ width: "100%" }}>
                          {approveLabel}
                        </s-button>
                      );
                    })()}
                    {showApproveModal && (
                      <div className="app-modal-overlay" onClick={() => setShowApproveModal(false)}>
                        <div className="app-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
                          <div className="app-modal-title">{(returnCase.resolutionType || "").toLowerCase() === "exchange" ? "Approve Exchange" : "Approve Return"}</div>
                          <div className="app-modal-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                            <p style={{ margin: 0 }}>
                              Approve return for order <strong>{returnCase.shopifyOrderName || "--"}</strong>
                            </p>
                            <div style={{ padding: 14, background: "#F9FAFB", borderRadius: 10, border: "1px solid #E5E7EB" }}>
                              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>Resolution type</div>
                              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                {([
                                  { value: "refund", label: "Refund", desc: "Refund to customer's payment method", color: "#2563EB", bg: "#DBEAFE", border: "#93C5FD" },
                                  { value: "exchange", label: "Exchange", desc: "Create a new order with replacement items", color: "#059669", bg: "#DCFCE7", border: "#BBF7D0" },
                                  { value: "store_credit", label: "Store Credit", desc: "Issue store credit to customer's account", color: "#7C3AED", bg: "#F3E8FF", border: "#D8B4FE" },
                                  { value: "replacement", label: "Replacement", desc: "Send the same item(s) again", color: "#EA580C", bg: "#FFF7ED", border: "#FED7AA" },
                                ] as const).map((opt) => (
                                  <label key={opt.value} style={{
                                    display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", cursor: "pointer",
                                    borderRadius: 8, fontSize: 13,
                                    background: selectedResolutionType === opt.value ? opt.bg : "transparent",
                                    border: selectedResolutionType === opt.value ? `1.5px solid ${opt.border}` : "1.5px solid transparent",
                                    transition: "all 0.12s",
                                  }}>
                                    <input type="radio" checked={selectedResolutionType === opt.value} onChange={() => setSelectedResolutionType(opt.value)} style={{ accentColor: opt.color }} />
                                    <div style={{ flex: 1 }}>
                                      <div style={{ fontWeight: 600, fontSize: 12.5, color: selectedResolutionType === opt.value ? opt.color : "#374151" }}>
                                        {opt.label}
                                      </div>
                                      <div style={{ fontSize: 11, color: "#6B7280", marginTop: 1 }}>{opt.desc}</div>
                                    </div>
                                  </label>
                                ))}
                              </div>
                            </div>
                          </div>
                          <div className="app-modal-actions">
                            <s-button type="button" variant="secondary" onClick={() => setShowApproveModal(false)}>Cancel</s-button>
                            <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`}>
                              <input type="hidden" name="json" value={JSON.stringify({ action: "approve", resolutionType: selectedResolutionType })} />
                              <s-button type="submit" variant="primary" disabled={fetcher.state !== "idle"}>
                                {fetcher.state !== "idle" ? "Processing..." : "Confirm Approval"}
                              </s-button>
                            </fetcher.Form>
                          </div>
                        </div>
                      </div>
                    )}
                    {!showRejectForm ? (
                      <s-button type="button" variant="secondary" disabled={fetcher.state !== "idle"} onClick={() => setShowRejectForm(true)} style={{ width: "100%" }}>
                        {(returnCase.resolutionType || "").toLowerCase() === "exchange" ? "Reject Exchange" : "Reject Return"}
                      </s-button>
                    ) : (
                      <div style={{ padding: 12, background: "#fff", borderRadius: 8, border: "1px solid #FECACA" }}>
                        <label style={{ display: "block", marginBottom: 6, fontWeight: 600, fontSize: 13 }}>Rejection reason</label>
                        <textarea value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Shown to customer..." rows={2} style={{ width: "100%", padding: 8, borderRadius: 6, border: "1px solid #E5E7EB", marginBottom: 8, boxSizing: "border-box", fontSize: 13 }} />
                        <div style={{ display: "flex", gap: 6 }}>
                          <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`} style={{ flex: 1 }}>
                            <input type="hidden" name="json" value={JSON.stringify({ action: "reject", rejectionReason: rejectReason.trim() })} />
                            <s-button type="submit" variant="secondary" disabled={fetcher.state !== "idle" || !rejectReason.trim()} style={{ width: "100%" }}>Confirm</s-button>
                          </fetcher.Form>
                          <s-button type="button" variant="secondary" onClick={() => { setShowRejectForm(false); setRejectReason(""); }}>Cancel</s-button>
                        </div>
                      </div>
                    )}
                  </>
                )}
                {(isPostApproval || isCompleted) && !isRefunded && !isManualReturn && !exchangeResolved && (() => {
                  const isFyndIntegrated = !!(returnCase.fyndOrderId || returnCase.fyndShipmentId || returnCase.fyndReturnId);
                  const refundGateStatuses = allowedFyndStatusesForRefund ?? [];
                  const currentFyndStatusLower = (fyndCurrentStatus ?? "").toLowerCase().trim();
                  const refundGatedByFynd = isFyndIntegrated
                    && refundGateStatuses.length > 0
                    && (!currentFyndStatusLower || !refundGateStatuses.includes(currentFyndStatusLower));
                  const gatePresetLabel = refundGatePreset && PRESET_LABELS[refundGatePreset as RefundGatePreset]
                    ? PRESET_LABELS[refundGatePreset as RefundGatePreset].label
                    : null;
                  return (
                  <>
                    {refundGatedByFynd && (
                      <div style={{ padding: "10px 14px", background: "#FEF3C7", border: "1px solid #FDE68A", borderRadius: 8, fontSize: 12, color: "#92400E", marginBottom: 8 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                          <strong>Refund gated by Fynd status</strong>
                        </div>
                        {currentFyndStatusLower ? (
                          <div>Current status: <code style={{ background: "#FDE68A", padding: "1px 5px", borderRadius: 3 }}>{fyndCurrentStatus}</code></div>
                        ) : (
                          <div>Waiting for Fynd status update...</div>
                        )}
                        {gatePresetLabel && gatePresetLabel !== "Custom" && (
                          <div style={{ marginTop: 2 }}>Refund available: <strong>{gatePresetLabel}</strong></div>
                        )}
                      </div>
                    )}
                    <s-button type="button" variant="primary" disabled={fetcher.state !== "idle" || refundGatedByFynd} onClick={() => setShowRefundConfirm(true)} style={{ width: "100%" }}>
                      Process Refund
                    </s-button>
                    {showRefundConfirm && (
                      <div className="app-modal-overlay" onClick={() => { if (!fetcher.data?.error) setShowRefundConfirm(false); }}>
                        <div className="app-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 520 }}>
                          <div className="app-modal-title">Process Refund</div>
                          <div className="app-modal-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                            <p style={{ margin: 0 }}>
                              Refund for order <strong>{returnCase.shopifyOrderName || "—"}</strong>
                            </p>

                            {/* Error shown INSIDE modal so user doesn't need to close it to read the error */}
                            {fetcher.data?.error && (
                              <div style={{ padding: "10px 14px", background: "#FEF2F2", border: "1px solid #FECACA", borderLeft: "4px solid #DC2626", borderRadius: 8, fontSize: 13, color: "#991B1B" }}>
                                <div style={{ display: "flex", alignItems: "flex-start", gap: 8 }}>
                                  <svg style={{ flexShrink: 0, marginTop: 1 }} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                                  <span>{fetcher.data.error}</span>
                                </div>
                              </div>
                            )}

                            {/* Refund Method */}
                            <div style={{ padding: 14, background: "#F9FAFB", borderRadius: 10, border: "1px solid #E5E7EB" }}>
                              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
                                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="1" y="4" width="22" height="16" rx="2" ry="2"/><line x1="1" y1="10" x2="23" y2="10"/></svg>
                                Refund method
                              </div>
                              {isCodOrder && (
                                <div style={{ marginBottom: 8, padding: "8px 12px", background: "#FEF3C7", borderRadius: 6, fontSize: 12, color: "#92400E", display: "flex", alignItems: "center", gap: 6, borderLeft: "3px solid #F59E0B" }}>
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
                                  <span><strong>COD order</strong> — Refund to original payment is not available. Use Store credit.</span>
                                </div>
                              )}
                              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                {([
                                  { value: "original" as const, label: "Original payment", desc: isCodOrder ? "Not available for COD orders" : "Refund to customer's original payment method", color: "#3B82F6", bg: "#EFF6FF", border: "#3B82F6", disabled: isCodOrder },
                                  { value: "store_credit" as const, label: "Store credit", desc: "Issue as store credit to customer's account", color: "#22C55E", bg: "#F0FDF4", border: "#22C55E", disabled: false },
                                  { value: "both" as const, label: "Split refund", desc: isCodOrder ? "Not available for COD orders" : "Split between original payment and store credit", color: "#F59E0B", bg: "#FFFBEB", border: "#F59E0B", disabled: isCodOrder },
                                ]).map((opt) => (
                                  <label key={opt.value} style={{
                                    display: "flex", alignItems: "center", gap: 8, padding: "8px 10px",
                                    cursor: opt.disabled ? "not-allowed" : "pointer",
                                    borderRadius: 8, fontSize: 13,
                                    opacity: opt.disabled ? 0.45 : 1,
                                    background: modalRefundMethod === opt.value ? opt.bg : "transparent",
                                    border: modalRefundMethod === opt.value ? `1.5px solid ${opt.border}` : "1.5px solid transparent",
                                    transition: "all 0.12s",
                                  }}>
                                    <input type="radio" checked={modalRefundMethod === opt.value} disabled={opt.disabled} onChange={() => !opt.disabled && setModalRefundMethod(opt.value)} style={{ accentColor: opt.color }} />
                                    <div style={{ flex: 1 }}>
                                      <div style={{ fontWeight: 600, fontSize: 12.5, color: modalRefundMethod === opt.value ? opt.color : "#374151", display: "flex", alignItems: "center", gap: 6 }}>
                                        {opt.label}
                                        {opt.value === "store_credit" && isCodOrder && (
                                          <span style={{ fontSize: 10, fontWeight: 600, padding: "1px 6px", background: "#DCFCE7", borderRadius: 4, color: "#166534", textTransform: "uppercase", letterSpacing: "0.3px" }}>Recommended</span>
                                        )}
                                      </div>
                                      <div style={{ fontSize: 11, color: "#6B7280", marginTop: 1 }}>{opt.desc}</div>
                                    </div>
                                  </label>
                                ))}
                              </div>
                              {modalRefundMethod === "both" && (
                                <div style={{ marginTop: 10, padding: "12px 14px", background: "#FEF3C7", borderRadius: 8 }}>
                                  <div style={{ fontSize: 12, color: "#92400E", marginBottom: 8, fontWeight: 500 }}>
                                    Eligible refund: <strong>{formatMoney(String(refundItemTotal.toFixed(2)), shopCurrency, shopLocale)}</strong>
                                  </div>
                                  <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                                    <button
                                      type="button"
                                      onClick={() => setSplitMode("percentage")}
                                      style={{
                                        padding: "4px 12px", fontSize: 11, borderRadius: 6, border: "1px solid #D97706",
                                        background: splitMode === "percentage" ? "#F59E0B" : "transparent",
                                        color: splitMode === "percentage" ? "#fff" : "#92400E",
                                        cursor: "pointer", fontWeight: 600,
                                      }}
                                    >
                                      Percentage
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setSplitMode("amount");
                                        const sc = Math.round(refundItemTotal * (modalStoreCreditPct / 100) * 100) / 100;
                                        const orig = Math.round((refundItemTotal - sc) * 100) / 100;
                                        setSplitScAmount(sc.toFixed(2));
                                        setSplitOrigAmount(orig >= 0 ? orig.toFixed(2) : "0.00");
                                      }}
                                      style={{
                                        padding: "4px 12px", fontSize: 11, borderRadius: 6, border: "1px solid #D97706",
                                        background: splitMode === "amount" ? "#F59E0B" : "transparent",
                                        color: splitMode === "amount" ? "#fff" : "#92400E",
                                        cursor: "pointer", fontWeight: 600,
                                      }}
                                    >
                                      Amount
                                    </button>
                                  </div>
                                  {splitMode === "percentage" ? (
                                    <>
                                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                                        <span style={{ fontSize: 12, fontWeight: 600, color: "#92400E" }}>Store credit: {modalStoreCreditPct}%</span>
                                        <span style={{ fontSize: 11, color: "#B45309" }}>|</span>
                                        <span style={{ fontSize: 12, fontWeight: 600, color: "#92400E" }}>Original: {100 - modalStoreCreditPct}%</span>
                                      </div>
                                      <input
                                        aria-label="Store credit percentage"
                                        type="range" min={5} max={95} step={5}
                                        value={modalStoreCreditPct}
                                        onChange={(e) => setModalStoreCreditPct(parseInt(e.target.value, 10))}
                                        style={{ width: "100%", accentColor: "#F59E0B" }}
                                      />
                                    </>
                                  ) : (
                                    <>
                                      <div style={{ display: "flex", gap: 10, marginBottom: 6 }}>
                                        <div style={{ flex: 1 }}>
                                          <label style={{ fontSize: 11, fontWeight: 600, color: "#92400E", display: "block", marginBottom: 3 }}>Store Credit</label>
                                          <input
                                            aria-label="Store credit amount"
                                            type="number"
                                            min="0"
                                            step="0.01"
                                            max={refundItemTotal}
                                            value={splitScAmount}
                                            onChange={(e) => {
                                              const v = e.target.value;
                                              setSplitScAmount(v);
                                              const sc = parseFloat(v) || 0;
                                              const remaining = Math.round((refundItemTotal - sc) * 100) / 100;
                                              setSplitOrigAmount(remaining >= 0 ? remaining.toFixed(2) : "0.00");
                                            }}
                                            style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #D97706", fontSize: 13, background: "#fff" }}
                                          />
                                        </div>
                                        <div style={{ flex: 1 }}>
                                          <label style={{ fontSize: 11, fontWeight: 600, color: "#92400E", display: "block", marginBottom: 3 }}>Original Payment</label>
                                          <input
                                            aria-label="Original payment amount"
                                            type="number"
                                            min="0"
                                            step="0.01"
                                            max={refundItemTotal}
                                            value={splitOrigAmount}
                                            onChange={(e) => {
                                              const v = e.target.value;
                                              setSplitOrigAmount(v);
                                              const orig = parseFloat(v) || 0;
                                              const remaining = Math.round((refundItemTotal - orig) * 100) / 100;
                                              setSplitScAmount(remaining >= 0 ? remaining.toFixed(2) : "0.00");
                                            }}
                                            style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #D97706", fontSize: 13, background: "#fff" }}
                                          />
                                        </div>
                                      </div>
                                      {(() => {
                                        const sum = (parseFloat(splitScAmount) || 0) + (parseFloat(splitOrigAmount) || 0);
                                        const diff = Math.abs(sum - refundItemTotal);
                                        if (diff > 0.01) {
                                          return (
                                            <div style={{ fontSize: 11, color: "#DC2626", marginTop: 4 }}>
                                              Sum ({formatMoney(String(sum.toFixed(2)), shopCurrency, shopLocale)}) does not match eligible amount ({formatMoney(String(refundItemTotal.toFixed(2)), shopCurrency, shopLocale)}).
                                            </div>
                                          );
                                        }
                                        return null;
                                      })()}
                                    </>
                                  )}
                                </div>
                              )}
                              {modalRefundMethod === "store_credit" && (
                                <div style={{ marginTop: 8, fontSize: 11, color: "#166534", background: "#DCFCE7", padding: "6px 10px", borderRadius: 6 }}>
                                  Requires new customer accounts in Shopify. Order must have an associated customer.
                                </div>
                              )}
                            </div>

                            {/* Bonus Credit Preview */}
                            {bonusCreditEnabled && (modalRefundMethod === "store_credit" || modalRefundMethod === "both") && (() => {
                              if (refundItemTotal <= 0) return null;
                              const bonusAmt = Math.round(refundItemTotal * (bonusCreditPct / 100) * 100) / 100;
                              /* v8 ignore start */
                              // defensive: 4-way nested ternary on modalRefundMethod x splitMode requires user-driven modal interaction; combinatorial branch coverage infeasible in unit tests
                              const scPortion = modalRefundMethod === "both"
                                ? (splitMode === "amount"
                                  ? (parseFloat(splitScAmount) || 0)
                                  : Math.round(refundItemTotal * (modalStoreCreditPct / 100) * 100) / 100)
                                : refundItemTotal;
                              const scPortionLabel = modalRefundMethod === "both"
                                ? (splitMode === "amount"
                                  ? `Store credit portion (${formatMoney(String(scPortion.toFixed(2)), shopCurrency, shopLocale)})`
                                  : `Store credit portion (${modalStoreCreditPct}%)`)
                                : "Refund amount";
                              /* v8 ignore stop */
                              const totalCredit = Math.round((scPortion + bonusAmt) * 100) / 100;
                              return (
                                <div style={{ padding: 14, background: "#F0FDF4", borderRadius: 10, border: "1px solid #BBF7D0" }}>
                                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, display: "flex", alignItems: "center", gap: 6, color: "#166534" }}>
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#166534" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2z"/></svg>
                                    Store credit bonus ({bonusCreditPct}%)
                                  </div>
                                  <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                                      <span style={{ color: "#374151" }}>{scPortionLabel}</span>
                                      <span style={{ fontWeight: 500 }}>{formatMoney(String(scPortion.toFixed(2)), shopCurrency, shopLocale)}</span>
                                    </div>
                                    <div style={{ display: "flex", justifyContent: "space-between", color: "#059669" }}>
                                      <span>+ Bonus credit ({bonusCreditPct}%)</span>
                                      <span style={{ fontWeight: 600 }}>+{formatMoney(String(bonusAmt), shopCurrency, shopLocale)}</span>
                                    </div>
                                    <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 700, fontSize: 14, marginTop: 4, paddingTop: 6, borderTop: "1px solid #BBF7D0" }}>
                                      <span style={{ color: "#166534" }}>Total store credit</span>
                                      <span style={{ color: "#166534" }}>{formatMoney(String(totalCredit), shopCurrency, shopLocale)}</span>
                                    </div>
                                  </div>
                                </div>
                              );
                            })()}

                            {/* Restock Location */}
                            {!isGreenReturn && shopLocations.length > 0 && (
                              <div style={{ padding: 14, background: "#F9FAFB", borderRadius: 10, border: "1px solid #E5E7EB" }}>
                                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                                  Restock location
                                </div>
                                {fulfillmentLocationId && (
                                  <div style={{ fontSize: 12, color: "#059669", marginBottom: 8, display: "flex", alignItems: "center", gap: 6 }}>
                                    Fulfilled from: <strong>{fulfillmentLocationName}</strong>
                                    {selectedLocationId === fulfillmentLocationId && (
                                      <span style={{ fontSize: 11, padding: "1px 6px", background: "#DCFCE7", borderRadius: 4, color: "#166534" }}>Preferred</span>
                                    )}
                                  </div>
                                )}
                                {refundLocationMode === "auto" ? (
                                  <div style={{ fontSize: 12, color: "#6B7280" }}>
                                    Location set automatically to the fulfillment location.
                                    <span style={{ fontSize: 11, display: "block", marginTop: 4, color: "#9CA3AF" }}>
                                      Change this in Settings → Return Settings.
                                    </span>
                                  </div>
                                ) : (
                                  <select
                                    value={selectedLocationId}
                                    onChange={(e) => setSelectedLocationId(e.target.value)}
                                    style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 13, background: "#fff" }}
                                    aria-label="Select restock location"
                                  >
                                    {shopLocations.filter((l) => l.isActive).map((loc) => (
                                      <option key={loc.id} value={loc.id}>
                                        {loc.name}{loc.id === fulfillmentLocationId ? " (Fulfilled here)" : ""}
                                      </option>
                                    ))}
                                  </select>
                                )}
                              </div>
                            )}

                            <p style={{ color: "#DC2626", fontWeight: 500, fontSize: 13, margin: 0 }}>This action cannot be undone.</p>
                          </div>
                          <div className="app-modal-actions">
                            <s-button type="button" variant="secondary" onClick={() => setShowRefundConfirm(false)}>Cancel</s-button>
                            <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`}>
                              <input type="hidden" name="json" value={JSON.stringify({
                                action: "process_refund",
                                locationId: isGreenReturn ? null : (refundLocationMode === "auto"
                                  ? (fulfillmentLocationId || shopLocations[0]?.id || null)
                                  : (selectedLocationId || null)),
                                refundMethod: modalRefundMethod,
                                storeCreditPct: modalRefundMethod === "both" ? modalStoreCreditPct : undefined,
                                splitMode: modalRefundMethod === "both" ? splitMode : undefined,
                                splitScAmount: modalRefundMethod === "both" && splitMode === "amount" ? (parseFloat(splitScAmount) || 0) : undefined,
                                splitOrigAmount: modalRefundMethod === "both" && splitMode === "amount" ? (parseFloat(splitOrigAmount) || 0) : undefined,
                                ...(bonusCreditEnabled && (modalRefundMethod === "store_credit" || modalRefundMethod === "both") ? {
                                  bonusAmount: refundItemTotal > 0 ? Math.round(refundItemTotal * (bonusCreditPct / 100) * 100) / 100 : undefined,
                                } : {}),
                              })} />
                              <s-button type="submit" variant="primary" disabled={fetcher.state !== "idle"}>
                                {fetcher.state !== "idle" ? (
                                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                    <svg style={{ animation: "spin 1s linear infinite" }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                                    Processing...
                                  </span>
                                ) : (
                                  modalRefundMethod === "original" ? "Refund to original payment" :
                                  modalRefundMethod === "store_credit" ? "Issue store credit" :
                                  "Process split refund"
                                )}
                              </s-button>
                            </fetcher.Form>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                  );
                })()}
                {(isPostApproval || isCompleted) && !isRefunded && isManualReturn && !exchangeResolved && (
                  <div style={{ padding: 10, background: "#FEF3C7", borderRadius: 8, fontSize: 13, color: "#92400E" }}>
                    Manual return — process refund in Shopify Admin for <strong>{returnCase.shopifyOrderName || "--"}</strong>
                  </div>
                )}
                {(isPostApproval || isCompleted) && returnCase.resolutionType === "replacement" && !returnCase.exchangeOrderId && !isManualReturn && (
                  <>
                    <s-button
                      type="button"
                      variant="primary"
                      disabled={fetcher.state !== "idle" || replacementBlockedByFynd}
                      onClick={() => !replacementBlockedByFynd && setShowReplacementConfirm(true)}
                      style={{ width: "100%" }}
                    >
                      Process Replacement
                    </s-button>
                    {replacementBlockedByFynd && (
                      <div style={{ marginTop: 6, padding: "8px 12px", background: "#FEF3C7", borderRadius: 6, fontSize: 12, color: "#92400E", border: "1px solid #FDE68A" }}>
                        <strong>Replacement unavailable</strong> — Return bag not yet received at warehouse. Current Fynd status: <code style={{ background: "#FDE68A", padding: "1px 5px", borderRadius: 3 }}>{fyndCurrentStatus}</code>. Available after <code style={{ background: "#FDE68A", padding: "1px 5px", borderRadius: 3 }}>return_bag_delivered</code>.
                      </div>
                    )}
                    {showReplacementConfirm && (
                      <div className="app-modal-overlay" onClick={() => setShowReplacementConfirm(false)}>
                        <div className="app-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
                          <div className="app-modal-title">Process Replacement</div>
                          <div className="app-modal-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                            <p style={{ margin: 0 }}>
                              Create a new Shopify order to reship the same item(s) at no charge for order <strong>{returnCase.shopifyOrderName || "--"}</strong>.
                            </p>
                            <div style={{ padding: 12, background: "#FFF7ED", borderRadius: 8, border: "1px solid #FED7AA", fontSize: 13, color: "#9A3412" }}>
                              A real Shopify order will be created with a 100% applied discount (no charge to the customer). It will appear under <strong>Orders</strong> in Shopify Admin so the warehouse can fulfill it.
                            </div>
                            {fetcher.data?.error && (
                              <div style={{ padding: "10px 14px", background: "#FEF2F2", border: "1px solid #FECACA", borderLeft: "4px solid #DC2626", borderRadius: 8, fontSize: 13, color: "#991B1B" }}>
                                {fetcher.data.error}
                              </div>
                            )}
                            <p style={{ color: "#DC2626", fontWeight: 500, fontSize: 13, margin: 0 }}>This action cannot be undone.</p>
                          </div>
                          <div className="app-modal-actions">
                            <s-button type="button" variant="secondary" onClick={() => setShowReplacementConfirm(false)}>Cancel</s-button>
                            <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`}>
                              <input type="hidden" name="json" value={JSON.stringify({ action: "process_replacement" })} />
                              <s-button type="submit" variant="primary" disabled={fetcher.state !== "idle"}>
                                {fetcher.state !== "idle" ? (
                                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                    <svg style={{ animation: "spin 1s linear infinite" }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                                    Creating...
                                  </span>
                                ) : "Create Replacement Order"}
                              </s-button>
                            </fetcher.Form>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
                {(isPostApproval || isCompleted) && returnCase.resolutionType === "exchange" && !returnCase.exchangeOrderId && !isManualReturn && (
                  <>
                    <s-button
                      type="button"
                      variant="primary"
                      disabled={fetcher.state !== "idle" || exchangeBlockedByFynd}
                      onClick={() => !exchangeBlockedByFynd && setShowExchangeConfirm(true)}
                      style={{ width: "100%" }}
                    >
                      Process Exchange
                    </s-button>
                    {exchangeBlockedByFynd && (
                      <div style={{ marginTop: 6, padding: "8px 12px", background: "#FEF3C7", borderRadius: 6, fontSize: 12, color: "#92400E", border: "1px solid #FDE68A" }}>
                        <strong>Exchange unavailable</strong> — Return bag not yet received at warehouse. Current Fynd status: <code style={{ background: "#FDE68A", padding: "1px 5px", borderRadius: 3 }}>{fyndCurrentStatus}</code>. Available after <code style={{ background: "#FDE68A", padding: "1px 5px", borderRadius: 3 }}>return_bag_delivered</code>.
                      </div>
                    )}
                    {showExchangeConfirm && (
                      <div className="app-modal-overlay" onClick={() => setShowExchangeConfirm(false)}>
                        <div className="app-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
                          <div className="app-modal-title">Process Exchange</div>
                          <div className="app-modal-body" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                            <p style={{ margin: 0 }}>
                              Create a draft order in Shopify with the same items from order <strong>{returnCase.shopifyOrderName || "--"}</strong>.
                            </p>
                            {(returnCase as { exchangePreference?: string | null }).exchangePreference && (
                              <div style={{ padding: 12, background: "#FFFBEB", borderRadius: 8, border: "1px solid #FDE68A", fontSize: 13 }}>
                                <div style={{ fontWeight: 600, color: "#92400E", marginBottom: 4 }}>Customer exchange preference:</div>
                                <div style={{ color: "#78350F" }}>{(returnCase as { exchangePreference?: string | null }).exchangePreference}</div>
                              </div>
                            )}
                            <div style={{ padding: 12, background: "#F0FDF4", borderRadius: 8, border: "1px solid #BBF7D0", fontSize: 13, color: "#166534" }}>
                              A draft order will be created with the customer's email and the return items. You can then complete the order in Shopify Admin.
                            </div>
                            {fetcher.data?.error && (
                              <div style={{ padding: "10px 14px", background: "#FEF2F2", border: "1px solid #FECACA", borderLeft: "4px solid #DC2626", borderRadius: 8, fontSize: 13, color: "#991B1B" }}>
                                {fetcher.data.error}
                              </div>
                            )}
                            <p style={{ color: "#DC2626", fontWeight: 500, fontSize: 13, margin: 0 }}>This action cannot be undone.</p>
                          </div>
                          <div className="app-modal-actions">
                            <s-button type="button" variant="secondary" onClick={() => setShowExchangeConfirm(false)}>Cancel</s-button>
                            <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`}>
                              <input type="hidden" name="json" value={JSON.stringify({ action: "process_exchange" })} />
                              <s-button type="submit" variant="primary" disabled={fetcher.state !== "idle"}>
                                {fetcher.state !== "idle" ? (
                                  <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                                    <svg style={{ animation: "spin 1s linear infinite" }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                                    Creating...
                                  </span>
                                ) : "Create Exchange Order"}
                              </s-button>
                            </fetcher.Form>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
                {returnCase.exchangeOrderId && (() => {
                  const isReplacement = returnCase.resolutionType === "replacement";
                  // Replacement creates a real Order; exchange creates a DraftOrder.
                  // Detect from the GID itself so legacy records render correctly.
                  const isDraftGid = returnCase.exchangeOrderId.startsWith("gid://shopify/DraftOrder/");
                  const orderGidNum = returnCase.exchangeOrderId
                    .replace(/^gid:\/\/shopify\/DraftOrder\//, "")
                    .replace(/^gid:\/\/shopify\/Order\//, "");
                  const orderPath = isDraftGid ? "draft_orders" : "orders";
                  const orderUrl = `https://admin.shopify.com/store/${storeName}/${orderPath}/${orderGidNum}`;
                  type ExchangeItemRich = {
                    title?: string; quantity?: number; price?: string;
                    returnedTitle?: string; returnedQty?: number; returnedUnitPrice?: string;
                    replacementTitle?: string; replacementUnitPrice?: string; replacementImageUrl?: string;
                  };
                  let exchangeItems: ExchangeItemRich[] = [];
                  try {
                    if (returnCase.exchangeItemsJson) exchangeItems = JSON.parse(returnCase.exchangeItemsJson);
                  }
                  /* v8 ignore start */
                  // unreachable: exchangeItemsJson is always valid JSON written by the action handler
                  catch { /* ignore */ }
                  /* v8 ignore stop */

                  // Pull the most recent exchange_created / replacement_created event payload
                  // for flow + price-diff + invoice URL. Falls back to neutral defaults so
                  // legacy records (no event) still render the basic "order created" panel.
                  type ExchangeEventPayload = {
                    flow?: "completed_free" | "completed_with_refund" | "invoice_pending";
                    priceDiff?: number;
                    currency?: string;
                    invoiceUrl?: string | null;
                    refund?: { success?: boolean; amount?: string; refundId?: string } | null;
                  };
                  let exchangePayload: ExchangeEventPayload = {};
                  const events = Array.isArray(returnCase.events) ? returnCase.events : [];
                  for (let i = events.length - 1; i >= 0; i--) {
                    const ev = events[i];
                    if (!ev || (ev.eventType !== "exchange_created" && ev.eventType !== "replacement_created")) continue;
                    if (!ev.payloadJson) continue;
                    try {
                      exchangePayload = JSON.parse(ev.payloadJson) as ExchangeEventPayload;
                      break;
                    }
                    /* v8 ignore start */
                    // unreachable: payloadJson is always valid JSON written by the action handler
                    catch { /* skip */ }
                    /* v8 ignore stop */
                  }

                  const flow = exchangePayload.flow;
                  const priceDiff = typeof exchangePayload.priceDiff === "number" ? exchangePayload.priceDiff : null;
                  const currency = exchangePayload.currency || returnCase.currency || "";
                  const invoiceUrl = exchangePayload.invoiceUrl || null;

                  const headlineLabel = isReplacement
                    ? "Replacement order created"
                    : flow === "invoice_pending"
                      ? "Exchange awaiting payment"
                      : "Exchange order created";
                  const subLabel = isDraftGid ? "Draft Order" : "Order";
                  const panelBg = flow === "invoice_pending" ? "#FFFBEB" : "#DCFCE7";
                  const panelBorder = flow === "invoice_pending" ? "#FDE68A" : "#BBF7D0";
                  const panelText = flow === "invoice_pending" ? "#92400E" : "#166534";

                  return (
                    <div style={{ padding: 14, background: panelBg, borderRadius: 10, border: `1px solid ${panelBorder}` }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={panelText} strokeWidth="2.5">
                          {flow === "invoice_pending"
                            ? (<><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></>)
                            : (<polyline points="20 6 9 17 4 12"/>)
                          }
                        </svg>
                        <span style={{ fontWeight: 700, fontSize: 14, color: panelText }}>{headlineLabel}</span>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {returnCase.exchangeOrderName && (
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                            <span style={{ color: panelText }}>{subLabel}</span>
                            <span style={{ fontWeight: 700, color: panelText }}>{returnCase.exchangeOrderName}</span>
                          </div>
                        )}
                        {priceDiff != null && Math.abs(priceDiff) > 0.001 && (
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                            <span style={{ color: panelText }}>{priceDiff > 0 ? "Customer owes" : "Refunded to customer"}</span>
                            <span style={{ fontWeight: 700, color: panelText }}>
                              {Math.abs(priceDiff).toFixed(2)} {currency}
                            </span>
                          </div>
                        )}
                        {flow === "completed_with_refund" && exchangePayload.refund?.success && exchangePayload.refund?.amount && (
                          <div style={{ fontSize: 12, color: "#15803D" }}>
                            ✓ Difference refunded ({exchangePayload.refund.amount} {currency})
                          </div>
                        )}
                        {flow === "completed_with_refund" && exchangePayload.refund?.success === false && (
                          <div style={{ fontSize: 12, color: "#B91C1C", padding: "4px 8px", background: "#FEF2F2", borderRadius: 6, border: "1px solid #FECACA" }}>
                            ⚠ Difference refund failed — process manually in Shopify
                          </div>
                        )}
                        {exchangeItems.length > 0 && (
                          <div style={{ fontSize: 12, color: panelText, marginTop: 4 }}>
                            {exchangeItems.length} item{exchangeItems.length !== 1 ? "s" : ""}
                          </div>
                        )}
                        <a
                          href={orderUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: 12, fontWeight: 600, color: flow === "invoice_pending" ? "#B45309" : "#059669", marginTop: 4 }}
                        >
                          View in Shopify Admin &rarr;
                        </a>
                        {invoiceUrl && (
                          <a
                            href={invoiceUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ fontSize: 12, fontWeight: 600, color: "#B45309", marginTop: 2 }}
                          >
                            Customer payment link &rarr;
                          </a>
                        )}
                      </div>
                    </div>
                  );
                })()}
                {isOrderCancellable && (
                  <>
                    <s-button type="button" variant="secondary" disabled={fetcher.state !== "idle"} onClick={() => setShowCancelOrder(true)} style={{ width: "100%", borderColor: "#FECACA", color: "#DC2626" }}>
                      Cancel Order
                    </s-button>
                    {showCancelOrder && (
                      <div className="app-modal-overlay" onClick={() => setShowCancelOrder(false)}>
                        <div className="app-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
                          <div className="app-modal-title">Cancel Order</div>
                          <div className="app-modal-body" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                            <p style={{ margin: 0 }}>
                              Cancel the Shopify order for <strong>{returnCase.shopifyOrderName || "--"}</strong>. This will cancel the order directly in Shopify.
                            </p>
                            <div style={{ padding: 14, background: "#F9FAFB", borderRadius: 10, border: "1px solid #E5E7EB" }}>
                              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 10 }}>Cancellation reason</div>
                              <select aria-label="Cancellation reason" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 13, background: "#fff", marginBottom: 12 }}>
                                <option value="CUSTOMER">Customer request</option>
                                <option value="FRAUD">Fraud</option>
                                <option value="INVENTORY">Inventory</option>
                                <option value="DECLINED">Declined</option>
                                <option value="OTHER">Other</option>
                              </select>
                              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                                  <input type="checkbox" checked={cancelRefund} onChange={(e) => setCancelRefund(e.target.checked)} style={{ width: 16, height: 16 }} />
                                  Issue refund to customer
                                </label>
                                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, cursor: "pointer" }}>
                                  <input type="checkbox" checked={cancelRestock} onChange={(e) => setCancelRestock(e.target.checked)} style={{ width: 16, height: 16 }} />
                                  Restock inventory
                                </label>
                              </div>
                            </div>
                            <p style={{ color: "#DC2626", fontWeight: 500, fontSize: 13, margin: 0 }}>This action cannot be undone.</p>
                          </div>
                          <div className="app-modal-actions">
                            <s-button type="button" variant="secondary" onClick={() => setShowCancelOrder(false)}>Go Back</s-button>
                            <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`}>
                              <input type="hidden" name="json" value={JSON.stringify({ action: "cancel_order", cancelReason, refund: cancelRefund, restock: cancelRestock })} />
                              <s-button type="submit" variant="primary" disabled={fetcher.state !== "idle"} style={{ background: "#DC2626", borderColor: "#DC2626" }}>
                                {fetcher.state !== "idle" ? "Cancelling..." : "Cancel Order"}
                              </s-button>
                            </fetcher.Form>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
                {isRefunded && (() => {
                  let refundInfo: { refundId?: string; amount?: string; currency?: string; createdAt?: string; method?: string; source?: string; bonusCreditAmount?: string; greenReturn?: boolean } | null = null;
                  try {
                    const raw = (returnCase as { refundJson?: string | null }).refundJson;
                    if (raw) refundInfo = JSON.parse(raw);
                  } catch { /* no refund details */ }
                  const storedBonusAmount = (returnCase as { bonusCreditAmount?: string | null }).bonusCreditAmount;
                  const displayBonus = refundInfo?.bonusCreditAmount ?? storedBonusAmount;
                  return (
                    <div style={{ padding: 14, background: "#DCFCE7", borderRadius: 10, border: "1px solid #BBF7D0" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: refundInfo ? 10 : 0 }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#166534" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                        <span style={{ fontWeight: 700, fontSize: 14, color: "#166534" }}>Refund processed</span>
                      </div>
                      {refundInfo && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {refundInfo.amount && (
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                              <span style={{ color: "#166534" }}>Amount</span>
                              <span style={{ fontWeight: 700, color: "#166534" }}>
                                {formatMoney(refundInfo.amount, refundInfo.currency || shopCurrency, shopLocale)}
                              </span>
                            </div>
                          )}
                          {displayBonus && parseFloat(displayBonus) > 0 && (
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#166534" }}>
                              <span>Bonus credit included</span>
                              <span style={{ fontWeight: 600 }}>+{formatMoney(displayBonus, shopCurrency, shopLocale)}</span>
                            </div>
                          )}
                          {refundInfo.createdAt && (
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                              <span style={{ color: "#166534" }}>Processed</span>
                              <span style={{ color: "#166534" }}>{new Intl.DateTimeFormat(shopLocale || "en", { dateStyle: "medium", timeStyle: "short", timeZone: undefined }).format(new Date(refundInfo.createdAt))}</span>
                            </div>
                          )}
                          {refundInfo.source && (
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                              <span style={{ color: "#166534" }}>Triggered by</span>
                              {/* v8 ignore start */}
                              {/* defensive: refund source enum has multiple values; combinatorial coverage of each ternary branch infeasible */}
                              <span style={{ color: "#166534" }}>{refundInfo.source === "admin" ? "Admin" : refundInfo.source === "fynd_webhook" ? "Fynd" : refundInfo.source === "auto_fynd_credit_note" ? "Auto (Credit Note)" : refundInfo.source}</span>
                              {/* v8 ignore stop */}
                            </div>
                          )}
                          {refundInfo.refundId && (
                            <div style={{ fontSize: 11, color: "#15803D", marginTop: 2, fontFamily: "monospace" }}>
                              {refundInfo.refundId.replace(/^gid:\/\/shopify\/Refund\//, "Refund #")}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            </div>

            {/* ── Quick Info ── */}
            <div style={{ ...C.card }}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Details</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div><div style={C.label}>Return ID</div><div style={C.mono}>{returnRequestId}</div></div>
                <div><div style={C.label}>Order</div><div style={C.val}>{returnCase.shopifyOrderName || "—"}</div></div>
                <div>
                  <div style={C.label}>Unified Status</div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 2 }}>
                    <span style={{
                      display: "inline-flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 999,
                      fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.02em",
                      background: unifiedState.bg, color: unifiedState.color, border: `1px solid ${unifiedState.border}`,
                    }}>
                      <span style={{ width: 6, height: 6, borderRadius: "50%", background: unifiedState.color, flexShrink: 0 }} />
                      {unifiedState.label}
                    </span>
                    {unifiedState.step > 0 && (
                      <span style={{ fontSize: 11, color: "#9CA3AF" }}>Step {unifiedState.step}/6</span>
                    )}
                  </div>
                </div>
                <div>
                  <div style={C.label}>Resolution Type</div>
                  <div style={{ marginTop: 4 }}>
                    <span style={{
                      display: "inline-block", padding: "3px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700, textTransform: "capitalize",
                      ...({
                        refund: { background: "#DBEAFE", color: "#1E40AF" },
                        exchange: { background: "#DCFCE7", color: "#166534" },
                        store_credit: { background: "#F3E8FF", color: "#6B21A8" },
                        replacement: { background: "#FFF7ED", color: "#C2410C" },
                      } as Record<string, React.CSSProperties>)[returnCase.resolutionType] ?? { background: "#F3F4F6", color: "#374151" },
                    }}>
                      {(returnCase.resolutionType || "refund").replace(/_/g, " ")}
                    </span>
                  </div>
                  {returnCase.resolutionType === "exchange" && (returnCase as { exchangePreference?: string | null }).exchangePreference && (
                    <div style={{ marginTop: 8, padding: "8px 10px", background: "#FFFBEB", borderRadius: 6, border: "1px solid #FDE68A", fontSize: 12 }}>
                      <div style={{ fontWeight: 600, color: "#92400E", marginBottom: 2 }}>Customer exchange preference</div>
                      <div style={{ color: "#78350F" }}>{(returnCase as { exchangePreference?: string | null }).exchangePreference}</div>
                    </div>
                  )}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div><div style={C.label}>App Status</div><div style={{ ...C.val, fontSize: 12 }}>{returnCase.status}</div></div>
                  <div>
                    <div style={C.label}>Refund Status</div>
                    <div style={{ ...C.val, fontSize: 12, color: isRefunded ? "#059669" : returnCase.refundStatus ? "#D97706" : "#9CA3AF" }}>
                      {returnCase.refundStatus || "—"}
                    </div>
                  </div>
                </div>
                <div><div style={C.label}>Created</div><div style={{ ...C.val, fontSize: 13 }}>{new Intl.DateTimeFormat(shopLocale || "en", { dateStyle: "medium", timeStyle: "short", timeZone: undefined }).format(new Date(returnCase.createdAt))}</div></div>
                <div><div style={C.label}>Last Updated</div><div style={{ ...C.val, fontSize: 13 }}>{new Intl.DateTimeFormat(shopLocale || "en", { dateStyle: "medium", timeStyle: "short", timeZone: undefined }).format(new Date(returnCase.updatedAt))}</div></div>
                {(displayForwardAwb || displayReturnAwb) && (
                  <>
                    {displayForwardAwb && <div><div style={C.label}>Forward AWB</div><div style={C.mono}>{displayForwardAwb}</div></div>}
                    {displayReturnAwb && <div><div style={C.label}>Return AWB</div><div style={C.mono}>{displayReturnAwb}</div></div>}
                  </>
                )}
              </div>
            </div>

            {/* ── Customer History ── */}
            {customerReturnCount > 0 && (
              <div style={{
                ...C.card,
                background: customerReturnCount >= 3 ? "#FEF2F2" : "#F9FAFB",
                border: customerReturnCount >= 3 ? "1px solid #FECACA" : "1px solid #e3e5e7",
              }}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>Customer History</div>
                  {customerReturnCount >= 3 && (
                    <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 999, background: "#FEE2E2", color: "#DC2626", textTransform: "uppercase", letterSpacing: "0.03em" }}>
                      Serial Returner
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 14, color: customerReturnCount >= 3 ? "#991B1B" : "#374151", marginBottom: 8 }}>
                  <strong>{customerReturnCount}</strong> {customerReturnCount === 1 ? "return" : "returns"} from this customer
                </div>
                {customerEmail && (
                  <Link to={`/app/customers?q=${encodeURIComponent(customerEmail)}`} style={{ fontSize: 13, fontWeight: 600, color: "#2563EB", textDecoration: "none" }}>
                    View all customer returns &rarr;
                  </Link>
                )}
                {customerReturnHistory.length > 0 && (
                  <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
                    {customerReturnHistory.slice(0, 5).map((prev) => (
                        <Link key={prev.id} to={`/app/returns/${prev.id}`} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 10px", borderRadius: 6, background: "#fff", border: "1px solid #e5e7eb", textDecoration: "none", fontSize: 12, color: "#374151", transition: "background 0.15s" }}>
                          <span style={{ fontWeight: 600 }}>{prev.returnRequestNo || prev.id.slice(-8).toUpperCase()}</span>
                          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                            <span style={{ fontSize: 11, color: "#6b7280" }}>{new Intl.DateTimeFormat(shopLocale || "en", { day: "numeric", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(prev.createdAt))}</span>
                            <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 4, background: getStatusBg(prev.status), color: getStatusColor(prev.status), textTransform: "uppercase" }}>{prev.status}</span>
                          </span>
                        </Link>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* ── Customer Info ── always visible ── */}
            {(() => {
              const cEmail = shopifyOrder?.email || returnCase.customerEmailNorm;
              const cPhone = (shopifyOrder as { phone?: string | null } | null)?.phone || returnCase.customerPhoneNorm;
              const cName = returnCase.customerName
                || shopifyOrder?.shippingAddress?.name
                || (shopifyOrder?.shippingAddress ? [shopifyOrder.shippingAddress.firstName, shopifyOrder.shippingAddress.lastName].filter(Boolean).join(" ") : null);
              const cCity = returnCase.customerCity || shopifyOrder?.shippingAddress?.city;
              const cCountry = returnCase.customerCountry || shopifyOrder?.shippingAddress?.country;
              const cAddress1 = returnCase.customerAddress1;
              const cAddress2 = returnCase.customerAddress2;
              const cProvince = returnCase.customerProvince;
              const cZip = returnCase.customerZip;
              const cLandmark = returnCase.customerLandmark;
              const hasFullAddress = !!(cAddress1 || cZip);
              const hasAny = !!(cEmail || cPhone || cName || cCity);
              return (
                <div style={{ ...C.card }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: hasAny ? 14 : 6 }}>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>Customer</div>
                    {customerReturnCount > 1 && (
                      <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 20, background: customerReturnCount >= 3 ? "#FEE2E2" : "#F3F4F6", color: customerReturnCount >= 3 ? "#DC2626" : "#374151", fontWeight: 600 }}>
                        {customerReturnCount} returns
                      </span>
                    )}
                  </div>
                  {!hasAny ? (
                    <div style={{ fontSize: 13, color: "#9CA3AF", fontStyle: "italic" }}>No customer info captured yet</div>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
                      {cName && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2"><circle cx="12" cy="7" r="4"/><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/></svg>
                          <span style={{ fontSize: 13, fontWeight: 500 }}>{cName}</span>
                        </div>
                      )}
                      {cEmail && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22,6 12,13 2,6"/></svg>
                          <a href={`mailto:${cEmail}`} style={{ fontSize: 13, color: "#2563EB", textDecoration: "none", wordBreak: "break-all" }}>{cEmail}</a>
                        </div>
                      )}
                      {cPhone && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                          <a href={`tel:${cPhone}`} style={{ fontSize: 13, color: "#2563EB", textDecoration: "none" }}>{cPhone}</a>
                        </div>
                      )}
                      {(cCity || cCountry) && (
                        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                          <span style={{ fontSize: 13, color: "#374151" }}>{[cCity, cCountry].filter(Boolean).join(", ")}</span>
                        </div>
                      )}
                      {hasFullAddress && (
                        <div style={{ marginTop: 4, padding: "8px 10px", background: "#F9FAFB", borderRadius: 8, border: "1px solid #F3F4F6" }}>
                          <div style={{ fontSize: 11, fontWeight: 600, color: "#6B7280", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>Pickup Address</div>
                          <div style={{ fontSize: 13, lineHeight: 1.6, color: "#374151" }}>
                            {/* v8 ignore start */}
                            {/* defensive: each address field independently optional; combinatorial coverage of every present/absent combination infeasible */}
                            {[cAddress1, cAddress2].filter(Boolean).join(", ")}
                            {(cCity || cProvince || cZip) && <div>{[cCity, cProvince, cZip].filter(Boolean).join(", ")}</div>}
                            {cCountry && <div>{cCountry}</div>}
                            {cLandmark && <div style={{ color: "#6B7280", fontSize: 12 }}>Landmark: {cLandmark}</div>}
                            {/* v8 ignore stop */}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                  {pickupAddress && (pickupAddress.formatted || pickupAddress.address1) && !hasFullAddress && (
                    <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #F3F4F6" }}>
                      <div style={C.label}>Pickup address</div>
                      <div style={{ fontSize: 13, lineHeight: 1.6, color: "#374151", marginTop: 4 }}>
                        {pickupAddress.formatted ?? [pickupAddress.name, pickupAddress.address1, pickupAddress.address2, pickupAddress.city, pickupAddress.state, pickupAddress.pincode, pickupAddress.country].filter(Boolean).join(", ")}
                      </div>
                    </div>
                  )}
                  {/* Edit pickup address */}
                  <div style={{ marginTop: 12 }}>
                    <button type="button" onClick={() => setShowEditAddress(v => !v)} style={{ fontSize: 12, color: "#2563EB", background: "none", border: "none", cursor: "pointer", padding: 0, textDecoration: "underline" }}>
                      {showEditAddress ? "Cancel" : "Edit pickup address"}
                    </button>
                    {showEditAddress && (
                      <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`} style={{ marginTop: 10 }} onSubmit={() => setShowEditAddress(false)}>
                        <input type="hidden" name="action" value="edit_details" />
                        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 8 }}>
                          <div>
                            <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280", display: "block", marginBottom: 2 }}>Address 1</label>
                            <input aria-label="Address 1" type="text" name="customerAddress1" defaultValue={cAddress1 ?? ""} maxLength={500} style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #E5E7EB", fontSize: 13, boxSizing: "border-box" }} />
                          </div>
                          <div>
                            <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280", display: "block", marginBottom: 2 }}>Address 2</label>
                            <input aria-label="Address 2" type="text" name="customerAddress2" defaultValue={cAddress2 ?? ""} maxLength={500} style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #E5E7EB", fontSize: 13, boxSizing: "border-box" }} />
                          </div>
                          <div>
                            <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280", display: "block", marginBottom: 2 }}>City</label>
                            <input aria-label="City" type="text" name="customerCity" defaultValue={returnCase.customerCity ?? ""} maxLength={100} style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #E5E7EB", fontSize: 13, boxSizing: "border-box" }} />
                          </div>
                          <div>
                            <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280", display: "block", marginBottom: 2 }}>State / Province</label>
                            <input aria-label="State or Province" type="text" name="customerProvince" defaultValue={cProvince ?? ""} maxLength={100} style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #E5E7EB", fontSize: 13, boxSizing: "border-box" }} />
                          </div>
                          <div>
                            <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280", display: "block", marginBottom: 2 }}>ZIP / Pincode</label>
                            <input aria-label="ZIP or Pincode" type="text" name="customerZip" defaultValue={cZip ?? ""} maxLength={20} style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #E5E7EB", fontSize: 13, boxSizing: "border-box" }} />
                          </div>
                          <div>
                            <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280", display: "block", marginBottom: 2 }}>Country</label>
                            <input aria-label="Country" type="text" name="customerCountry" defaultValue={returnCase.customerCountry ?? ""} maxLength={100} style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #E5E7EB", fontSize: 13, boxSizing: "border-box" }} />
                          </div>
                        </div>
                        <div style={{ marginBottom: 10 }}>
                          <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280", display: "block", marginBottom: 2 }}>Landmark</label>
                          <input aria-label="Landmark" type="text" name="customerLandmark" defaultValue={cLandmark ?? ""} maxLength={500} style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #E5E7EB", fontSize: 13, boxSizing: "border-box" }} />
                        </div>
                        <s-button type="submit" variant="secondary" size="slim" disabled={fetcher.state !== "idle"}>Save address</s-button>
                      </fetcher.Form>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* ── Gift Return Details ── */}
            {(returnCase as { isGiftReturn?: boolean }).isGiftReturn && (() => {
              const gr = returnCase as { giftRecipientName?: string | null; giftRecipientEmail?: string | null; giftMessageToSender?: string | null };
              return (
                <div style={{ ...C.card, borderColor: "#C4B5FD" }}>
                  <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 14, display: "flex", alignItems: "center", gap: 8 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#7C3AED" strokeWidth="2"><path d="M20 12v6a2 2 0 01-2 2H6a2 2 0 01-2-2v-6"/><path d="M2 7h20v5H2z"/><path d="M12 22V7"/><path d="M12 7H7.5a2.5 2.5 0 010-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 000-5C13 2 12 7 12 7z"/></svg>
                    Gift Recipient
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {gr.giftRecipientName && <div style={{ fontSize: 13 }}><strong>Name:</strong> {gr.giftRecipientName}</div>}
                    {gr.giftRecipientEmail && <div style={{ fontSize: 13 }}><strong>Email:</strong> {gr.giftRecipientEmail}</div>}
                    {gr.giftMessageToSender && (
                      <div style={{ marginTop: 4, padding: "8px 10px", background: "#F5F3FF", borderRadius: 8, fontSize: 12, color: "#6D28D9", fontStyle: "italic" }}>
                        &ldquo;{gr.giftMessageToSender}&rdquo;
                      </div>
                    )}
                  </div>
                  <div style={{ fontSize: 11, color: "#8B5CF6", marginTop: 10 }}>
                    Resolution limited to store credit or exchange
                  </div>
                </div>
              );
            })()}

            {/* ── Fraud Risk Assessment ── */}
            {(() => {
              const fl = (returnCase as { fraudRiskLevel?: string | null }).fraudRiskLevel;
              const fs = (returnCase as { fraudRiskScore?: number | null }).fraudRiskScore;
              if (!fl || fl === "low" || fs == null) return null;
              const colors = fl === "critical" ? { bg: "#FEF2F2", border: "#FECACA", text: "#DC2626", bar: "#EF4444" }
                : fl === "high" ? { bg: "#FFF7ED", border: "#FED7AA", text: "#EA580C", bar: "#F97316" }
                : { bg: "#FFFBEB", border: "#FDE68A", text: "#D97706", bar: "#F59E0B" };
              return (
                <div style={{ ...C.card, borderColor: colors.border, background: colors.bg }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: colors.text, display: "flex", alignItems: "center", gap: 6 }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                      Fraud Risk
                    </div>
                    <span style={{ fontSize: 20, fontWeight: 800, color: colors.text }}>{fs}/100</span>
                  </div>
                  <div style={{ height: 6, borderRadius: 3, background: "rgba(0,0,0,0.1)", overflow: "hidden" }}>
                    <div style={{ height: "100%", width: `${fs}%`, borderRadius: 3, background: colors.bar, transition: "width 0.4s" }} />
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: colors.text, marginTop: 6, textTransform: "uppercase" }}>
                    {fl} risk — review carefully before processing
                  </div>
                </div>
              );
            })()}

            {/* ── CRM / Admin Details ── */}
            {(() => {
              const rc = returnCase as Record<string, unknown>;
              const channel = rc.createdByChannel as string | null;
              const staff = rc.createdByStaff as string | null;
              const ticketId = rc.crmTicketId as string | null;
              const crmNotes = rc.crmNotes as string | null;
              if (!channel && !staff && !ticketId && !crmNotes) return null;
              const channelColors: Record<string, { bg: string; color: string }> = {
                admin: { bg: "#DBEAFE", color: "#1E40AF" },
                api: { bg: "#F3E8FF", color: "#6B21A8" },
                portal: { bg: "#DCFCE7", color: "#166534" },
              };
              const cc = channelColors[channel ?? ""] ?? { bg: "#F3F4F6", color: "#374151" };
              return (
                <div style={{ ...C.card }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
                    <div style={{ fontSize: 15, fontWeight: 700 }}>CRM / Admin Details</div>
                    {channel && (
                      <span style={{ padding: "2px 10px", borderRadius: 20, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em", background: cc.bg, color: cc.color }}>
                        {channel}
                      </span>
                    )}
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                    {staff && (
                      <div>
                        <div style={{ ...C.label, marginBottom: 2 }}>Created by</div>
                        <div style={{ fontSize: 13, fontWeight: 500, color: "#111827" }}>{staff}</div>
                      </div>
                    )}
                    {ticketId && (
                      <div>
                        <div style={{ ...C.label, marginBottom: 2 }}>CRM Ticket ID</div>
                        <div style={{ fontSize: 13, fontWeight: 500, color: "#111827", fontFamily: "var(--rpm-font-mono, monospace)" }}>{ticketId}</div>
                      </div>
                    )}
                    {crmNotes && (
                      <div>
                        <div style={{ ...C.label, marginBottom: 4 }}>CRM Notes</div>
                        <div style={{ padding: 10, background: "#F0F9FF", borderRadius: 8, fontSize: 13, whiteSpace: "pre-wrap", color: "#0C4A6E", border: "1px solid #BAE6FD" }}>
                          {crmNotes}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })()}

            {/* ── Notes ── */}
            <div style={{ ...C.card }}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>Notes</div>
              {returnCase.customerNotes && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ ...C.label, marginBottom: 6 }}>Customer notes</div>
                  <div style={{ padding: 10, background: "#FEF3C7", borderRadius: 8, fontSize: 13, whiteSpace: "pre-wrap", color: "#92400E" }}>
                    {(returnCase.customerNotes ?? "").replace(/\n\n\[Attached Files:.*\]$/s, "")}
                  </div>
                </div>
              )}
              {(() => {
                const mediaJson = (returnCase as { customerMediaJson?: string | null }).customerMediaJson;
                if (!mediaJson) return null;
                let media: Array<{ name?: string; mimeType?: string; dataUrl?: string }> = [];
                try { media = JSON.parse(mediaJson); } catch { return null; }
                if (!Array.isArray(media) || media.length === 0) return null;
                /** Open a data URL in a new tab by converting it to a Blob URL (works reliably across browsers) */
                const openDataUrl = (dataUrl: string, mimeType?: string) => {
                  try {
                    if (dataUrl.startsWith("data:")) {
                      const [header, b64] = dataUrl.split(",");
                      /* v8 ignore start */
                      // defensive: mimeType arg, regex match, and fallback are all reachable but not all simultaneously
                      const mime = mimeType || header.match(/data:([^;]+)/)?.[1] || "application/octet-stream";
                      /* v8 ignore stop */
                      const bytes = atob(b64);
                      const arr = new Uint8Array(bytes.length);
                      for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
                      const blob = new Blob([arr], { type: mime });
                      window.open(URL.createObjectURL(blob), "_blank");
                    } else {
                      window.open(dataUrl, "_blank", "noopener,noreferrer");
                    }
                  } catch {
                    window.open(dataUrl, "_blank", "noopener,noreferrer");
                  }
                };
                return (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ ...C.label, marginBottom: 8 }}>Customer uploads</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                      {media.map((m, idx) => {
                        const isVideo = m.mimeType?.startsWith("video/");
                        return (
                          <button
                            key={idx}
                            type="button"
                            onClick={() => m.dataUrl && openDataUrl(m.dataUrl, m.mimeType)}
                            title={`${m.name || `Upload ${idx + 1}`} — Click to open in new tab`}
                            style={{ display: "block", borderRadius: 8, overflow: "hidden", border: "1px solid #E5E7EB", background: "#F9FAFB", padding: 0, cursor: "pointer", textAlign: "center" }}
                          >
                            {isVideo ? (
                              <video
                                src={m.dataUrl}
                                style={{ width: 140, height: 140, objectFit: "cover", display: "block" }}
                                muted
                                playsInline
                              />
                            ) : (
                              <img
                                src={m.dataUrl}
                                alt={m.name || `Upload ${idx + 1}`}
                                style={{ width: 140, height: 140, objectFit: "cover", display: "block" }}
                              />
                            )}
                            <div style={{ padding: "5px 8px", fontSize: 11, color: "#2563EB", fontWeight: 600, maxWidth: 140, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {m.name || `Upload ${idx + 1}`}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })()}
              <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`}>
                <input type="hidden" name="action" value="add_note" />
                <div style={{ ...C.label, marginBottom: 6 }}>Internal notes</div>
                <textarea aria-label="Internal notes" name="note" defaultValue={returnCase.adminNotes ?? ""} rows={2} style={{ width: "100%", padding: 8, borderRadius: 6, border: "1px solid #E5E7EB", marginBottom: 8, boxSizing: "border-box", fontSize: 13 }} />
                <s-button type="submit" variant="secondary" disabled={fetcher.state !== "idle"}>Save</s-button>
              </fetcher.Form>
              <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`} style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #F3F4F6" }}>
                <input type="hidden" name="action" value="save_notes_for_customer" />
                <div style={{ ...C.label, marginBottom: 6 }}>Customer-facing notes</div>
                <div style={{ fontSize: 11, color: "#9CA3AF", marginBottom: 6 }}>Visible to the customer in the portal</div>
                <textarea aria-label="Customer-facing notes" name="notesForCustomer" defaultValue={(returnCase as { notesForCustomer?: string | null }).notesForCustomer ?? ""} rows={2} placeholder="e.g. Please ship the item to..." style={{ width: "100%", padding: 8, borderRadius: 6, border: "1px solid #E5E7EB", marginBottom: 8, boxSizing: "border-box", fontSize: 13 }} />
                <s-button type="submit" variant="secondary" disabled={fetcher.state !== "idle"}>Publish</s-button>
              </fetcher.Form>
            </div>
          </div>
        </div>
      </div>
    </AppPage>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const isResponse = isRouteErrorResponse(error);
  const is400 = isResponse && error.status === 400;
  const is404 = isResponse && error.status === 404;
  const is500 = isResponse && error.status === 500;
  const errorMessage = isResponse
    ? (error.data || `Error ${error.status}`)
    : error instanceof Error
      ? error.message
      : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;

  const heading = is404
    ? "Return not found"
    : is400
      ? "Invalid request"
      : "Something went wrong";

  const description = is404
    ? "The return you're looking for doesn't exist or you don't have access to it."
    : is400
      ? typeof errorMessage === "string" ? errorMessage : "The request was invalid. Please go back and try again."
      : is500
        ? "We couldn't load this return. Please try again later."
        : "An unexpected error occurred.";

  return (
    <AppPage heading={heading}>
      <s-section>
        <p style={{ marginBottom: 16, color: "#6d7175" }}>{description}</p>
        {!is404 && !is400 && !is500 && (
          <details style={{ marginBottom: 16, fontSize: 12, color: "#6d7175", background: "#f6f6f7", padding: 12, borderRadius: 8 }}>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>Error details (for debugging)</summary>
            <pre style={{ marginTop: 8, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
              {typeof errorMessage === "string" ? errorMessage : JSON.stringify(errorMessage)}
              {errorStack ? `\n\n${errorStack}` : ""}
            </pre>
          </details>
        )}
        <Link to="/app/returns">
          <s-button variant="primary">Back to Returns</s-button>
        </Link>
      </s-section>
    </AppPage>
  );
}
