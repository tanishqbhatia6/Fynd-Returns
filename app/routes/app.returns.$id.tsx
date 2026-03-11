import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useNavigate, useFetcher, useSearchParams, isRouteErrorResponse, useRouteError } from "react-router";
import React, { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getStatusColor, getStatusBg } from "../lib/status-colors";
import { fetchOrder, fetchOrderByOrderNumber, fetchOrderByFyndAffiliateId, fetchAllLocations, withRestCredentials } from "../lib/shopify-admin.server";
import { formatReturnRequestId } from "../lib/return-request-id";
import type { MailingAddressDisplay, ShopLocation } from "../lib/shopify-admin.server";
import { parseFyndPayloadForDisplay, parseFyndOrderDetailsForTab, getPickupAddressFromFyndPayload, extractFyndJourney, extractCustomerFromFyndPayload, extractShippingDetailsFromFyndPayload, extractAffiliateOrderIdFromFyndPayload, isLikelyFyndId } from "../lib/fynd-payload.server";
import type { FyndJourneyStep } from "../lib/fynd-payload.server";
import { isFyndPrivateUrl, signFyndUrl } from "../lib/fynd.server";

/** Ensure we never render objects (React error #31) - Fynd API sometimes returns objects instead of strings */
function safeStr(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    const s = o.name ?? o.title ?? o.display_name ?? o.code ?? o.id;
    return typeof s === "string" ? s : "";
  }
  return "";
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
  fyndStatus: string | null | undefined
): UnifiedReturnState {
  const s = (appStatus || "").toLowerCase();
  const r = (refundStatus || "").toLowerCase();
  const f = (fyndStatus || "").toLowerCase();
  const journey = returnJourney || [];

  const journeyHas = (keyword: string) =>
    journey.some((j) => (j.status || "").toLowerCase().replace(/\s+/g, "_").includes(keyword));

  const latestJs = journey.length > 0
    ? (journey[journey.length - 1].status || "").toLowerCase().replace(/\s+/g, "_")
    : "";

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

  if (r === "refunded" || (s === "completed" && r === "refunded")) return done("Refund Completed", 6, "Refund has been processed successfully");
  if (journeyHas("credit_note") || f.includes("credit_note")) {
    if (r === "in_progress") return processing("Refund Processing", 6, "Credit note generated, refund in progress");
    return processing("Refund Processing", 6, "Credit note generated, awaiting refund");
  }
  if (f.includes("refund") || r === "in_progress") return processing("Refund Processing", 6, "Refund is being processed");
  if (latestJs.includes("return_accepted") || journeyHas("return_accepted")) return ok("Return Accepted", 5, "Return received and accepted at warehouse");
  if (latestJs.includes("return_delivered") || latestJs.includes("delivery_done") || journeyHas("return_delivered") || journeyHas("delivery_done"))
    return ok("Return Received", 5, "Return package delivered to warehouse");
  if (latestJs.includes("out_for_delivery") || journeyHas("out_for_delivery")) return transit("Out for Delivery", 4, "Package out for delivery to warehouse");
  if (latestJs.includes("in_transit") || latestJs.includes("return_bag_in_transit") || journeyHas("in_transit") || journeyHas("return_bag_in_transit"))
    return transit("In Transit", 4, "Return package in transit to warehouse");
  if (latestJs.includes("bag_picked") || latestJs.includes("return_bag_picked") || journeyHas("bag_picked"))
    return transit("Picked Up", 3, "Return package picked up by courier");
  if (latestJs.includes("out_for_pickup") || latestJs.includes("dp_out_for_pickup") || journeyHas("out_for_pickup"))
    return pending("Courier En Route", 3, "Courier on the way for pickup");
  if (latestJs.includes("dp_assigned") || latestJs.includes("return_dp_assigned") || journeyHas("dp_assigned"))
    return pending("Pickup Scheduled", 3, "Courier assigned for pickup");
  if (latestJs.includes("return_initiated") || latestJs.includes("bag_confirmed") || journeyHas("return_initiated") || journeyHas("bag_confirmed"))
    return ok("Return Confirmed", 2, "Confirmed on Fynd logistics");
  if (s === "rejected") return error("Rejected", "Return request has been declined");
  if (s === "cancelled") return error("Cancelled", "Return has been cancelled");
  if (s === "completed") return done("Completed", 6, "Return completed");
  if (s === "approved") return ok("Approved", 2, "Return approved, awaiting logistics pickup");
  if (s === "pending" || s === "initiated") return pending("Awaiting Review", 1, "Return request submitted, pending review");
  return ({ label: appStatus || "Unknown", cls: "info", step: 1, description: "Return in progress", bg: "#F9FAFB", border: "#E5E7EB", color: "#6B7280", icon: "info" });
}

function humanizeFyndSku(raw: string | null | undefined): string {
  if (!raw || typeof raw !== "string") return raw || "Item";
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

type ShipmentPricing = {
  subtotal?: string;
  total?: string;
  currency?: string;
  discount?: string;
  deliveryCharges?: string;
  codAmount?: string;
  promotions?: string;
  coupon?: string;
};

type ShipmentForRow = {
  shipmentId: string;
  forwardShipmentId: string | null;
  cpName: string | null;
  forwardAwb: string | null;
  trackingUrl: string | null;
  invoiceNumber: string | null;
  invoiceId: string | null;
  invoiceUrl: string | null;
  fulfillmentStore: string | null;
  fulfillmentOptions: string | null;
  shipmentStatus: string | null;
  creditNoteId: string | null;
  journeyType: string | null;
  pricing?: ShipmentPricing;
  items: ShipmentItem[];
};

function ShipmentRow({ shipment: s, index, expanded, onToggle, safeStr, formatMoney, shopifyLineItems }: {
  shipment: ShipmentForRow;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  safeStr: (v: unknown) => string;
  formatMoney: (v: string | null | undefined) => string;
  shopifyLineItems?: Array<{ sku?: string | null; title?: string; price?: string | null; discountedPrice?: string | null; quantity: number; id?: string }>;
}) {
  const cardStyle = {
    padding: expanded ? 20 : "14px 20px",
    background: "var(--rpm-surface-elevated)",
    borderRadius: "var(--rpm-radius-lg)",
    border: "var(--rpm-border)",
    boxShadow: "var(--rpm-shadow-sm)",
    transition: "all 0.25s ease",
  };
  return (
    <div style={{ ...cardStyle }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16, flex: 1, minWidth: 0 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>Shipment {index + 1}</span>
          {s.forwardShipmentId && (
            <span style={{ fontSize: 12 }} title="Original delivery shipment">
              <span style={{ color: "#6d7175" }}>Forward:</span> <code style={{ fontFamily: "monospace", background: "var(--rpm-surface)", padding: "2px 6px", borderRadius: 4 }}>{s.forwardShipmentId}</code>
            </span>
          )}
          <span style={{ fontSize: 12 }} title="Return shipment">
            <span style={{ color: "#6d7175" }}>Return:</span> <code style={{ fontFamily: "monospace", background: "var(--rpm-surface)", padding: "2px 6px", borderRadius: 4 }}>{s.shipmentId}</code>
          </span>
          {safeStr(s.cpName) && <span style={{ fontSize: 13 }}>{safeStr(s.cpName)}</span>}
          {safeStr(s.forwardAwb) && <span style={{ fontFamily: "monospace", fontSize: 12 }}>AWB: {safeStr(s.forwardAwb)}</span>}
          {safeStr(s.shipmentStatus) && (
            <span style={{ fontSize: 12, padding: "4px 10px", borderRadius: 20, background: "var(--rpm-surface-hover)", color: "var(--rpm-text)", fontWeight: 500 }}>{safeStr(s.shipmentStatus)}</span>
          )}
        </div>
        <button type="button" onClick={onToggle} className="app-btn-text">
          {expanded ? "Hide details" : "View details"}
        </button>
      </div>
      {expanded && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid #e1e3e5" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12, marginBottom: 12 }}>
            {s.forwardShipmentId && (
              <div><div style={{ fontSize: 11, color: "#6d7175" }}>Forward Shipment ID</div><div style={{ fontFamily: "monospace", fontSize: 13 }}>{s.forwardShipmentId}</div></div>
            )}
            <div><div style={{ fontSize: 11, color: "#6d7175" }}>Return Shipment ID</div><div style={{ fontFamily: "monospace", fontSize: 13 }}>{s.shipmentId}</div></div>
            <div><div style={{ fontSize: 11, color: "#6d7175" }}>Logistics Partner</div><div style={{ fontSize: 13 }}>{safeStr(s.cpName) || "—"}</div></div>
            <div><div style={{ fontSize: 11, color: "#6d7175" }}>Forward AWB</div><div style={{ fontFamily: "monospace", fontSize: 13 }}>{safeStr(s.forwardAwb) || "—"}</div></div>
            <div><div style={{ fontSize: 11, color: "#6d7175" }}>Tracking</div><div style={{ fontSize: 13 }}>
              {s.trackingUrl ? <a href={s.trackingUrl} target="_blank" rel="noopener noreferrer" className="app-link" style={{ fontWeight: 600 }}>Track shipment →</a> : "—"}
            </div></div>
            <div><div style={{ fontSize: 11, color: "#6d7175" }}>Invoice</div><div style={{ fontSize: 13 }}>
              {(safeStr(s.invoiceNumber) || safeStr(s.invoiceId))
                ? (s.invoiceUrl
                  ? <a href={s.invoiceUrl} target="_blank" rel="noopener noreferrer" className="app-link" style={{ fontWeight: 500 }}>{safeStr(s.invoiceNumber) || safeStr(s.invoiceId)}</a>
                  : (safeStr(s.invoiceNumber) || safeStr(s.invoiceId)))
                : "—"}
            </div></div>
            <div><div style={{ fontSize: 11, color: "#6d7175" }}>Fulfilling store</div><div style={{ fontSize: 13 }}>{safeStr(s.fulfillmentStore) || "—"}</div></div>
            <div><div style={{ fontSize: 11, color: "#6d7175" }}>Fulfillment options</div><div style={{ fontSize: 13 }}>{safeStr(s.fulfillmentOptions) || "—"}</div></div>
            <div><div style={{ fontSize: 11, color: "#6d7175" }}>Status</div><div style={{ fontSize: 13 }}>{safeStr(s.shipmentStatus) || "—"}</div></div>
            {s.creditNoteId && s.journeyType === "return" && (
              <div><div style={{ fontSize: 11, color: "#6d7175" }}>Credit Note ID</div><div style={{ fontFamily: "monospace", fontSize: 13 }}>{s.creditNoteId}</div></div>
            )}
          </div>
          {s.pricing && (s.pricing.subtotal || s.pricing.total || s.pricing.discount || s.pricing.deliveryCharges || s.pricing.codAmount || s.pricing.promotions || s.pricing.coupon) && (
            <div style={{ marginBottom: 16, padding: 16, background: "var(--rpm-surface)", borderRadius: "var(--rpm-radius)", border: "var(--rpm-border)" }}>
              <div style={{ fontSize: 12, color: "var(--rpm-text-muted)", marginBottom: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Shipment pricing</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6, maxWidth: 320 }}>
                {s.pricing.subtotal && (
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                    <span style={{ color: "#6d7175" }}>Subtotal</span>
                    <span>{formatMoney(s.pricing.subtotal)}{s.pricing.currency ? ` ${s.pricing.currency}` : ""}</span>
                  </div>
                )}
                {s.pricing.discount && parseFloat(s.pricing.discount) !== 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "var(--rpm-success)" }}>
                    <span>Discount</span>
                    <span>−{formatMoney(s.pricing.discount)}</span>
                  </div>
                )}
                {s.pricing.promotions && parseFloat(s.pricing.promotions) !== 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#6d7175" }}>
                    <span>Promotions</span>
                    <span>−{formatMoney(s.pricing.promotions)}</span>
                  </div>
                )}
                {s.pricing.coupon && parseFloat(s.pricing.coupon) !== 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#6d7175" }}>
                    <span>Coupon</span>
                    <span>−{formatMoney(s.pricing.coupon)}</span>
                  </div>
                )}
                {s.pricing.deliveryCharges && parseFloat(s.pricing.deliveryCharges) !== 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#6d7175" }}>
                    <span>Delivery charges</span>
                    <span>{formatMoney(s.pricing.deliveryCharges)}</span>
                  </div>
                )}
                {s.pricing.codAmount && parseFloat(s.pricing.codAmount) !== 0 && (
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#6d7175" }}>
                    <span>COD amount</span>
                    <span>{formatMoney(s.pricing.codAmount)}</span>
                  </div>
                )}
                {s.pricing.total && (
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, fontWeight: 600, marginTop: 4, paddingTop: 8, borderTop: "1px solid #e1e3e5" }}>
                    <span>Total</span>
                    <span>{formatMoney(s.pricing.total)}{s.pricing.currency ? ` ${s.pricing.currency}` : ""}</span>
                  </div>
                )}
              </div>
            </div>
          )}
          {(s.items ?? []).length > 0 && (
            <div>
              <div style={{ fontSize: 12, color: "var(--rpm-text-muted)", marginBottom: 12, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>Items</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                {(s.items ?? []).map((it, i) => {
                  const matched = shopifyLineItems?.find((li) =>
                    (it.sku && li.sku && String(li.sku).toLowerCase() === String(it.sku).toLowerCase()) ||
                    (it.identifier && li.sku && String(li.sku).toLowerCase() === String(it.identifier).toLowerCase())
                  );
                  const title = safeStr(it.title) || matched?.title || safeStr(it.sku) || safeStr(it.identifier) || "Item";
                  const qty = it.quantity ?? 1;
                  const unitPrice = it.discountedPrice ?? it.price ?? it.markedPrice ?? matched?.discountedPrice ?? matched?.price;
                  const originalPrice = it.price ?? it.originalPrice ?? it.markedPrice ?? matched?.price;
                  const total = it.total ?? (unitPrice ? String(parseFloat(unitPrice) * qty) : null);
                  return (
                    <div key={i} style={{ padding: 16, background: "var(--rpm-surface)", borderRadius: "var(--rpm-radius-lg)", border: "var(--rpm-border)", transition: "box-shadow 0.2s ease", boxShadow: "var(--rpm-shadow-sm)" }}>
                      <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "flex-start", gap: 16 }}>
                        <div style={{ flex: 1, minWidth: 200 }}>
                          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8 }}>{title}</div>
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 16, fontSize: 12, color: "var(--rpm-text-muted)" }}>
                            {it.sku && <span><strong>SKU:</strong> <code style={{ background: "var(--rpm-surface-elevated)", padding: "2px 6px", borderRadius: 4, fontFamily: "monospace" }}>{safeStr(it.sku)}</code></span>}
                            {it.itemId && <span><strong>Item ID:</strong> <code style={{ background: "var(--rpm-surface-elevated)", padding: "2px 6px", borderRadius: 4, fontFamily: "monospace" }}>{safeStr(it.itemId)}</code></span>}
                            {it.affiliateLineNo && <span><strong>Affiliate line no:</strong> {safeStr(it.affiliateLineNo)}</span>}
                            <span><strong>Qty:</strong> {qty}</span>
                            {it.transferPrice && parseFloat(it.transferPrice) !== 0 && <span><strong>Transfer price:</strong> {formatMoney(it.transferPrice)}</span>}
                            {it.shippingCharges && parseFloat(it.shippingCharges) !== 0 && <span><strong>Shipping:</strong> {formatMoney(it.shippingCharges)}</span>}
                          </div>
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
                          {unitPrice && (
                            <div style={{ fontSize: 13 }}>
                              {formatMoney(unitPrice)} × {qty}
                              {originalPrice && parseFloat(originalPrice) !== parseFloat(unitPrice) && (
                                <span style={{ marginLeft: 8, color: "var(--rpm-text-muted)", textDecoration: "line-through", fontWeight: 400 }}>{formatMoney(originalPrice)} each</span>
                              )}
                            </div>
                          )}
                          {it.discount && parseFloat(it.discount) !== 0 && (
                            <div style={{ fontSize: 12, color: "var(--rpm-success)" }}>Discount: −{formatMoney(it.discount)}</div>
                          )}
                          {total && <div style={{ fontWeight: 700, fontSize: 14, color: "var(--rpm-text)" }}>Total: {formatMoney(total)}</div>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

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
  if (amount == null || amount === "") return "";
  const n = parseFloat(amount);
  if (isNaN(n)) return amount;
  try {
    if (currency) {
      return new Intl.NumberFormat(locale || "en", { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
    }
    return new Intl.NumberFormat(locale || undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
  } catch {
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
}

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  try {
    const id = params.id;
    if (!id) throw new Response("Return ID is required", { status: 400 });

    const { session, admin } = await authenticate.admin(request);
    const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
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
      const returnRequestNo = formatReturnRequestId(returnCase.id);
      try {
        await prisma.returnCase.update({
          where: { id: returnCase.id },
          data: { returnRequestNo },
        });
        returnCase = { ...returnCase, returnRequestNo };
      } catch {
        // Non-fatal
      }
    }

    const isManualReturn = returnCase.shopifyOrderId?.startsWith("manual:");
    let shopifyOrder: Awaited<ReturnType<typeof fetchOrder>> | Awaited<ReturnType<typeof fetchOrderByOrderNumber>> | null = null;
    const fyndPayloadJson = (returnCase as { fyndPayloadJson?: string | null }).fyndPayloadJson;
    // Attach REST credentials so order lookup can fall back to REST API (exact name match)
    const sessionAccessToken = session.accessToken ?? "";
    console.log(`[return-detail-loader] shopifyOrderId="${returnCase.shopifyOrderId}" shopifyOrderName="${returnCase.shopifyOrderName ?? ""}" hasAccessToken=${!!sessionAccessToken} shop="${session.shop}"`);
    const adminWithRest = withRestCredentials(admin, session.shop, sessionAccessToken);
    if (!isManualReturn && returnCase.shopifyOrderId) {
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
          console.log(`[return-detail-loader] Slow path candidates: [${[...candidates].join(", ")}]`);
          // Try each unique candidate with fetchOrderByFyndAffiliateId (stops on first hit)
          for (const candidate of candidates) {
            if (!candidate) continue;
            shopifyOrder = await fetchOrderByFyndAffiliateId(adminWithRest, candidate);
            if (shopifyOrder) {
              console.log(`[return-detail-loader] Resolved via candidate="${candidate}" → ${shopifyOrder.id}`);
              break;
            }
          }
          if (!shopifyOrder) {
            console.warn(`[return-detail-loader] Failed to resolve order from any candidate: [${[...candidates].join(", ")}]`);
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
    }

    // Part B: Auto-enrich customer info from Shopify order or Fynd payload
    // Enrich if ANY key customer field is missing (not just all)
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
      // Source 2: Fynd payload delivery_address (fill any still-missing fields)
      if (fyndPayloadJson) {
        const fyndCustomer = extractCustomerFromFyndPayload(fyndPayloadJson);
        if (fyndCustomer) {
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

    // Part C: Auto-populate shipping info from Fynd payload if not already set
    if (!returnCase.returnLabelJson && fyndPayloadJson) {
      const shippingInfo = extractShippingDetailsFromFyndPayload(fyndPayloadJson);
      if (shippingInfo && (shippingInfo.carrier || shippingInfo.trackingNumber || shippingInfo.invoiceUrl)) {
        const shippingUpdate: Record<string, string> = {};
        shippingUpdate.returnLabelJson = JSON.stringify({
          carrier: shippingInfo.carrier,
          trackingNumber: shippingInfo.trackingNumber,
          trackingUrl: shippingInfo.trackingUrl,
          labelUrl: shippingInfo.labelUrl,
          invoiceUrl: shippingInfo.invoiceUrl,
          invoiceNumber: shippingInfo.invoiceNumber,
          source: "fynd",
        });
        if (shippingInfo.trackingNumber && !isLikelyFyndId(shippingInfo.trackingNumber) && !(returnCase as { forwardAwb?: string }).forwardAwb) {
          shippingUpdate.forwardAwb = shippingInfo.trackingNumber;
        }
        try {
          await prisma.returnCase.update({ where: { id: returnCase.id }, data: shippingUpdate });
          returnCase = { ...returnCase, ...shippingUpdate } as typeof returnCase;
        } catch {
          // Non-fatal
        }
      }
    }

    const fyndPayloadInfo = parseFyndPayloadForDisplay(fyndPayloadJson);
    const fyndOrderDetailsTab = parseFyndOrderDetailsForTab(fyndPayloadJson);
    const pickupAddress = getPickupAddressFromFyndPayload(fyndPayloadJson);
    const returnJourney = extractFyndJourney(fyndPayloadJson, "return");

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

    // Customer return history — fetch other returns by same email (excluding current)
    let customerReturnHistory: Array<{ id: string; returnRequestNo: string | null; status: string; createdAt: Date }> = [];
    if (returnCase.customerEmailNorm) {
      customerReturnHistory = await prisma.returnCase.findMany({
        where: {
          shopId: shop.id,
          customerEmailNorm: returnCase.customerEmailNorm,
          id: { not: returnCase.id },
        },
        select: { id: true, returnRequestNo: true, status: true, createdAt: true },
        orderBy: { createdAt: "desc" },
        take: 10,
      });
    }

    const COD_PATTERNS = /cash.on.delivery|cod|manual|money.order|bank.deposit|bank.transfer/i;
    const isCodOrder = (shopifyOrder?.paymentGatewayNames ?? []).some((g) => COD_PATTERNS.test(g))
      || shopifyOrder?.displayFinancialStatus === "PENDING";

    // Return label info — with Fynd signed URL refresh for private storage URLs
    let returnLabelInfo: { carrier?: string | null; trackingNumber?: string | null; labelUrl?: string | null; qrCodeUrl?: string | null; signedLabelUrl?: string | null; signedAt?: number | null; signedInvoiceUrl?: string | null } | null = null;
    try {
      if (returnCase.returnLabelJson) returnLabelInfo = JSON.parse(returnCase.returnLabelJson);
    } catch { /* ignore */ }

    // Sign Fynd private URLs (labels, invoices) if needed — expire after 50 min
    if (returnLabelInfo) {
      const SIGN_TTL_MS = 50 * 60 * 1000; // refresh if older than 50 min
      const needsSign = (url: string | null | undefined, signedAt: number | null | undefined) =>
        isFyndPrivateUrl(url) && (!signedAt || Date.now() - signedAt > SIGN_TTL_MS);

      const rawLabel = (returnLabelInfo as Record<string, unknown>).labelUrl as string | null;
      const rawInvoice = (returnLabelInfo as Record<string, unknown>).invoiceUrl as string | null;
      const labelNeedsSign = needsSign(rawLabel, returnLabelInfo.signedAt);
      const invoiceNeedsSign = needsSign(rawInvoice, (returnLabelInfo as Record<string, unknown>).signedInvoiceAt as number | null);

      if (labelNeedsSign || invoiceNeedsSign) {
        try {
          const fyndSettings = await prisma.shopSettings.findUnique({ where: { shopId: shop.id } });
          if (fyndSettings) {
            const settings = {
              fyndEnvironment: (fyndSettings as Record<string, unknown>).fyndEnvironment as string | null,
              fyndCustomBaseUrl: (fyndSettings as Record<string, unknown>).fyndCustomBaseUrl as string | null,
              fyndCompanyId: fyndSettings.fyndCompanyId ?? null,
              fyndApplicationId: fyndSettings.fyndApplicationId ?? null,
              fyndCredentials: fyndSettings.fyndCredentials ?? null,
            };
            let updated = false;
            if (labelNeedsSign && rawLabel) {
              const result = await signFyndUrl(settings, rawLabel);
              if (result) {
                returnLabelInfo.signedLabelUrl = result.signedUrl;
                returnLabelInfo.signedAt = Date.now();
                updated = true;
              }
            }
            if (invoiceNeedsSign && rawInvoice) {
              const result = await signFyndUrl(settings, rawInvoice);
              if (result) {
                (returnLabelInfo as Record<string, unknown>).signedInvoiceUrl = result.signedUrl;
                (returnLabelInfo as Record<string, unknown>).signedInvoiceAt = Date.now();
                updated = true;
              }
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
    }

    // Default return instructions from settings
    let defaultReturnInstructions: string | null = null;
    try {
      const shopSettings = await prisma.shopSettings.findUnique({ where: { shopId: shop.id } });
      defaultReturnInstructions = (shopSettings as { defaultReturnInstructions?: string | null } | null)?.defaultReturnInstructions ?? null;
    } catch { /* ignore */ }

    // Customer return history count
    const customerEmail = returnCase.customerEmailNorm || shopifyOrder?.email;
    let customerReturnCount = 0;
    if (customerEmail) {
      customerReturnCount = await prisma.returnCase.count({
        where: { shopId: shop.id, customerEmailNorm: { equals: customerEmail, mode: "insensitive" } },
      });
    }

    // Blocklist flag
    let isBlocklisted = false;
    try {
      const blSettings = await prisma.shopSettings.findUnique({ where: { shopId: shop.id } });
      if (blSettings) {
        const blChecks: { type: string; value: string }[] = [];
        if (customerEmail) blChecks.push({ type: "email", value: customerEmail.toLowerCase() });
        if (returnCase.customerPhoneNorm) blChecks.push({ type: "phone", value: returnCase.customerPhoneNorm });
        if (blChecks.length > 0) {
          const blocked = await prisma.blocklistEntry.findFirst({
            where: { settingsId: blSettings.id, OR: blChecks.map((c) => ({ type: c.type, value: c.value })) },
          });
          if (blocked) isBlocklisted = true;
        }
      }
    } catch { /* non-fatal */ }

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
  } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showRawFynd, setShowRawFynd] = useState(false);
  const [expandedShipment, setExpandedShipment] = useState<number | null>(null);
  const fetcher = useFetcher<{ success?: boolean; error?: string; status?: string }>();
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [showApproveModal, setShowApproveModal] = useState(false);
  const [selectedResolutionType, setSelectedResolutionType] = useState<string>("refund");
  const [showExchangeConfirm, setShowExchangeConfirm] = useState(false);
  const [showEditAddress, setShowEditAddress] = useState(false);
  const [showRefundConfirm, setShowRefundConfirm] = useState(false);
  const [showCancelOrder, setShowCancelOrder] = useState(false);
  const [cancelReason, setCancelReason] = useState("OTHER");
  const [cancelRefund, setCancelRefund] = useState(true);
  const [cancelRestock, setCancelRestock] = useState(true);
  const [selectedLocationId, setSelectedLocationId] = useState<string>(fulfillmentLocationId ?? shopLocations[0]?.id ?? "");
  const defaultRefundMethod = isCodOrder
    ? "store_credit" as const
    : (["original", "store_credit", "both", "discount_code"].includes(refundPaymentMethod) ? refundPaymentMethod : "original") as "original" | "store_credit" | "both" | "discount_code";
  const [modalRefundMethod, setModalRefundMethod] = useState<"original" | "store_credit" | "both" | "discount_code">(defaultRefundMethod);
  const [modalStoreCreditPct, setModalStoreCreditPct] = useState(refundStoreCreditPct ?? 100);
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

  const canRetryFynd = !isManualReturn
    && ["approved", "completed"].includes(returnCase.status.toLowerCase())
    && !returnCase.fyndReturnId;

  const returnRequestId = (returnCase as { returnRequestNo?: string | null }).returnRequestNo ?? formatReturnRequestId(returnCase.id);
  const statusLower = returnCase.status.toLowerCase();
  const isPending = statusLower === "pending" || statusLower === "initiated";
  const isApproved = statusLower === "approved";
  const isRejected = statusLower === "rejected";
  const isCompleted = statusLower === "completed";
  const isRefunded = returnCase.refundStatus === "refunded";
  const isGreenReturn = returnCase.isGreenReturn === true;
  const fulfillmentStatusUpper = (shopifyOrder?.displayFulfillmentStatus ?? "").toUpperCase();
  const isOrderCancellable = !isManualReturn
    && !isRefunded
    && statusLower !== "cancelled"
    && ["UNFULFILLED", "", "SCHEDULED", "ON_HOLD"].includes(fulfillmentStatusUpper);
  const fyndSyncStatus = (returnCase as { fyndSyncStatus?: string | null }).fyndSyncStatus;
  const fyndSyncRetries = (returnCase as { fyndSyncRetries?: number }).fyndSyncRetries ?? 0;
  const fyndSyncError = (returnCase as { fyndSyncError?: string | null }).fyndSyncError;

  // Auto-refresh when Fynd is actively assigning logistics — polls once after 12s
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (fyndSyncStatus !== "processing") return;
    const t = setTimeout(() => {
      navigate(0);
    }, 12000);
    return () => clearTimeout(t);
  }, [fyndSyncStatus, navigate]);

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

  const fyndTrackingStatus = fyndPayloadInfo?.shipments?.[0]
    ? safeStr((fyndPayloadInfo.shipments[0] as { shipmentStatus?: string }).shipmentStatus)
    : null;
  const unifiedState = computeAdminReturnState(
    returnCase.status,
    returnCase.refundStatus,
    (returnJourney ?? []) as FyndJourneyStep[],
    fyndTrackingStatus
  );
  const statusConfig = {
    bg: unifiedState.bg,
    border: unifiedState.border,
    color: unifiedState.color,
    icon: unifiedState.icon,
    text: unifiedState.label,
  };

  const hasShipments = (fyndOrderDetailsTab?.shipments?.length ?? 0) > 0;
  const firstShipment = fyndOrderDetailsTab?.shipments?.[0];
  const awb = returnCase.forwardAwb || (firstShipment as { forwardAwb?: string | null })?.forwardAwb;
  const courier = firstShipment ? safeStr((firstShipment as { cpName?: string }).cpName) : "";
  const trackingUrl = firstShipment ? (firstShipment as { trackingUrl?: string | null }).trackingUrl : null;

  return (
    <s-page heading={`Return ${returnRequestId}`}>
      <div className="app-content">
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
              {(() => { try { const d = decodeURIComponent(fyndError); return d === "[object Response]" || d === "[object Object]" ? "Request failed. Check Fynd configuration." : d; } catch { return fyndError; } })()}
            </span>
          </div>
        )}
        {fyndSuccess && <div className="app-alert app-alert-success" style={{ marginBottom: 16 }}>{fyndSuccess === "already_synced" ? "Already synced to Fynd." : fyndSuccess === "already_exists" ? "Return already exists on Fynd — details loaded." : "Synced to Fynd successfully."}</div>}
        {fyndRefresh && <div className="app-alert app-alert-success" style={{ marginBottom: 16 }}>Fynd details refreshed.</div>}
        {(fyndProcessing || fyndSyncStatus === "processing") && (
          <div style={{ marginBottom: 16, padding: "14px 18px", background: "#EFF6FF", border: "1px solid #BFDBFE", borderLeft: "4px solid #2563EB", borderRadius: 8, display: "flex", alignItems: "center", gap: 12 }}>
            <svg style={{ flexShrink: 0, animation: "spin 1s linear infinite" }} width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#2563EB" strokeWidth="2.5" strokeLinecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
            <div>
              <div style={{ fontWeight: 600, color: "#1D4ED8", fontSize: 14 }}>Fynd is assigning logistics</div>
              <div style={{ fontSize: 12, color: "#3B82F6", marginTop: 2 }}>AWB and courier assignment typically take 10–30 seconds. This page will refresh automatically.</div>
            </div>
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
                    title={returnDeadline ? `Return window expires ${new Intl.DateTimeFormat(shopLocale || "en", { dateStyle: "medium", timeZone: undefined }).format(new Date(returnDeadline))}` : undefined}
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
              return_bag_picked: 2, bag_picked: 2,
              return_bag_in_transit: 3, in_transit: 3,
              out_for_delivery_to_store: 3, out_for_delivery: 3,
              return_delivered: 4, delivery_done: 4, return_bag_delivered: 4,
              return_accepted: 4,
              credit_note_generated: 5, credit_note: 5, refund_initiated: 5,
              refund_done: 5, refunded: 5,
            };

            const progressSteps = [
              { num: 1, label: "Submitted", time: null as string | null },
              { num: 2, label: "Approved", time: null as string | null },
              { num: 3, label: "Picked Up", time: null as string | null },
              { num: 4, label: "In Transit", time: null as string | null },
              { num: 5, label: "Received", time: null as string | null },
              { num: 6, label: "Refunded", time: null as string | null },
            ];

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
                            {new Intl.DateTimeFormat(shopLocale || "en", { day: "numeric", month: "short", timeZone: undefined }).format(new Date(step.time))}
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
        <div style={{ display: "grid", gridTemplateColumns: "1fr 340px", gap: 20, alignItems: "start" }}>
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
                    const shopifyItem = (shopifyOrder?.lineItems ?? []).find((li) =>
                      li.id === item.shopifyLineItemId ||
                      (li.sku && item.sku && li.sku.toLowerCase() === item.sku.toLowerCase())
                    );
                    const rawTitle = (item as { title?: string | null }).title || shopifyItem?.title || item.notes || item.sku || item.shopifyLineItemId || "Item";
                    const title = humanizeFyndSku(rawTitle);
                    const variant = (item as { variantTitle?: string | null }).variantTitle || shopifyItem?.variantTitle;
                    const imageUrl = (item as { imageUrl?: string | null }).imageUrl || shopifyItem?.imageUrl;
                    const price = (item as { price?: string | null }).price || (shopifyItem?.discountedPrice ?? shopifyItem?.price);
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
                          </div>
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
                  <div><div style={C.label}>Placed</div><div style={C.val}>{shopifyOrder.createdAt ? new Intl.DateTimeFormat(shopLocale || "en", { dateStyle: "medium", timeZone: undefined }).format(new Date(shopifyOrder.createdAt)) : "—"}</div></div>
                  {shopifyOrder.email && <div><div style={C.label}>Email</div><div style={C.val}>{shopifyOrder.email}</div></div>}
                  {shopifyOrder.phone && <div><div style={C.label}>Phone</div><div style={C.val}>{shopifyOrder.phone}</div></div>}
                  {shopifyOrder.displayFulfillmentStatus && <div><div style={C.label}>Fulfillment</div><div style={C.val}>{shopifyOrder.displayFulfillmentStatus.replace(/_/g, " ")}</div></div>}
                  {shopifyOrder.displayFinancialStatus && <div><div style={C.label}>Payment</div><div style={C.val}>{shopifyOrder.displayFinancialStatus.replace(/_/g, " ")}</div></div>}
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
                  </div>
                )}
              </div>
            )}

            {/* ── Fynd Shipments ── */}
            {!isManualReturn && (
              <div style={{ ...C.card }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>Logistics (Fynd)</div>
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
                {/* Fynd sync status indicator */}
                {fyndSyncStatus && fyndSyncStatus !== "synced" && (
                  <div style={{
                    padding: "12px 14px", borderRadius: 8, marginBottom: 16, fontSize: 13,
                    background: fyndSyncStatus === "failed" ? "#FEF2F2" : fyndSyncStatus === "processing" ? "#EFF6FF" : "#FFFBEB",
                    border: `1px solid ${fyndSyncStatus === "failed" ? "#FECACA" : fyndSyncStatus === "processing" ? "#BFDBFE" : "#FDE68A"}`,
                    color: fyndSyncStatus === "failed" ? "#991B1B" : fyndSyncStatus === "processing" ? "#1D4ED8" : "#92400E",
                    display: "flex", alignItems: "flex-start", gap: 10,
                  }}>
                    {fyndSyncStatus === "processing" && (
                      <svg style={{ flexShrink: 0, marginTop: 1, animation: "spin 1s linear infinite" }} width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg>
                    )}
                    <div style={{ flex: 1 }}>
                      {fyndSyncStatus === "failed" && <strong>Sync failed after {fyndSyncRetries} attempts. </strong>}
                      {fyndSyncStatus === "retry_scheduled" && <span>Retry #{fyndSyncRetries + 1} scheduled. </span>}
                      {fyndSyncStatus === "pending" && <span>Queued for Fynd sync. </span>}
                      {fyndSyncStatus === "processing" && <strong>Fynd is processing — logistics assignment in progress. </strong>}
                      {fyndSyncError && <span style={{ opacity: 0.85 }}>{fyndSyncError.slice(0, 250)}</span>}
                      {fyndSyncStatus === "failed" && (
                        <div style={{ marginTop: 8 }}>
                          <span style={{ fontSize: 12, opacity: 0.75 }}>Process the refund manually or retry Fynd sync using the button above.</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
                {/* Quick tracking info */}
                {(awb || courier || trackingUrl) && (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 12, marginBottom: 16, padding: 14, background: "#F9FAFB", borderRadius: 10, border: "1px solid #F3F4F6" }}>
                    {courier && <div><div style={C.label}>Courier</div><div style={C.val}>{courier}</div></div>}
                    {awb && <div><div style={C.label}>AWB / Tracking No.</div><div style={C.mono}>{awb}</div></div>}
                    {trackingUrl && (
                      <div><div style={C.label}>Track</div><a href={trackingUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, fontWeight: 600, color: "#2563EB" }}>Track shipment &rarr;</a></div>
                    )}
                  </div>
                )}
                {/* Fynd IDs */}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 12, marginBottom: hasShipments ? 16 : 0 }}>
                  <div><div style={C.label}>Fynd Order ID</div><div style={C.mono}>{fyndOrderDetailsTab?.fyndOrderId || (returnCase as { fyndOrderId?: string | null }).fyndOrderId || (returnCase.shopifyOrderName ?? "").replace(/^#/, "") || "—"}</div></div>
                  {(returnCase as { fyndShipmentId?: string | null }).fyndShipmentId && <div><div style={C.label}>Shipment ID</div><div style={C.mono}>{(returnCase as { fyndShipmentId?: string | null }).fyndShipmentId}</div></div>}
                  {(returnCase as { fyndReturnNo?: string | null }).fyndReturnNo && <div><div style={C.label}>Fynd Return #</div><div style={C.mono}>{(returnCase as { fyndReturnNo?: string | null }).fyndReturnNo}</div></div>}
                </div>
                {/* Shipment details (expandable) */}
                {hasShipments ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {(fyndOrderDetailsTab?.shipments ?? []).map((s, idx) => (
                      <ShipmentRow key={idx} shipment={s} index={idx} expanded={expandedShipment === idx} onToggle={() => setExpandedShipment(expandedShipment === idx ? null : idx)} safeStr={safeStr} formatMoney={(v) => formatMoney(v, shopCurrency, shopLocale)} shopifyLineItems={shopifyOrder?.lineItems} />
                    ))}
                  </div>
                ) : (
                  <div style={{ padding: 20, textAlign: "center", color: "#9CA3AF", fontSize: 14, background: "#F9FAFB", borderRadius: 10 }}>
                    No shipment data yet. Click Refresh to fetch from Fynd.
                  </div>
                )}
                {(fyndPayloadInfo?.shipments?.length ?? 0) > 0 && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: "1px solid #F3F4F6" }}>
                    <button type="button" onClick={() => setShowRawFynd((v) => !v)} className="app-btn-text" style={{ fontSize: 12 }}>
                      {showRawFynd ? "Hide raw payload" : "View raw payload"}
                    </button>
                    {showRawFynd && (
                      <pre style={{ marginTop: 8, padding: 12, background: "#F3F4F6", borderRadius: 8, overflow: "auto", fontSize: 11, maxHeight: 300, border: "1px solid #E5E7EB" }}>{fyndPayloadInfo?.rawJson}</pre>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* ── Return Shipping ── */}
            {(isApproved || isCompleted) && (() => {
              const hasLabel = returnLabelInfo && (returnLabelInfo.carrier || returnLabelInfo.trackingNumber || returnLabelInfo.labelUrl);
              return (
                <div style={{ ...C.card }}>
                  <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Return Shipping</div>
                  {/* Tracking link if available */}
                  {(returnLabelInfo as { trackingUrl?: string })?.trackingUrl && (
                    <div style={{ marginBottom: 14, padding: "10px 14px", background: "#F0FDF4", borderRadius: 8, border: "1px solid #BBF7D0", display: "flex", alignItems: "center", gap: 8 }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
                      <a href={(returnLabelInfo as { trackingUrl?: string }).trackingUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 13, fontWeight: 600, color: "#059669", textDecoration: "none" }}>
                        Track Shipment &rarr;
                      </a>
                    </div>
                  )}
                  {defaultReturnInstructions && (
                    <div style={{ marginBottom: 16, padding: 14, background: "#EFF6FF", borderRadius: 10, border: "1px solid #BFDBFE" }}>
                      <div style={C.label}>Return Instructions</div>
                      <div style={{ fontSize: 13, color: "#1E40AF", whiteSpace: "pre-wrap", marginTop: 4 }}>{defaultReturnInstructions}</div>
                    </div>
                  )}
                  <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`}>
                    <input type="hidden" name="json" value={JSON.stringify({
                      action: "update_label",
                      carrier: returnLabelInfo?.carrier ?? "",
                      trackingNumber: returnLabelInfo?.trackingNumber ?? "",
                      labelUrl: returnLabelInfo?.labelUrl ?? "",
                      qrCodeUrl: returnLabelInfo?.qrCodeUrl ?? "",
                    })} />
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 12 }}>
                      <div className="app-field">
                        <label style={{ fontSize: 12, fontWeight: 600 }}>Carrier name</label>
                        <input type="text" name="carrier" defaultValue={returnLabelInfo?.carrier ?? ""} placeholder="e.g. FedEx, UPS" className="app-input" style={{ fontSize: 13 }}
                          onChange={(e) => {
                            const form = e.target.closest("form");
                            if (form) {
                              const hidden = form.querySelector('input[name="json"]') as HTMLInputElement;
                              if (hidden) {
                                const val = JSON.parse(hidden.value);
                                val.carrier = e.target.value;
                                hidden.value = JSON.stringify(val);
                              }
                            }
                          }}
                        />
                      </div>
                      <div className="app-field">
                        <label style={{ fontSize: 12, fontWeight: 600 }}>Tracking number</label>
                        <input type="text" name="trackingNumber" defaultValue={returnLabelInfo?.trackingNumber ?? ""} placeholder="Tracking number" className="app-input" style={{ fontSize: 13 }}
                          onChange={(e) => {
                            const form = e.target.closest("form");
                            if (form) {
                              const hidden = form.querySelector('input[name="json"]') as HTMLInputElement;
                              if (hidden) {
                                const val = JSON.parse(hidden.value);
                                val.trackingNumber = e.target.value;
                                hidden.value = JSON.stringify(val);
                              }
                            }
                          }}
                        />
                      </div>
                    </div>
                    <div className="app-field" style={{ marginBottom: 12 }}>
                      <label style={{ fontSize: 12, fontWeight: 600 }}>Label URL</label>
                      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                        <input type="url" name="labelUrl" defaultValue={returnLabelInfo?.labelUrl ?? ""} placeholder="https://..." className="app-input" style={{ fontSize: 13, flex: 1 }}
                          onChange={(e) => {
                            const form = e.target.closest("form");
                            if (form) {
                              const hidden = form.querySelector('input[name="json"]') as HTMLInputElement;
                              if (hidden) {
                                const val = JSON.parse(hidden.value);
                                val.labelUrl = e.target.value;
                                hidden.value = JSON.stringify(val);
                              }
                            }
                          }}
                        />
                        {returnLabelInfo?.labelUrl && (
                          <a href={returnLabelInfo.signedLabelUrl || returnLabelInfo.labelUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, fontWeight: 600, color: "#2563EB", whiteSpace: "nowrap", textDecoration: "none" }}>
                            View &rarr;
                          </a>
                        )}
                      </div>
                    </div>
                    {returnLabelInfo?.qrCodeUrl && (
                      <div style={{ marginBottom: 12 }}>
                        <a href={returnLabelInfo.qrCodeUrl} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, fontWeight: 600, color: "#2563EB", textDecoration: "none" }}>
                          View QR Code &rarr;
                        </a>
                      </div>
                    )}
                    <s-button type="submit" variant="secondary" disabled={fetcher.state !== "idle"}>Save Label Info</s-button>
                  </fetcher.Form>
                  <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #F3F4F6" }}>
                    <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`}>
                      <input type="hidden" name="json" value={JSON.stringify({ action: "update_instructions", returnInstructions: defaultReturnInstructions ?? "" })} />
                      <div className="app-field" style={{ marginBottom: 8 }}>
                        <label style={{ fontSize: 12, fontWeight: 600 }}>Return instructions</label>
                        <div style={{ fontSize: 11, color: "#9CA3AF", marginBottom: 4 }}>Default instructions shown to customer after return is approved</div>
                        <textarea name="returnInstructions" defaultValue={defaultReturnInstructions ?? ""} rows={3} placeholder="e.g. Pack items securely and drop off at..." style={{ width: "100%", padding: 8, borderRadius: 6, border: "1px solid #E5E7EB", boxSizing: "border-box", fontSize: 13 }}
                          onChange={(e) => {
                            const form = e.target.closest("form");
                            if (form) {
                              const hidden = form.querySelector('input[name="json"]') as HTMLInputElement;
                              if (hidden) {
                                const val = JSON.parse(hidden.value);
                                val.returnInstructions = e.target.value;
                                hidden.value = JSON.stringify(val);
                              }
                            }
                          }}
                        />
                      </div>
                      <s-button type="submit" variant="secondary" disabled={fetcher.state !== "idle"}>Save Instructions</s-button>
                    </fetcher.Form>
                  </div>
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
                    return (
                      <div key={ev.id} style={{ position: "relative", paddingBottom: i < returnCase.events.length - 1 ? 20 : 0 }}>
                        <div style={{ position: "absolute", left: -22, top: 2, width: 12, height: 12, borderRadius: "50%", background: isLatest ? sourceColor : "#D1D5DB", border: "2px solid #fff", boxShadow: isLatest ? `0 0 0 3px ${sourceColor}30` : "none" }} />
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 14, color: "#1F2937" }}>
                            {(ev.eventType || "unknown").replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase())}
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, flexWrap: "wrap" }}>
                            <span style={{ fontSize: 11, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: `${sourceColor}15`, color: sourceColor }}>{sourceLabel}</span>
                            <span style={{ fontSize: 12, color: "#9CA3AF" }}>{ev.happenedAt ? new Intl.DateTimeFormat(shopLocale || "en", { dateStyle: "medium", timeStyle: "short", timeZone: undefined }).format(new Date(ev.happenedAt)) : "—"}</span>
                            {ev.source === "admin" && evAdminEmail && (
                              <span style={{ fontSize: 11, color: "#6B7280" }}>by {evAdminEmail}</span>
                            )}
                          </div>
                          {ev.payloadJson && (
                            <details style={{ marginTop: 6 }}>
                              <summary style={{ fontSize: 11, color: "#9CA3AF", cursor: "pointer", userSelect: "none" }}>Show details</summary>
                              <pre style={{ marginTop: 4, padding: "6px 8px", background: "#F8FAFC", border: "1px solid #E2E8F0", borderRadius: 6, fontSize: 11, color: "#475569", overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", maxHeight: 200 }}>
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
            {/* ── Actions Card ── */}
            <div style={{ ...C.card, background: "#F9FAFB" }}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Actions</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {isPending && (
                  <>
                    <s-button type="button" variant="primary" disabled={fetcher.state !== "idle"} onClick={() => setShowApproveModal(true)} style={{ width: "100%" }}>
                      Approve Return
                    </s-button>
                    {showApproveModal && (
                      <div className="app-modal-overlay" onClick={() => setShowApproveModal(false)}>
                        <div className="app-modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 480 }}>
                          <div className="app-modal-title">Approve Return</div>
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
                        Reject Return
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
                {(isApproved || isCompleted) && !isRefunded && !isManualReturn && (
                  <>
                    <s-button type="button" variant="primary" disabled={fetcher.state !== "idle"} onClick={() => setShowRefundConfirm(true)} style={{ width: "100%" }}>
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
                                  <span><strong>COD order</strong> — Refund to original payment is not available. Use Store credit or Discount code.</span>
                                </div>
                              )}
                              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                {([
                                  { value: "original" as const, label: "Original payment", desc: isCodOrder ? "Not available for COD orders" : "Refund to customer's original payment method", color: "#3B82F6", bg: "#EFF6FF", border: "#3B82F6", disabled: isCodOrder },
                                  { value: "store_credit" as const, label: "Store credit", desc: "Issue as store credit to customer's account", color: "#22C55E", bg: "#F0FDF4", border: "#22C55E", disabled: false },
                                  { value: "both" as const, label: "Split refund", desc: isCodOrder ? "Not available for COD orders" : "Split between original payment and store credit", color: "#F59E0B", bg: "#FFFBEB", border: "#F59E0B", disabled: isCodOrder },
                                  ...(discountCodeRefundEnabled ? [{
                                    value: "discount_code" as const,
                                    label: "Discount code",
                                    desc: `Generate a single-use discount code (${discountCodePrefix}-...) valid for ${discountCodeExpiryDays} days`,
                                    color: "#8B5CF6", bg: "#F5F3FF", border: "#8B5CF6", disabled: false,
                                  }] : []),
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
                                        {opt.value === "discount_code" && (
                                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={modalRefundMethod === "discount_code" ? "#8B5CF6" : "#6B7280"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
                                        )}
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
                                <div style={{ marginTop: 10, padding: "10px 12px", background: "#FEF3C7", borderRadius: 8 }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                                    <span style={{ fontSize: 12, fontWeight: 600, color: "#92400E" }}>Store credit: {modalStoreCreditPct}%</span>
                                    <span style={{ fontSize: 11, color: "#B45309" }}>|</span>
                                    <span style={{ fontSize: 12, fontWeight: 600, color: "#92400E" }}>Original: {100 - modalStoreCreditPct}%</span>
                                  </div>
                                  <input
                                    type="range" min={5} max={95} step={5}
                                    value={modalStoreCreditPct}
                                    onChange={(e) => setModalStoreCreditPct(parseInt(e.target.value, 10))}
                                    style={{ width: "100%", accentColor: "#F59E0B" }}
                                  />
                                </div>
                              )}
                              {modalRefundMethod === "store_credit" && (
                                <div style={{ marginTop: 8, fontSize: 11, color: "#166534", background: "#DCFCE7", padding: "6px 10px", borderRadius: 6 }}>
                                  Requires new customer accounts in Shopify. Order must have an associated customer.
                                </div>
                              )}
                              {modalRefundMethod === "discount_code" && (
                                <div style={{ marginTop: 8, fontSize: 11, color: "#5B21B6", background: "#EDE9FE", padding: "8px 10px", borderRadius: 6 }}>
                                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
                                    <strong>Code: {discountCodePrefix}-{(returnCase as { returnRequestNo?: string | null }).returnRequestNo || "..."}</strong>
                                  </div>
                                  Single-use, fixed amount, expires in {discountCodeExpiryDays} days. Customer can apply at checkout.
                                </div>
                              )}
                            </div>

                            {/* Bonus Credit Preview */}
                            {bonusCreditEnabled && (modalRefundMethod === "store_credit" || modalRefundMethod === "both") && (() => {
                              const itemTotal = (returnCase.items ?? []).reduce((sum, it) => {
                                const p = (it as { price?: string | null }).price;
                                return sum + (p ? parseFloat(p) * it.qty : 0);
                              }, 0);
                              if (itemTotal <= 0) return null;
                              const bonusAmt = Math.round(itemTotal * (bonusCreditPct / 100) * 100) / 100;
                              const scPortion = modalRefundMethod === "both"
                                ? Math.round(itemTotal * (modalStoreCreditPct / 100) * 100) / 100
                                : itemTotal;
                              const totalCredit = Math.round((scPortion + bonusAmt) * 100) / 100;
                              return (
                                <div style={{ padding: 14, background: "#F0FDF4", borderRadius: 10, border: "1px solid #BBF7D0" }}>
                                  <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8, display: "flex", alignItems: "center", gap: 6, color: "#166534" }}>
                                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#166534" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2z"/></svg>
                                    Store credit bonus ({bonusCreditPct}%)
                                  </div>
                                  <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                                    <div style={{ display: "flex", justifyContent: "space-between" }}>
                                      <span style={{ color: "#374151" }}>{modalRefundMethod === "both" ? `Store credit portion (${modalStoreCreditPct}%)` : "Refund amount"}</span>
                                      <span style={{ fontWeight: 500 }}>{formatMoney(String(scPortion), shopCurrency, shopLocale)}</span>
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
                                ...(bonusCreditEnabled && (modalRefundMethod === "store_credit" || modalRefundMethod === "both") ? {
                                  bonusAmount: (() => {
                                    const itemTotal = (returnCase.items ?? []).reduce((sum, it) => {
                                      const p = (it as { price?: string | null }).price;
                                      return sum + (p ? parseFloat(p) * it.qty : 0);
                                    }, 0);
                                    return itemTotal > 0 ? Math.round(itemTotal * (bonusCreditPct / 100) * 100) / 100 : undefined;
                                  })(),
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
                                  modalRefundMethod === "discount_code" ? "Generate discount code" :
                                  "Process split refund"
                                )}
                              </s-button>
                            </fetcher.Form>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
                {(isApproved || isCompleted) && !isRefunded && isManualReturn && (
                  <div style={{ padding: 10, background: "#FEF3C7", borderRadius: 8, fontSize: 13, color: "#92400E" }}>
                    Manual return — process refund in Shopify Admin for <strong>{returnCase.shopifyOrderName || "--"}</strong>
                  </div>
                )}
                {(isApproved || isCompleted) && returnCase.resolutionType === "exchange" && !returnCase.exchangeOrderId && !isManualReturn && (
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
                  const exchangeOrderGidNum = returnCase.exchangeOrderId.replace(/^gid:\/\/shopify\/DraftOrder\//, "");
                  const exchangeUrl = `https://admin.shopify.com/store/${storeName}/draft_orders/${exchangeOrderGidNum}`;
                  let exchangeItems: Array<{ title?: string; quantity?: number; price?: string }> = [];
                  try {
                    if (returnCase.exchangeItemsJson) exchangeItems = JSON.parse(returnCase.exchangeItemsJson);
                  } catch { /* ignore */ }
                  return (
                    <div style={{ padding: 14, background: "#DCFCE7", borderRadius: 10, border: "1px solid #BBF7D0" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#166534" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                        <span style={{ fontWeight: 700, fontSize: 14, color: "#166534" }}>Exchange order created</span>
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {returnCase.exchangeOrderName && (
                          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                            <span style={{ color: "#166534" }}>Draft Order</span>
                            <span style={{ fontWeight: 700, color: "#166534" }}>{returnCase.exchangeOrderName}</span>
                          </div>
                        )}
                        {exchangeItems.length > 0 && (
                          <div style={{ fontSize: 12, color: "#15803D", marginTop: 4 }}>
                            {exchangeItems.length} item{exchangeItems.length !== 1 ? "s" : ""}
                          </div>
                        )}
                        <a
                          href={exchangeUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ fontSize: 12, fontWeight: 600, color: "#059669", marginTop: 4 }}
                        >
                          View in Shopify Admin &rarr;
                        </a>
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
                              <select value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} style={{ width: "100%", padding: "8px 10px", borderRadius: 6, border: "1px solid #D1D5DB", fontSize: 13, background: "#fff", marginBottom: 12 }}>
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
                  let refundInfo: { refundId?: string; amount?: string; currency?: string; createdAt?: string; method?: string; source?: string; bonusCreditAmount?: string; greenReturn?: boolean; discountCode?: string } | null = null;
                  try {
                    const raw = (returnCase as { refundJson?: string | null }).refundJson;
                    if (raw) refundInfo = JSON.parse(raw);
                  } catch { /* no refund details */ }
                  const storedBonusAmount = (returnCase as { bonusCreditAmount?: string | null }).bonusCreditAmount;
                  const displayBonus = refundInfo?.bonusCreditAmount ?? storedBonusAmount;
                  const storedDiscountCode = (returnCase as { discountCode?: string | null }).discountCode;
                  const storedDiscountValue = (returnCase as { discountCodeValue?: string | null }).discountCodeValue;
                  const isDiscountRefund = refundInfo?.method === "discount_code" || !!storedDiscountCode;
                  const displayDiscountCode = refundInfo?.discountCode ?? storedDiscountCode;
                  return (
                    <div style={{ padding: 14, background: isDiscountRefund ? "#EDE9FE" : "#DCFCE7", borderRadius: 10, border: isDiscountRefund ? "1px solid #C4B5FD" : "1px solid #BBF7D0" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: refundInfo ? 10 : 0 }}>
                        {isDiscountRefund ? (
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#5B21B6" strokeWidth="2.5"><path d="M20.59 13.41l-7.17 7.17a2 2 0 01-2.83 0L2 12V2h10l8.59 8.59a2 2 0 010 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>
                        ) : (
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#166534" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                        )}
                        <span style={{ fontWeight: 700, fontSize: 14, color: isDiscountRefund ? "#5B21B6" : "#166534" }}>
                          {isDiscountRefund ? "Discount code issued" : "Refund processed"}
                        </span>
                      </div>
                      {displayDiscountCode && (
                        <div style={{ padding: "10px 14px", background: isDiscountRefund ? "#F5F3FF" : "#F0FDF4", borderRadius: 8, marginBottom: 10, border: isDiscountRefund ? "1px dashed #A78BFA" : "1px dashed #86EFAC" }}>
                          <div style={{ fontSize: 11, color: isDiscountRefund ? "#7C3AED" : "#166534", fontWeight: 500, marginBottom: 4 }}>Discount Code</div>
                          <div style={{ fontFamily: "monospace", fontSize: 18, fontWeight: 700, color: isDiscountRefund ? "#5B21B6" : "#166534", letterSpacing: "0.05em" }}>
                            {displayDiscountCode}
                          </div>
                          {storedDiscountValue && (
                            <div style={{ fontSize: 12, color: isDiscountRefund ? "#7C3AED" : "#166534", marginTop: 4 }}>
                              Value: {formatMoney(storedDiscountValue, refundInfo?.currency || shopCurrency, shopLocale)}
                            </div>
                          )}
                        </div>
                      )}
                      {refundInfo && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {refundInfo.amount && !isDiscountRefund && (
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
                              <span style={{ color: isDiscountRefund ? "#5B21B6" : "#166534" }}>Processed</span>
                              <span style={{ color: isDiscountRefund ? "#5B21B6" : "#166534" }}>{new Intl.DateTimeFormat(shopLocale || "en", { dateStyle: "medium", timeStyle: "short", timeZone: undefined }).format(new Date(refundInfo.createdAt))}</span>
                            </div>
                          )}
                          {refundInfo.source && (
                            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                              <span style={{ color: isDiscountRefund ? "#5B21B6" : "#166534" }}>Triggered by</span>
                              <span style={{ color: isDiscountRefund ? "#5B21B6" : "#166534" }}>{refundInfo.source === "admin" ? "Admin" : refundInfo.source === "fynd_webhook" ? "Fynd" : refundInfo.source === "auto_fynd_credit_note" ? "Auto (Credit Note)" : refundInfo.source}</span>
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
                {(returnCase.forwardAwb || returnCase.returnAwb) && (
                  <>
                    {returnCase.forwardAwb && <div><div style={C.label}>Forward AWB</div><div style={C.mono}>{returnCase.forwardAwb}</div></div>}
                    {returnCase.returnAwb && <div><div style={C.label}>Return AWB</div><div style={C.mono}>{returnCase.returnAwb}</div></div>}
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
                            <span style={{ fontSize: 11, color: "#6b7280" }}>{new Date(prev.createdAt).toLocaleDateString()}</span>
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
                            {[cAddress1, cAddress2].filter(Boolean).join(", ")}
                            {(cCity || cProvince || cZip) && <div>{[cCity, cProvince, cZip].filter(Boolean).join(", ")}</div>}
                            {cCountry && <div>{cCountry}</div>}
                            {cLandmark && <div style={{ color: "#6B7280", fontSize: 12 }}>Landmark: {cLandmark}</div>}
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
                            <input type="text" name="customerAddress1" defaultValue={cAddress1 ?? ""} maxLength={500} style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #E5E7EB", fontSize: 13, boxSizing: "border-box" }} />
                          </div>
                          <div>
                            <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280", display: "block", marginBottom: 2 }}>Address 2</label>
                            <input type="text" name="customerAddress2" defaultValue={cAddress2 ?? ""} maxLength={500} style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #E5E7EB", fontSize: 13, boxSizing: "border-box" }} />
                          </div>
                          <div>
                            <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280", display: "block", marginBottom: 2 }}>City</label>
                            <input type="text" name="customerCity" defaultValue={returnCase.customerCity ?? ""} maxLength={100} style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #E5E7EB", fontSize: 13, boxSizing: "border-box" }} />
                          </div>
                          <div>
                            <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280", display: "block", marginBottom: 2 }}>State / Province</label>
                            <input type="text" name="customerProvince" defaultValue={cProvince ?? ""} maxLength={100} style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #E5E7EB", fontSize: 13, boxSizing: "border-box" }} />
                          </div>
                          <div>
                            <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280", display: "block", marginBottom: 2 }}>ZIP / Pincode</label>
                            <input type="text" name="customerZip" defaultValue={cZip ?? ""} maxLength={20} style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #E5E7EB", fontSize: 13, boxSizing: "border-box" }} />
                          </div>
                          <div>
                            <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280", display: "block", marginBottom: 2 }}>Country</label>
                            <input type="text" name="customerCountry" defaultValue={returnCase.customerCountry ?? ""} maxLength={100} style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #E5E7EB", fontSize: 13, boxSizing: "border-box" }} />
                          </div>
                        </div>
                        <div style={{ marginBottom: 10 }}>
                          <label style={{ fontSize: 11, fontWeight: 600, color: "#6B7280", display: "block", marginBottom: 2 }}>Landmark</label>
                          <input type="text" name="customerLandmark" defaultValue={cLandmark ?? ""} maxLength={500} style={{ width: "100%", padding: "6px 8px", borderRadius: 6, border: "1px solid #E5E7EB", fontSize: 13, boxSizing: "border-box" }} />
                        </div>
                        <s-button type="submit" variant="secondary" size="slim" disabled={fetcher.state !== "idle"}>Save address</s-button>
                      </fetcher.Form>
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
                return (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ ...C.label, marginBottom: 8 }}>Customer uploads</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                      {media.map((m, idx) => (
                        <a
                          key={idx}
                          href={m.dataUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title={m.name || `Upload ${idx + 1}`}
                          style={{ display: "block", borderRadius: 8, overflow: "hidden", border: "1px solid #E5E7EB", background: "#F9FAFB" }}
                        >
                          <img
                            src={m.dataUrl}
                            alt={m.name || `Upload ${idx + 1}`}
                            style={{ width: 120, height: 120, objectFit: "cover", display: "block" }}
                          />
                          <div style={{ padding: "4px 8px", fontSize: 11, color: "#6B7280", textAlign: "center", maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {m.name || `Upload ${idx + 1}`}
                          </div>
                        </a>
                      ))}
                    </div>
                  </div>
                );
              })()}
              <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`}>
                <input type="hidden" name="action" value="add_note" />
                <div style={{ ...C.label, marginBottom: 6 }}>Internal notes</div>
                <textarea name="note" defaultValue={returnCase.adminNotes ?? ""} rows={2} style={{ width: "100%", padding: 8, borderRadius: 6, border: "1px solid #E5E7EB", marginBottom: 8, boxSizing: "border-box", fontSize: 13 }} />
                <s-button type="submit" variant="secondary" disabled={fetcher.state !== "idle"}>Save</s-button>
              </fetcher.Form>
              <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`} style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #F3F4F6" }}>
                <input type="hidden" name="action" value="save_notes_for_customer" />
                <div style={{ ...C.label, marginBottom: 6 }}>Customer-facing notes</div>
                <div style={{ fontSize: 11, color: "#9CA3AF", marginBottom: 6 }}>Visible to the customer in the portal</div>
                <textarea name="notesForCustomer" defaultValue={(returnCase as { notesForCustomer?: string | null }).notesForCustomer ?? ""} rows={2} placeholder="e.g. Please ship the item to..." style={{ width: "100%", padding: 8, borderRadius: 6, border: "1px solid #E5E7EB", marginBottom: 8, boxSizing: "border-box", fontSize: 13 }} />
                <s-button type="submit" variant="secondary" disabled={fetcher.state !== "idle"}>Publish</s-button>
              </fetcher.Form>
            </div>
          </div>
        </div>
      </div>
    </s-page>
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
    <s-page heading={heading}>
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
    </s-page>
  );
}
