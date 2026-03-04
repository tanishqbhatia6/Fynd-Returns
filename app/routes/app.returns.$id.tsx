import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useNavigate, useFetcher, useSearchParams, isRouteErrorResponse, useRouteError } from "react-router";
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getStatusColor } from "../lib/status-colors";
import { fetchOrder, fetchOrderByOrderNumber } from "../lib/shopify-admin.server";
import { formatReturnRequestId } from "../lib/return-request-id";
import type { MailingAddressDisplay } from "../lib/shopify-admin.server";
import { parseFyndPayloadForDisplay, parseFyndOrderDetailsForTab, getPickupAddressFromFyndPayload } from "../lib/fynd-payload.server";

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
  fulfillmentStore: string | null;
  fulfillmentOptions: string | null;
  shipmentStatus: string | null;
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
            <div><div style={{ fontSize: 11, color: "#6d7175" }}>Invoice</div><div style={{ fontSize: 13 }}>{safeStr(s.invoiceNumber) || safeStr(s.invoiceId) || "—"}</div></div>
            <div><div style={{ fontSize: 11, color: "#6d7175" }}>Fulfilling store</div><div style={{ fontSize: 13 }}>{safeStr(s.fulfillmentStore) || "—"}</div></div>
            <div><div style={{ fontSize: 11, color: "#6d7175" }}>Fulfillment options</div><div style={{ fontSize: 13 }}>{safeStr(s.fulfillmentOptions) || "—"}</div></div>
            <div><div style={{ fontSize: 11, color: "#6d7175" }}>Status</div><div style={{ fontSize: 13 }}>{safeStr(s.shipmentStatus) || "—"}</div></div>
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

function formatMoney(amount: string | null | undefined): string {
  if (amount == null || amount === "") return "";
  const n = parseFloat(amount);
  return isNaN(n) ? amount : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
    if (!isManualReturn && returnCase.shopifyOrderId) {
      try {
        shopifyOrder = await fetchOrder(admin, returnCase.shopifyOrderId);
        if (!shopifyOrder && returnCase.shopifyOrderName) {
          const orderNum = returnCase.shopifyOrderName.replace(/^#/, "").trim();
          if (orderNum) shopifyOrder = await fetchOrderByOrderNumber(admin, orderNum);
        }
      } catch (err) {
        console.warn("Could not fetch Shopify order:", err);
      }
    }

    const fyndPayloadJson = (returnCase as { fyndPayloadJson?: string | null }).fyndPayloadJson;
    const fyndPayloadInfo = parseFyndPayloadForDisplay(fyndPayloadJson);
    const fyndOrderDetailsTab = parseFyndOrderDetailsForTab(fyndPayloadJson);
    const pickupAddress = getPickupAddressFromFyndPayload(fyndPayloadJson);

    return { returnCase, shopDomain: session.shop, shopifyOrder, isManualReturn, fyndPayloadInfo, fyndOrderDetailsTab, pickupAddress };
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("Return detail loader unexpected error:", err);
    throw new Response("Failed to load return", { status: 500 });
  }
};

export default function ReturnDetail() {
  const { returnCase, shopDomain, shopifyOrder, isManualReturn, fyndPayloadInfo, fyndOrderDetailsTab, pickupAddress } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const [showRawFynd, setShowRawFynd] = useState(false);
  const [expandedShipment, setExpandedShipment] = useState<number | null>(null);
  const fetcher = useFetcher<{ success?: boolean; error?: string; status?: string }>();
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [showRefundConfirm, setShowRefundConfirm] = useState(false);
  const storeName = shopDomain.replace(".myshopify.com", "");
  const orderIdForLink = shopifyOrder?.id
    ? shopifyOrder.id.replace(/^gid:\/\/shopify\/Order\//, "")
    : returnCase.shopifyOrderId;
  const orderUrl = isManualReturn
    ? `https://admin.shopify.com/store/${storeName}/orders`
    : `https://admin.shopify.com/store/${storeName}/orders/${orderIdForLink ?? returnCase.shopifyOrderId}`;

  const fyndError = searchParams.get("fyndError");
  const fyndSuccess = searchParams.get("fyndSuccess");
  const fyndRefresh = searchParams.get("fyndRefresh");
  useEffect(() => {
    if (fyndError || fyndSuccess || fyndRefresh) {
      const t = setTimeout(() => {
        setSearchParams((prev) => {
          const next = new URLSearchParams(prev);
          next.delete("fyndError");
          next.delete("fyndSuccess");
          next.delete("fyndRefresh");
          return next;
        }, { replace: true });
      }, 15000);
      return () => clearTimeout(t);
    }
  }, [fyndError, fyndSuccess, fyndRefresh, setSearchParams]);

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
  const fyndSyncStatus = (returnCase as { fyndSyncStatus?: string | null }).fyndSyncStatus;
  const fyndSyncRetries = (returnCase as { fyndSyncRetries?: number }).fyndSyncRetries ?? 0;
  const fyndSyncError = (returnCase as { fyndSyncError?: string | null }).fyndSyncError;

  const statusConfig = isPending
    ? { bg: "#FFF7ED", border: "#FED7AA", color: "#C2410C", icon: "clock", text: "Awaiting Review" }
    : isApproved && !isRefunded
      ? { bg: "#F0FDF4", border: "#BBF7D0", color: "#15803D", icon: "check", text: "Approved" }
      : isApproved && isRefunded
        ? { bg: "#EFF6FF", border: "#BFDBFE", color: "#1D4ED8", icon: "done", text: "Refunded" }
        : isRejected
          ? { bg: "#FEF2F2", border: "#FECACA", color: "#DC2626", icon: "x", text: "Rejected" }
          : isCompleted
            ? { bg: "#EFF6FF", border: "#BFDBFE", color: "#1D4ED8", icon: "done", text: "Completed" }
            : { bg: "#F9FAFB", border: "#E5E7EB", color: "#6B7280", icon: "info", text: returnCase.status };

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
                </svg>
              </div>
              <div>
                <div style={{ fontSize: 22, fontWeight: 700, color: statusConfig.color }}>{statusConfig.text}</div>
                <div style={{ fontSize: 13, color: "#6B7280", marginTop: 2 }}>
                  Return <span style={C.mono}>{returnRequestId}</span> for order <strong>{returnCase.shopifyOrderName || "—"}</strong>
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <s-button variant="secondary" onClick={() => navigate("/app/returns")}>All Returns</s-button>
              <a href={orderUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
                <s-button variant="secondary">{isManualReturn ? "Shopify Orders" : "View in Shopify"}</s-button>
              </a>
            </div>
          </div>
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
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Items being returned ({returnCase.items?.length ?? 0})</div>
              {(returnCase.items?.length ?? 0) === 0 ? (
                <div style={{ padding: 20, textAlign: "center", color: "#9CA3AF", fontSize: 14 }}>No items recorded</div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {(returnCase.items ?? []).map((item) => {
                    const shopifyItem = (shopifyOrder?.lineItems ?? []).find((li) =>
                      li.id === item.shopifyLineItemId ||
                      (li.sku && item.sku && li.sku.toLowerCase() === item.sku.toLowerCase())
                    );
                    const title = (item as { title?: string | null }).title || shopifyItem?.title || item.notes || item.sku || item.shopifyLineItemId || "Item";
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
                            {price && <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 6, background: "#DBEAFE", color: "#1E40AF" }}>{formatMoney(price)} each</span>}
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
                  <div><div style={C.label}>Order</div><div style={C.val}>{shopifyOrder.name}</div></div>
                  <div><div style={C.label}>Placed</div><div style={C.val}>{new Date(shopifyOrder.createdAt).toLocaleDateString()}</div></div>
                  {shopifyOrder.email && <div><div style={C.label}>Email</div><div style={C.val}>{shopifyOrder.email}</div></div>}
                  {shopifyOrder.phone && <div><div style={C.label}>Phone</div><div style={C.val}>{shopifyOrder.phone}</div></div>}
                  {shopifyOrder.displayFulfillmentStatus && <div><div style={C.label}>Fulfillment</div><div style={C.val}>{shopifyOrder.displayFulfillmentStatus.replace(/_/g, " ")}</div></div>}
                  {shopifyOrder.displayFinancialStatus && <div><div style={C.label}>Payment</div><div style={C.val}>{shopifyOrder.displayFinancialStatus.replace(/_/g, " ")}</div></div>}
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
                          <span style={{ color: "#6B7280" }}>Subtotal</span><span>{formatMoney(shopifyOrder.subtotalPrice)}</span>
                        </div>
                      )}
                      {shopifyOrder.totalDiscounts && parseFloat(shopifyOrder.totalDiscounts) > 0 && (
                        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#059669" }}>
                          <span>Discounts</span><span>-{formatMoney(shopifyOrder.totalDiscounts)}</span>
                        </div>
                      )}
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 15, fontWeight: 700, paddingTop: 6, borderTop: "1px solid #E5E7EB" }}>
                        <span>Total</span><span>{formatMoney(shopifyOrder.totalPrice)} {shopifyOrder.currencyCode ?? ""}</span>
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
                  <div style={{ padding: "10px 14px", borderRadius: 8, marginBottom: 16, fontSize: 13, background: fyndSyncStatus === "failed" ? "#FEF2F2" : "#FFFBEB", border: `1px solid ${fyndSyncStatus === "failed" ? "#FECACA" : "#FDE68A"}`, color: fyndSyncStatus === "failed" ? "#991B1B" : "#92400E" }}>
                    {fyndSyncStatus === "failed" && `Sync failed after ${fyndSyncRetries} attempts. `}
                    {fyndSyncStatus === "retry_scheduled" && `Retry #${fyndSyncRetries + 1} scheduled. `}
                    {fyndSyncStatus === "pending" && "Sync pending. "}
                    {fyndSyncError && <span style={{ opacity: 0.8 }}>{fyndSyncError.slice(0, 200)}</span>}
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
                    {fyndOrderDetailsTab!.shipments.map((s, idx) => (
                      <ShipmentRow key={idx} shipment={s} index={idx} expanded={expandedShipment === idx} onToggle={() => setExpandedShipment(expandedShipment === idx ? null : idx)} safeStr={safeStr} formatMoney={formatMoney} shopifyLineItems={shopifyOrder?.lineItems} />
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

            {/* ── Timeline ── */}
            <div style={{ ...C.card }}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Activity timeline</div>
              {(returnCase.events?.length ?? 0) === 0 ? (
                <div style={{ padding: 20, textAlign: "center", color: "#9CA3AF", fontSize: 14 }}>No events yet. Activity will appear here as the return progresses.</div>
              ) : (
                <div style={{ position: "relative", paddingLeft: 28 }}>
                  <div style={{ position: "absolute", left: 11, top: 8, bottom: 8, width: 2, background: "#E5E7EB" }} />
                  {(returnCase.events || []).map((ev, i) => {
                    const isLatest = i === (returnCase.events?.length ?? 0) - 1;
                    const sourceColor = ev.source === "fynd_webhook" ? "#059669" : ev.source === "portal" ? "#2563EB" : ev.source === "system" ? "#8B5CF6" : ev.source === "shopify_webhook" ? "#0EA5E9" : "#64748B";
                    const sourceLabel = ev.source === "fynd_webhook" ? "Fynd" : ev.source === "shopify_webhook" ? "Shopify" : ev.source === "system" ? "System" : ev.source === "portal" ? "Portal" : "Admin";
                    return (
                      <div key={ev.id} style={{ position: "relative", paddingBottom: i < (returnCase.events?.length ?? 0) - 1 ? 20 : 0 }}>
                        <div style={{ position: "absolute", left: -22, top: 2, width: 12, height: 12, borderRadius: "50%", background: isLatest ? sourceColor : "#D1D5DB", border: "2px solid #fff", boxShadow: isLatest ? `0 0 0 3px ${sourceColor}30` : "none" }} />
                        <div>
                          <div style={{ fontWeight: 600, fontSize: 14, color: "#1F2937" }}>
                            {ev.eventType.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase())}
                          </div>
                          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
                            <span style={{ fontSize: 11, fontWeight: 600, padding: "1px 6px", borderRadius: 4, background: `${sourceColor}15`, color: sourceColor }}>{sourceLabel}</span>
                            <span style={{ fontSize: 12, color: "#9CA3AF" }}>{new Date(ev.happenedAt).toLocaleString()}</span>
                          </div>
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
                    <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`}>
                      <input type="hidden" name="json" value={JSON.stringify({ action: "approve" })} />
                      <s-button type="submit" variant="primary" disabled={fetcher.state !== "idle"} style={{ width: "100%" }}>
                        {fetcher.state !== "idle" ? "Processing..." : "Approve Return"}
                      </s-button>
                    </fetcher.Form>
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
                      <div className="app-modal-overlay" onClick={() => setShowRefundConfirm(false)}>
                        <div className="app-modal" onClick={(e) => e.stopPropagation()}>
                          <div className="app-modal-title">Confirm Refund</div>
                          <div className="app-modal-body">
                            <p>Refund for order <strong>{returnCase.shopifyOrderName || "—"}</strong> will be issued to the original payment method.</p>
                            <p style={{ color: "#DC2626", fontWeight: 500, fontSize: 14 }}>This cannot be undone.</p>
                          </div>
                          <div className="app-modal-actions">
                            <s-button type="button" variant="secondary" onClick={() => setShowRefundConfirm(false)}>Cancel</s-button>
                            <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`}>
                              <input type="hidden" name="json" value={JSON.stringify({ action: "process_refund" })} />
                              <s-button type="submit" variant="primary" disabled={fetcher.state !== "idle"}>Yes, process refund</s-button>
                            </fetcher.Form>
                          </div>
                        </div>
                      </div>
                    )}
                  </>
                )}
                {(isApproved || isCompleted) && !isRefunded && isManualReturn && (
                  <div style={{ padding: 10, background: "#FEF3C7", borderRadius: 8, fontSize: 13, color: "#92400E" }}>
                    Manual return — process refund in Shopify Admin for <strong>{returnCase.shopifyOrderName || "—"}</strong>
                  </div>
                )}
                {isRefunded && (
                  <div style={{ padding: 10, background: "#DCFCE7", borderRadius: 8, fontSize: 13, color: "#166534", textAlign: "center", fontWeight: 600 }}>Refund processed</div>
                )}
              </div>
            </div>

            {/* ── Quick Info ── */}
            <div style={{ ...C.card }}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Details</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div><div style={C.label}>Return ID</div><div style={C.mono}>{returnRequestId}</div></div>
                <div><div style={C.label}>Order</div><div style={C.val}>{returnCase.shopifyOrderName || "—"}</div></div>
                <div><div style={C.label}>Created</div><div style={{ ...C.val, fontSize: 13 }}>{new Date(returnCase.createdAt).toLocaleString()}</div></div>
                <div><div style={C.label}>Last Updated</div><div style={{ ...C.val, fontSize: 13 }}>{new Date(returnCase.updatedAt).toLocaleString()}</div></div>
                {returnCase.refundStatus && (
                  <div><div style={C.label}>Refund Status</div><div style={{ ...C.val, color: isRefunded ? "#059669" : "#D97706" }}>{returnCase.refundStatus}</div></div>
                )}
                {(returnCase.forwardAwb || returnCase.returnAwb) && (
                  <>
                    {returnCase.forwardAwb && <div><div style={C.label}>Forward AWB</div><div style={C.mono}>{returnCase.forwardAwb}</div></div>}
                    {returnCase.returnAwb && <div><div style={C.label}>Return AWB</div><div style={C.mono}>{returnCase.returnAwb}</div></div>}
                  </>
                )}
              </div>
            </div>

            {/* ── Customer Info ── */}
            {(returnCase.customerEmailNorm || returnCase.customerPhoneNorm || shopifyOrder?.email || shopifyOrder?.phone) && (
              <div style={{ ...C.card }}>
                <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 16 }}>Customer</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {(shopifyOrder?.email || returnCase.customerEmailNorm) && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22,6 12,13 2,6"/></svg>
                      <span style={{ fontSize: 13 }}>{shopifyOrder?.email || returnCase.customerEmailNorm}</span>
                    </div>
                  )}
                  {(shopifyOrder?.phone || returnCase.customerPhoneNorm) && (
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#6B7280" strokeWidth="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
                      <span style={{ fontSize: 13 }}>{shopifyOrder?.phone || returnCase.customerPhoneNorm}</span>
                    </div>
                  )}
                </div>
                {pickupAddress && (pickupAddress.formatted || pickupAddress.address1) && (
                  <div style={{ marginTop: 14, paddingTop: 14, borderTop: "1px solid #F3F4F6" }}>
                    <div style={C.label}>Pickup address</div>
                    <div style={{ fontSize: 13, lineHeight: 1.6, color: "#374151", marginTop: 4 }}>
                      {pickupAddress.formatted ?? [pickupAddress.name, pickupAddress.address1, pickupAddress.address2, pickupAddress.city, pickupAddress.state, pickupAddress.pincode, pickupAddress.country].filter(Boolean).join(", ")}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* ── Notes ── */}
            <div style={{ ...C.card }}>
              <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>Notes</div>
              {returnCase.customerNotes && (
                <div style={{ marginBottom: 14 }}>
                  <div style={{ ...C.label, marginBottom: 6 }}>Customer notes</div>
                  <div style={{ padding: 10, background: "#FEF3C7", borderRadius: 8, fontSize: 13, whiteSpace: "pre-wrap", color: "#92400E" }}>{returnCase.customerNotes}</div>
                </div>
              )}
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
  const is404 = isRouteErrorResponse(error) && error.status === 404;
  const is500 = isRouteErrorResponse(error) && error.status === 500;
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;

  return (
    <s-page heading={is404 ? "Return not found" : "Something went wrong"}>
      <s-section>
        <p style={{ marginBottom: 16, color: "#6d7175" }}>
          {is404
            ? "The return you're looking for doesn't exist or you don't have access to it."
            : is500
              ? "We couldn't load this return. Please try again later."
              : "An unexpected error occurred."}
        </p>
        {!is404 && !is500 && (
          <details style={{ marginBottom: 16, fontSize: 12, color: "#6d7175", background: "#f6f6f7", padding: 12, borderRadius: 8 }}>
            <summary style={{ cursor: "pointer", fontWeight: 600 }}>Error details (for debugging)</summary>
            <pre style={{ marginTop: 8, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
              {errorMessage}
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
