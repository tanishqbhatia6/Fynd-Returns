import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useNavigate, useFetcher, useSearchParams, isRouteErrorResponse, useRouteError } from "react-router";
import { useState, useEffect } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const STATUS_COLORS: Record<string, string> = {
  pending: "#b98900",
  processing: "#005bd3",
  "in progress": "#005bd3",
  approved: "#008060",
  completed: "#008060",
  rejected: "#d72c0d",
  cancelled: "#6d7175",
  initiated: "#b98900",
};

function getStatusColor(s: string) {
  return STATUS_COLORS[s.toLowerCase()] ?? "#6d7175";
}

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
          <span style={{ fontFamily: "monospace", fontSize: 12, color: "#6d7175" }}>{s.shipmentId}</span>
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

import { fetchOrder, fetchOrderByOrderNumber } from "../lib/shopify-admin.server";
import type { MailingAddressDisplay } from "../lib/shopify-admin.server";
import { parseFyndPayloadForDisplay, parseFyndOrderDetailsForTab, getPickupAddressFromFyndPayload } from "../lib/fynd-payload.server";

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

  const cardStyle = {
    padding: 24,
    background: "var(--rpm-surface)",
    borderRadius: "var(--rpm-radius-lg)",
    border: "var(--rpm-border)",
    marginBottom: 16,
    boxShadow: "var(--rpm-shadow-sm)",
    transition: "box-shadow 0.2s ease, border-color 0.2s ease",
  };

  const canRetryFynd = !isManualReturn
    && ["approved", "completed"].includes(returnCase.status.toLowerCase())
    && !returnCase.fyndReturnId;

  return (
    <s-page heading={`Return ${returnCase.shopifyOrderName || returnCase.id}`}>
      <div className="app-content">
      <div style={{ marginBottom: 24, padding: "20px 24px", background: "linear-gradient(135deg, var(--rpm-surface-subtle) 0%, var(--rpm-surface-elevated) 100%)", borderRadius: "var(--rpm-radius-xl)", border: "var(--rpm-border)", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 20 }}>
        <span className="app-status-badge" style={{ padding: "10px 18px", borderRadius: 20, fontSize: 15, fontWeight: 600, background: `${getStatusColor(returnCase.status)}20`, color: getStatusColor(returnCase.status), border: `2px solid ${getStatusColor(returnCase.status)}50` }}>
          {returnCase.status}
        </span>
        <div>
          <div style={{ fontSize: 11, color: "var(--rpm-text-muted)", marginBottom: 2, textTransform: "uppercase", letterSpacing: "0.05em" }}>Order</div>
          <div style={{ fontWeight: 700, fontSize: 18, letterSpacing: "-0.02em" }}>{returnCase.shopifyOrderName || "—"}</div>
        </div>
        <div>
          <div style={{ fontSize: 11, color: "var(--rpm-text-muted)", marginBottom: 2, textTransform: "uppercase", letterSpacing: "0.05em" }}>Created</div>
          <div style={{ fontSize: 14, color: "var(--rpm-text)" }}>{new Date(returnCase.createdAt).toLocaleString()}</div>
        </div>
        {returnCase.refundStatus && (
          <div>
            <div style={{ fontSize: 11, color: "var(--rpm-text-muted)", marginBottom: 2, textTransform: "uppercase", letterSpacing: "0.05em" }}>Refund</div>
            <span style={{ color: returnCase.refundStatus === "refunded" ? "var(--rpm-success)" : "var(--rpm-text-muted)", fontWeight: 600 }}>{returnCase.refundStatus}</span>
          </div>
        )}
      </div>
      {fetcher.data?.error && (
        <div className="app-alert app-alert-error">{fetcher.data.error}</div>
      )}
      {fyndError && (
        <div className="app-alert app-alert-warning" style={{ borderLeft: "4px solid #b45309" }}>
          <p style={{ margin: "0 0 8px 0", fontWeight: 600, color: "#92400e" }}>Fynd sync issue</p>
          <p style={{ margin: 0, color: "#78350f" }}>{decodeURIComponent(fyndError)}</p>
          {(fyndError.includes("403") || fyndError.includes("Forbidden")) && (
            <div style={{ marginTop: 16, padding: 16, background: "rgba(255,255,255,0.5)", borderRadius: 8, border: "1px solid rgba(180,83,9,0.3)" }}>
              <p style={{ margin: "0 0 12px 0", fontWeight: 600, fontSize: 13, color: "#78350f" }}>Fix 403 Forbidden — checklist:</p>
              <ol style={{ margin: 0, paddingLeft: 20, color: "#78350f", fontSize: 13, lineHeight: 1.8 }}>
                <li><strong>Scopes:</strong> Your Fynd OAuth app must have <code style={{ background: "rgba(0,0,0,0.06)", padding: "2px 6px", borderRadius: 4 }}>company/orders/read</code> and <code style={{ background: "rgba(0,0,0,0.06)", padding: "2px 6px", borderRadius: 4 }}>company/orders/write</code>. In Fynd Partners → your extension/app → ensure these scopes are enabled.</li>
                <li><strong>Environment:</strong> UAT credentials only work on UAT. Production credentials only work on Production. Match the environment in Settings → Integrations.</li>
                <li><strong>Company ID & Application ID:</strong> Must match your Fynd Commerce company and application exactly (no extra spaces).</li>
                <li><strong>Test first:</strong> Go to <Link to="/app/settings/integrations" style={{ fontWeight: 600, color: "#b45309" }}>Settings → Integrations</Link>, click <strong>Test Platform</strong>. If that fails, fix credentials there before retrying sync.</li>
              </ol>
              <p style={{ margin: "12px 0 0 0", fontSize: 12, color: "#92400e" }}>
                <a href="https://docs.fynd.com/partners/commerce/references/access-scopes" target="_blank" rel="noopener noreferrer" style={{ color: "#b45309", textDecoration: "underline" }}>Fynd access scopes docs →</a>
              </p>
            </div>
          )}
          {canRetryFynd && (
            <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`} style={{ marginTop: 12 }}>
              <input type="hidden" name="json" value={JSON.stringify({ action: "retry_fynd_sync" })} />
              <s-button type="submit" variant="secondary" disabled={fetcher.state !== "idle"}>
                {fetcher.state !== "idle" ? "Syncing…" : "Retry Fynd sync"}
              </s-button>
            </fetcher.Form>
          )}
        </div>
      )}
      {fyndSuccess && (
        <div className="app-alert app-alert-success">
          {fyndSuccess === "already_synced" ? "This return is already synced to Fynd." : "Return synced to Fynd successfully."}
        </div>
      )}
      {fyndRefresh && (
        <div className="app-alert app-alert-success">Fynd details refreshed from API.</div>
      )}

      <s-section>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <s-button variant="secondary" onClick={() => navigate("/app/returns")}>
            Back to Returns
          </s-button>
          <a href={orderUrl} target="_blank" rel="noopener noreferrer" style={{ textDecoration: "none" }}>
            <s-button variant="secondary">{isManualReturn ? "Orders in Shopify" : "View in Shopify"}</s-button>
          </a>
          {isManualReturn && (
            <span style={{ fontSize: 13, color: "#6d7175" }}>
              Manual return — search for order <strong>{returnCase.shopifyOrderName || "—"}</strong> in Shopify Admin
            </span>
          )}
        </div>
      </s-section>

      {shopifyOrder && (
        <s-section heading="Order from Shopify">
          <div style={{ ...cardStyle, marginBottom: 8 }} className="app-card-interactive">
            <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 16 }}>Order {shopifyOrder.name}</div>

            {(shopifyOrder.email || shopifyOrder.phone) && (
              <div style={{ marginBottom: 20 }}>
                <div style={{ fontSize: 11, color: "#6d7175", marginBottom: 8, fontWeight: 600 }}>Customer</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 16, fontSize: 14 }}>
                  {shopifyOrder.email && <span>{shopifyOrder.email}</span>}
                  {shopifyOrder.phone && <span>{shopifyOrder.phone}</span>}
                </div>
              </div>
            )}

            {(formatAddress(shopifyOrder.shippingAddress) || formatAddress(shopifyOrder.billingAddress)) && (
              <div style={{ marginBottom: 20, display: "flex", flexWrap: "wrap", gap: 24 }}>
                {formatAddress(shopifyOrder.shippingAddress) && (
                  <div>
                    <div style={{ fontSize: 11, color: "#6d7175", marginBottom: 6, fontWeight: 600 }}>Shipping address</div>
                    <div style={{ fontSize: 13, lineHeight: 1.5 }}>{formatAddress(shopifyOrder.shippingAddress)}</div>
                  </div>
                )}
                {formatAddress(shopifyOrder.billingAddress) && (
                  <div>
                    <div style={{ fontSize: 11, color: "#6d7175", marginBottom: 6, fontWeight: 600 }}>Billing address</div>
                    <div style={{ fontSize: 13, lineHeight: 1.5 }}>{formatAddress(shopifyOrder.billingAddress)}</div>
                  </div>
                )}
              </div>
            )}

            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {(shopifyOrder.lineItems ?? []).map((li) => (
                <div
                  key={li.id}
                  style={{
                    display: "flex",
                    gap: 16,
                    padding: 16,
                    background: "var(--rpm-surface-elevated)",
                    borderRadius: "var(--rpm-radius)",
                    border: "var(--rpm-border)",
                    alignItems: "flex-start",
                    transition: "box-shadow 0.2s ease",
                  }}
                >
                  {li.imageUrl ? (
                    <img
                      src={li.imageUrl}
                      alt={li.title}
                      style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, flexShrink: 0 }}
                    />
                  ) : (
                    <div style={{ width: 64, height: 64, background: "#e1e3e5", borderRadius: 8, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#6d7175", fontSize: 24 }}>—</div>
                  )}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{li.title}</div>
                    {li.variantTitle && (
                      <div style={{ fontSize: 13, color: "#6d7175", marginBottom: 4 }}>Variant: {li.variantTitle}</div>
                    )}
                    {li.sku && (
                      <div style={{ fontSize: 12, fontFamily: "monospace", color: "#6d7175", marginBottom: 4 }}>SKU: {li.sku}</div>
                    )}
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 8, fontSize: 13, alignItems: "center" }}>
                      <span style={{ color: "#6d7175" }}>Qty: {li.quantity}</span>
                      {(li.discountedPrice ?? li.price) != null && (li.discountedPrice ?? li.price) !== "" && (
                        <span style={{ fontWeight: 500 }}>
                          {formatMoney(li.discountedPrice ?? li.price)} × {li.quantity}
                          {li.discountedPrice != null && li.price != null && li.discountedPrice !== li.price && (
                            <span style={{ marginLeft: 8, color: "#6d7175", textDecoration: "line-through", fontWeight: 400 }}>{formatMoney(li.price)} each</span>
                          )}
                        </span>
                      )}
                      {(li.discountedTotal ?? li.originalTotal) != null && (li.discountedTotal ?? li.originalTotal) !== "" && (
                        <span style={{ fontWeight: 600 }}>Total: {formatMoney(li.discountedTotal ?? li.originalTotal)}</span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>

            {(shopifyOrder.subtotalPrice != null || shopifyOrder.totalDiscounts != null || shopifyOrder.totalPrice != null || (shopifyOrder.discountCodes?.length ?? 0) > 0) && (
              <div style={{ marginTop: 20, paddingTop: 16, borderTop: "1px solid #e1e3e5" }}>
                <div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 320 }}>
                  {shopifyOrder.subtotalPrice != null && shopifyOrder.subtotalPrice !== "" && (
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                      <span style={{ color: "#6d7175" }}>Subtotal</span>
                      <span>{formatMoney(shopifyOrder.subtotalPrice)}</span>
                    </div>
                  )}
                  {(shopifyOrder.discountCodes?.length ?? 0) > 0 && (
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                      <span style={{ color: "#6d7175" }}>Discount codes</span>
                      <span>{shopifyOrder.discountCodes!.join(", ")}</span>
                    </div>
                  )}
                  {shopifyOrder.totalDiscounts != null && shopifyOrder.totalDiscounts !== "" && parseFloat(shopifyOrder.totalDiscounts) !== 0 && (
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#008060" }}>
                      <span>Discounts</span>
                      <span>−{formatMoney(shopifyOrder.totalDiscounts)}</span>
                    </div>
                  )}
                  {shopifyOrder.totalPrice != null && shopifyOrder.totalPrice !== "" && (
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14, fontWeight: 600, marginTop: 4 }}>
                      <span>Total</span>
                      <span>{formatMoney(shopifyOrder.totalPrice)}</span>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </s-section>
      )}

      <s-section heading="Return details">
        <div style={{ ...cardStyle }} className="app-card-interactive">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "center" }}>
            <span
              className="app-status-badge"
              style={{
                padding: "8px 16px",
                borderRadius: 20,
                fontSize: 14,
                fontWeight: 600,
                background: `${getStatusColor(returnCase.status)}18`,
                color: getStatusColor(returnCase.status),
                border: `1px solid ${getStatusColor(returnCase.status)}40`,
              }}
            >
              {returnCase.status}
            </span>
            <div>
              <div style={{ fontSize: 11, color: "#6d7175", marginBottom: 2 }}>Order</div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{returnCase.shopifyOrderName || "—"}</div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: "#6d7175", marginBottom: 2 }}>Created</div>
              <div style={{ fontSize: 13 }}>{new Date(returnCase.createdAt).toLocaleString()}</div>
            </div>
            {returnCase.refundStatus && (
              <div>
                <div style={{ fontSize: 11, color: "#6d7175", marginBottom: 2 }}>Refund</div>
                <span style={{ color: returnCase.refundStatus === "refunded" ? "#008060" : "#6d7175", fontWeight: 500 }}>{returnCase.refundStatus}</span>
              </div>
            )}
            {(returnCase.forwardAwb || returnCase.returnAwb) && (
              <div style={{ display: "flex", gap: 16, fontSize: 13 }}>
                {returnCase.forwardAwb && <span><strong>Forward AWB:</strong> <code style={{ background: "#f1f2f4", padding: "2px 6px", borderRadius: 4 }}>{returnCase.forwardAwb}</code></span>}
                {returnCase.returnAwb && <span><strong>Return AWB:</strong> <code style={{ background: "#f1f2f4", padding: "2px 6px", borderRadius: 4 }}>{returnCase.returnAwb}</code></span>}
              </div>
            )}
          </div>
          {returnCase.status.toLowerCase() === "rejected" && returnCase.rejectionReason && (
            <div style={{ marginTop: 16, padding: 12, background: "#fef2f2", borderRadius: 8, border: "1px solid #fecaca", color: "#991b1b", fontSize: 14 }}>
              <strong>Rejection reason (shown to customer):</strong> {returnCase.rejectionReason}
            </div>
          )}
          {pickupAddress && (pickupAddress.formatted || pickupAddress.address1 || pickupAddress.city) && (
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid #e1e3e5" }}>
              <div style={{ fontSize: 11, color: "#6d7175", marginBottom: 8, fontWeight: 600 }}>Pickup address</div>
              <div style={{ fontSize: 13, lineHeight: 1.5 }}>
                {pickupAddress.formatted ?? [pickupAddress.name, pickupAddress.address1, pickupAddress.address2, pickupAddress.city, pickupAddress.state, pickupAddress.pincode, pickupAddress.country].filter(Boolean).join(", ")}
              </div>
              {pickupAddress.phone && <div style={{ marginTop: 6, fontSize: 13 }}>Phone: {pickupAddress.phone}</div>}
            </div>
          )}
        </div>
      </s-section>

      <s-section heading="Fynd">
        <div style={{ ...cardStyle, marginBottom: 0 }} className="app-card-interactive">
          <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", alignItems: "center", gap: 16, marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 11, color: "#6d7175", marginBottom: 4 }}>Fynd Order ID</div>
              <div style={{ fontFamily: "monospace", fontSize: 14, fontWeight: 500 }}>
                {fyndOrderDetailsTab?.fyndOrderId || (returnCase as { fyndOrderId?: string | null }).fyndOrderId || (returnCase.shopifyOrderName ?? "").replace(/^#/, "").trim() || "—"}
              </div>
            </div>
            {!isManualReturn && ((returnCase as { fyndOrderId?: string | null }).fyndOrderId != null || (returnCase.shopifyOrderName ?? "").replace(/^#/, "").trim()) && (
              <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`}>
                <input type="hidden" name="json" value={JSON.stringify({ action: "refresh_fynd_details" })} />
                <s-button type="submit" variant="secondary" disabled={fetcher.state !== "idle"}>
                  {fetcher.state !== "idle" ? "Refreshing…" : "Refresh from Fynd"}
                </s-button>
              </fetcher.Form>
            )}
          </div>
          {fyndOrderDetailsTab && fyndOrderDetailsTab.shipments.length > 0 ? (
            <div>
              <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 12, fontWeight: 500 }}>Shipments ({fyndOrderDetailsTab.shipments.length})</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {fyndOrderDetailsTab.shipments.map((s, idx) => (
                  <ShipmentRow key={idx} shipment={s} index={idx} expanded={expandedShipment === idx} onToggle={() => setExpandedShipment(expandedShipment === idx ? null : idx)} safeStr={safeStr} formatMoney={formatMoney} shopifyLineItems={shopifyOrder?.lineItems} />
                ))}
              </div>
            </div>
          ) : (
            <div style={{ padding: 20, background: "var(--rpm-surface-elevated)", borderRadius: "var(--rpm-radius-lg)", color: "var(--rpm-text-muted)", fontSize: 14, border: "var(--rpm-border)" }}>
              {!isManualReturn ? "No Fynd shipment data yet. Use Refresh from Fynd to fetch details." : "Manual return — no Fynd sync."}
            </div>
          )}
          {(fyndPayloadInfo?.shipments?.length ?? 0) > 0 && (
            <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid #e1e3e5" }}>
              <button type="button" onClick={() => setShowRawFynd((v) => !v)} className="app-btn-text">
                {showRawFynd ? "Hide Fynd payload" : "View Fynd payload"}
              </button>
              {showRawFynd && (
                <pre style={{ marginTop: 12, padding: 16, background: "var(--rpm-surface-elevated)", borderRadius: "var(--rpm-radius)", overflow: "auto", fontSize: 11, maxHeight: 400, border: "var(--rpm-border)" }}>
                  {fyndPayloadInfo.rawJson}
                </pre>
              )}
            </div>
          )}
        </div>
      </s-section>

      <s-section heading="Actions">
        <div style={{ ...cardStyle, padding: 24 }} className="app-card-interactive">
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 20 }}>
          {!["approved", "rejected", "completed"].includes(returnCase.status.toLowerCase()) && (
            <>
              <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`}>
                <input type="hidden" name="json" value={JSON.stringify({ action: "approve" })} />
                <s-button type="submit" variant="primary" disabled={fetcher.state !== "idle"}>
                  {fetcher.state !== "idle" ? "Processing..." : "Approve"}
                </s-button>
              </fetcher.Form>
              {!showRejectForm ? (
                <s-button
                  type="button"
                  variant="secondary"
                  disabled={fetcher.state !== "idle"}
                  onClick={() => setShowRejectForm(true)}
                >
                  Reject
                </s-button>
              ) : (
                <div style={{ ...cardStyle, padding: 16, width: "100%", maxWidth: 400 }}>
                  <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>Rejection reason (required — shown to customer)</label>
                  <textarea
                    value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder="e.g. Item is not in original condition"
                    rows={3}
                    style={{ width: "100%", padding: 12, borderRadius: 8, border: "1px solid #e1e3e5", marginBottom: 12 }}
                  />
                  <div style={{ display: "flex", gap: 8 }}>
                    <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`}>
                      <input type="hidden" name="json" value={JSON.stringify({ action: "reject", rejectionReason: rejectReason.trim() })} />
                      <s-button type="submit" variant="secondary" disabled={fetcher.state !== "idle" || !rejectReason.trim()}>
                        {fetcher.state !== "idle" ? "Rejecting..." : "Confirm Reject"}
                      </s-button>
                    </fetcher.Form>
                    <s-button type="button" variant="secondary" onClick={() => { setShowRejectForm(false); setRejectReason(""); }}>
                      Cancel
                    </s-button>
                  </div>
                </div>
              )}
            </>
          )}
          {canRetryFynd && (
            <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`}>
              <input type="hidden" name="json" value={JSON.stringify({ action: "retry_fynd_sync" })} />
              <s-button type="submit" variant="secondary" disabled={fetcher.state !== "idle"}>
                {fetcher.state !== "idle" ? "Syncing…" : "Sync to Fynd"}
              </s-button>
            </fetcher.Form>
          )}
          {["approved", "completed"].includes(returnCase.status.toLowerCase()) &&
            returnCase.refundStatus !== "refunded" &&
            (isManualReturn ? (
              <div style={{ ...cardStyle, padding: 12, background: "#f6f6f7", borderColor: "#e1e3e5" }}>
                <p style={{ margin: 0, fontSize: 14, color: "#1a1a1a" }}>
                  Manual return — process the refund in Shopify Admin for order <strong>{returnCase.shopifyOrderName || "—"}</strong>.
                </p>
              </div>
            ) : (
              <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`}>
                <input type="hidden" name="json" value={JSON.stringify({ action: "process_refund" })} />
                <s-button type="submit" variant="primary" disabled={fetcher.state !== "idle"}>
                  {fetcher.state !== "idle" ? "Processing refund..." : "Process refund in Shopify"}
                </s-button>
              </fetcher.Form>
            ))}
        </div>
        {returnCase.customerNotes && (
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>Customer notes</label>
            <div style={{ padding: 12, background: "#f9fafb", borderRadius: 8, border: "1px solid #e1e3e5", whiteSpace: "pre-wrap" }}>
              {returnCase.customerNotes}
            </div>
          </div>
        )}
        <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`}>
          <input type="hidden" name="action" value="add_note" />
          <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>Admin notes</label>
          <textarea
            name="note"
            defaultValue={returnCase.adminNotes ?? ""}
            rows={3}
            style={{ width: "100%", padding: 12, borderRadius: 8, border: "1px solid #e1e3e5", marginBottom: 12 }}
          />
          <s-button type="submit" variant="secondary" disabled={fetcher.state !== "idle"}>
            Save note
          </s-button>
        </fetcher.Form>
        <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`} style={{ marginTop: 20 }}>
          <input type="hidden" name="action" value="save_notes_for_customer" />
          <label style={{ display: "block", marginBottom: 8, fontWeight: 600, fontSize: 14 }}>Notes for Customer</label>
          <p style={{ fontSize: 12, color: "var(--rpm-text-muted)", marginBottom: 10 }}>These notes will be published and visible to the customer when they view their return.</p>
          <textarea
            name="notesForCustomer"
            defaultValue={(returnCase as { notesForCustomer?: string | null }).notesForCustomer ?? ""}
            rows={3}
            placeholder="e.g. Your return has been approved. Please ship the item to..."
            style={{ width: "100%", padding: 12, borderRadius: "var(--rpm-radius)", border: "var(--rpm-border)", marginBottom: 12, boxSizing: "border-box" }}
          />
          <s-button type="submit" variant="secondary" disabled={fetcher.state !== "idle"}>
            Save & publish
          </s-button>
        </fetcher.Form>
        </div>
      </s-section>

      <s-section heading="Return tracking (timeline)">
        {(returnCase.events?.length ?? 0) === 0 ? (
          <p style={{ color: "var(--rpm-text-muted)", padding: 20, background: "var(--rpm-surface-subtle)", borderRadius: "var(--rpm-radius-lg)", border: "var(--rpm-border)" }}>No events yet.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 0, position: "relative" }}>
            {(returnCase.events || []).map((ev, i) => (
              <div
                key={ev.id}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 16,
                  padding: "14px 18px",
                  background: i % 2 === 0 ? "var(--rpm-surface)" : "var(--rpm-surface-subtle)",
                  borderLeft: "4px solid var(--rpm-accent)",
                  borderRadius: "0 var(--rpm-radius) var(--rpm-radius) 0",
                  marginLeft: 0,
                  fontSize: 14,
                  transition: "background 0.2s ease",
                }}
              >
                <span style={{ fontWeight: 600, color: "var(--rpm-accent)", minWidth: 70 }}>[{ev.source}]</span>
                <span style={{ flex: 1 }}>{ev.eventType}</span>
                <span style={{ color: "var(--rpm-text-muted)", fontSize: 13 }}>{new Date(ev.happenedAt).toLocaleString()}</span>
              </div>
            ))}
          </div>
        )}
      </s-section>
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
