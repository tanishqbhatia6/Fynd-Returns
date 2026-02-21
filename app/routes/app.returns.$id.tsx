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
  items: Array<{ sku?: string; title?: string; quantity?: number; identifier?: string }>;
};

function ShipmentRow({ shipment: s, index, expanded, onToggle, safeStr }: {
  shipment: ShipmentForRow;
  index: number;
  expanded: boolean;
  onToggle: () => void;
  safeStr: (v: unknown) => string;
}) {
  const cardStyle = { padding: 16, background: "#f9fafb", borderRadius: 8, border: "1px solid #e1e3e5" };
  return (
    <div style={{ ...cardStyle, padding: expanded ? 16 : "12px 16px" }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 16, flex: 1, minWidth: 0 }}>
          <span style={{ fontWeight: 600, fontSize: 13 }}>Shipment {index + 1}</span>
          <span style={{ fontFamily: "monospace", fontSize: 12, color: "#6d7175" }}>{s.shipmentId}</span>
          {safeStr(s.cpName) && <span style={{ fontSize: 13 }}>{safeStr(s.cpName)}</span>}
          {safeStr(s.forwardAwb) && <span style={{ fontFamily: "monospace", fontSize: 12 }}>AWB: {safeStr(s.forwardAwb)}</span>}
          {safeStr(s.shipmentStatus) && (
            <span style={{ fontSize: 12, padding: "2px 8px", borderRadius: 6, background: "#e1e3e5", color: "#1a1a1a" }}>{safeStr(s.shipmentStatus)}</span>
          )}
        </div>
        <button type="button" onClick={onToggle} style={{ fontSize: 13, color: "#005bd3", background: "none", border: "none", cursor: "pointer", fontWeight: 500 }}>
          {expanded ? "Hide details" : "View details"}
        </button>
      </div>
      {expanded && (
        <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid #e1e3e5" }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12, marginBottom: 12 }}>
            <div><div style={{ fontSize: 11, color: "#6d7175" }}>CP Name</div><div style={{ fontSize: 13 }}>{safeStr(s.cpName) || "—"}</div></div>
            <div><div style={{ fontSize: 11, color: "#6d7175" }}>Forward AWB</div><div style={{ fontFamily: "monospace", fontSize: 13 }}>{safeStr(s.forwardAwb) || "—"}</div></div>
            <div><div style={{ fontSize: 11, color: "#6d7175" }}>Tracking</div><div style={{ fontSize: 13 }}>
              {s.trackingUrl ? <a href={s.trackingUrl} target="_blank" rel="noopener noreferrer" style={{ color: "#005bd3", textDecoration: "none" }}>Track shipment →</a> : "—"}
            </div></div>
            <div><div style={{ fontSize: 11, color: "#6d7175" }}>Invoice number</div><div style={{ fontSize: 13 }}>{safeStr(s.invoiceNumber) || "—"}</div></div>
            <div><div style={{ fontSize: 11, color: "#6d7175" }}>Invoice ID</div><div style={{ fontSize: 13 }}>{safeStr(s.invoiceId) || "—"}</div></div>
            <div><div style={{ fontSize: 11, color: "#6d7175" }}>Fulfilling store</div><div style={{ fontSize: 13 }}>{safeStr(s.fulfillmentStore) || "—"}</div></div>
            <div><div style={{ fontSize: 11, color: "#6d7175" }}>Fulfillment options</div><div style={{ fontSize: 13 }}>{safeStr(s.fulfillmentOptions) || "—"}</div></div>
            <div><div style={{ fontSize: 11, color: "#6d7175" }}>Status</div><div style={{ fontSize: 13 }}>{safeStr(s.shipmentStatus) || "—"}</div></div>
          </div>
          {(s.items ?? []).length > 0 && (
            <div>
              <div style={{ fontSize: 11, color: "#6d7175", marginBottom: 8 }}>Items</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {(s.items ?? []).map((it, i) => (
                  <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", background: "#fff", borderRadius: 6, border: "1px solid #e1e3e5", fontSize: 13 }}>
                    <span>{safeStr(it.title) || safeStr(it.sku) || safeStr(it.identifier) || "Item"}</span>
                    <span style={{ color: "#6d7175" }}>Qty: {it.quantity ?? 1} {safeStr(it.sku) ? `· ${safeStr(it.sku)}` : ""}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import { fetchOrder, fetchOrderByOrderNumber } from "../lib/shopify-admin.server";
import { parseFyndPayloadForDisplay, parseFyndOrderDetailsForTab } from "../lib/fynd-payload.server";

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

    return { returnCase, shopDomain: session.shop, shopifyOrder, isManualReturn, fyndPayloadInfo, fyndOrderDetailsTab };
  } catch (err) {
    if (err instanceof Response) throw err;
    console.error("Return detail loader unexpected error:", err);
    throw new Response("Failed to load return", { status: 500 });
  }
};

export default function ReturnDetail() {
  const { returnCase, shopDomain, shopifyOrder, isManualReturn, fyndPayloadInfo, fyndOrderDetailsTab } = useLoaderData<typeof loader>();
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
    padding: 20,
    background: "#fff",
    borderRadius: 12,
    border: "1px solid #e1e3e5",
    marginBottom: 16,
  };

  const canRetryFynd = !isManualReturn
    && ["approved", "completed"].includes(returnCase.status.toLowerCase())
    && !returnCase.fyndReturnId;

  return (
    <s-page heading={`Return ${returnCase.shopifyOrderName || returnCase.id}`}>
      <div className="app-content">
      {fetcher.data?.error && (
        <div className="app-alert app-alert-error">{fetcher.data.error}</div>
      )}
      {fyndError && (
        <div className="app-alert app-alert-warning">
          <p style={{ margin: "0 0 8px 0", fontWeight: 600, color: "#92400e" }}>Fynd sync issue</p>
          <p style={{ margin: 0, color: "#78350f" }}>{decodeURIComponent(fyndError)}</p>
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
          <div style={{ ...cardStyle, marginBottom: 8 }}>
            <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 16 }}>Order {shopifyOrder.name}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
              {(shopifyOrder.lineItems ?? []).map((li) => (
                <div
                  key={li.id}
                  style={{
                    display: "flex",
                    gap: 16,
                    padding: 16,
                    background: "#f9fafb",
                    borderRadius: 10,
                    border: "1px solid #e1e3e5",
                    alignItems: "flex-start",
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
                    <div style={{ display: "flex", gap: 16, marginTop: 8, fontSize: 13 }}>
                      <span style={{ color: "#6d7175" }}>Qty: {li.quantity}</span>
                      {li.price != null && li.price !== "" && (
                        <span style={{ fontWeight: 500 }}>{li.price} × {li.quantity}</span>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </s-section>
      )}

      <s-section heading="Return details">
        <div style={{ ...cardStyle }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 24, alignItems: "center", marginBottom: (returnCase.items?.length ?? 0) > 0 ? 16 : 0 }}>
            <span
              style={{
                padding: "8px 14px",
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 600,
                background: `${getStatusColor(returnCase.status)}20`,
                color: getStatusColor(returnCase.status),
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
          {(returnCase.items?.length ?? 0) > 0 && (
            <div>
              <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 8, fontWeight: 500 }}>Items ({returnCase.items!.length})</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {returnCase.items!.map((item) => (
                  <div key={item.id} style={{ display: "flex", justifyContent: "space-between", padding: "10px 12px", background: "#f9fafb", borderRadius: 6, border: "1px solid #e1e3e5", fontSize: 13 }}>
                    <span><strong>{item.sku || item.shopifyLineItemId}</strong> × {item.qty}</span>
                    {item.reasonCode && <span style={{ color: "#6d7175" }}>{item.reasonCode}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {returnCase.status.toLowerCase() === "rejected" && returnCase.rejectionReason && (
            <div style={{ marginTop: 16, padding: 12, background: "#fef2f2", borderRadius: 8, border: "1px solid #fecaca", color: "#991b1b", fontSize: 14 }}>
              <strong>Rejection reason (shown to customer):</strong> {returnCase.rejectionReason}
            </div>
          )}
        </div>
      </s-section>

      <s-section heading="Fynd">
        <div style={{ ...cardStyle, marginBottom: 0 }}>
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
                  <ShipmentRow key={idx} shipment={s} index={idx} expanded={expandedShipment === idx} onToggle={() => setExpandedShipment(expandedShipment === idx ? null : idx)} safeStr={safeStr} />
                ))}
              </div>
            </div>
          ) : (
            <div style={{ padding: 16, background: "#f9fafb", borderRadius: 8, color: "#6d7175", fontSize: 14 }}>
              {!isManualReturn ? "No Fynd shipment data yet. Use Refresh from Fynd to fetch details." : "Manual return — no Fynd sync."}
            </div>
          )}
        </div>
      </s-section>

      {fyndPayloadInfo && fyndPayloadInfo.shipments.length > 0 ? (
        <div style={{ marginBottom: 16 }}>
          <button
            type="button"
            onClick={() => setShowRawFynd((v) => !v)}
            style={{ fontSize: 14, color: "#005bd3", background: "none", border: "none", cursor: "pointer", padding: 0, fontWeight: 500 }}
          >
            {showRawFynd ? "Hide Fynd payload" : "View Fynd payload"}
          </button>
          {showRawFynd && (
            <pre style={{ marginTop: 12, padding: 12, background: "#f6f6f7", borderRadius: 8, overflow: "auto", fontSize: 11, maxHeight: 400 }}>
              {fyndPayloadInfo.rawJson}
            </pre>
          )}
        </div>
      ) : null}

      <s-section heading="Actions">
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 16 }}>
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
      </s-section>

      <s-section heading="Items">
        {(returnCase.items?.length ?? 0) === 0 ? (
          <p style={{ color: "#6d7175" }}>No items in this return.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(returnCase.items || []).map((item) => (
              <div
                key={item.id}
                style={{
                  padding: 16,
                  background: "#f9fafb",
                  borderRadius: 8,
                  border: "1px solid #e1e3e5",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                  <div>
                    <strong>{item.sku || item.shopifyLineItemId}</strong> × {item.qty}
                  </div>
                  <div style={{ color: "#6d7175" }}>{item.reasonCode || "—"}</div>
                </div>
                {(item.fyndShipmentId || item.fyndBagId) && (
                  <div style={{ fontSize: 12, color: "#6d7175", marginTop: 8 }}>
                    {item.fyndShipmentId && <span>Fynd Shipment: <code style={{ background: "#eee", padding: "2px 6px", borderRadius: 4 }}>{item.fyndShipmentId}</code></span>}
                    {item.fyndShipmentId && item.fyndBagId && " · "}
                    {item.fyndBagId && <span>Bag: <code style={{ background: "#eee", padding: "2px 6px", borderRadius: 4 }}>{item.fyndBagId}</code></span>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </s-section>

      <s-section heading="Return tracking (timeline)">
        {(returnCase.events?.length ?? 0) === 0 ? (
          <p style={{ color: "#6d7175" }}>No events yet.</p>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {(returnCase.events || []).map((ev) => (
              <div
                key={ev.id}
                style={{
                  padding: 12,
                  background: "#f9fafb",
                  borderRadius: 8,
                  fontSize: 14,
                  borderLeft: "4px solid #005bd3",
                }}
              >
                <span style={{ fontWeight: 600 }}>[{ev.source}]</span> {ev.eventType} — {new Date(ev.happenedAt).toLocaleString()}
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
