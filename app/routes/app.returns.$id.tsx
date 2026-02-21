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
            <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 8 }}>Order {shopifyOrder.name}</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {(shopifyOrder.lineItems ?? []).map((li) => (
                <div key={li.id} style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #f1f2f4" }}>
                  <span>{li.title} {li.sku ? `(${li.sku})` : ""}</span>
                  <span style={{ color: "#6d7175" }}>Qty: {li.quantity}</span>
                </div>
              ))}
            </div>
          </div>
        </s-section>
      )}

      <s-section heading="Return details">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 16 }}>
          <div>
            <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4 }}>Status</div>
            <span
              style={{
                display: "inline-block",
                padding: "6px 12px",
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 600,
                background: `${getStatusColor(returnCase.status)}20`,
                color: getStatusColor(returnCase.status),
              }}
            >
              {returnCase.status}
            </span>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4 }}>Order</div>
            <div style={{ fontWeight: 500 }}>{returnCase.shopifyOrderName || "—"}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4 }}>Forward AWB</div>
            <div>{returnCase.forwardAwb || "—"}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4 }}>Return AWB</div>
            <div>{returnCase.returnAwb || "—"}</div>
          </div>
          <div>
            <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4 }}>Created</div>
            <div>{new Date(returnCase.createdAt).toLocaleString()}</div>
          </div>
          {returnCase.refundStatus && (
            <div>
              <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4 }}>Refund</div>
              <span style={{ color: returnCase.refundStatus === "refunded" ? "#008060" : "#6d7175" }}>{returnCase.refundStatus}</span>
            </div>
          )}
          {returnCase.status.toLowerCase() === "rejected" && returnCase.rejectionReason && (
            <div style={{ gridColumn: "1 / -1" }}>
              <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4 }}>Rejection reason (shown to customer)</div>
              <div style={{ padding: 12, background: "#fef2f2", borderRadius: 8, border: "1px solid #fecaca", color: "#991b1b" }}>
                {returnCase.rejectionReason}
              </div>
            </div>
          )}
        </div>
      </s-section>

      <s-section heading="Fynd details (end-to-end)">
        <div style={{ ...cardStyle, marginBottom: 0 }}>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 16 }}>
            <div>
              <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4 }}>Fynd Order ID</div>
              <div style={{ fontFamily: "monospace", fontSize: 13 }}>{(returnCase as { fyndOrderId?: string | null }).fyndOrderId || (returnCase.shopifyOrderName ?? "").replace(/^#/, "").trim() || "—"}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4 }}>Fynd Return ID</div>
              <div style={{ fontFamily: "monospace", fontSize: 13 }}>{(returnCase as { fyndReturnId?: string | null }).fyndReturnId || "—"}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4 }}>Fynd Return #</div>
              <div style={{ fontFamily: "monospace", fontSize: 13 }}>{returnCase.fyndReturnNo || "—"}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4 }}>Fynd Shipment ID</div>
              <div style={{ fontFamily: "monospace", fontSize: 13 }}>{(returnCase as { fyndShipmentId?: string | null }).fyndShipmentId || "—"}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4 }}>Forward AWB</div>
              <div style={{ fontFamily: "monospace", fontSize: 13 }}>{returnCase.forwardAwb || "—"}</div>
            </div>
            <div>
              <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4 }}>Return AWB</div>
              <div style={{ fontFamily: "monospace", fontSize: 13 }}>{returnCase.returnAwb || "—"}</div>
            </div>
          </div>
          {!isManualReturn && ((returnCase as { fyndOrderId?: string | null }).fyndOrderId != null || (returnCase.shopifyOrderName ?? "").replace(/^#/, "").trim()) ? (
            <div style={{ marginTop: 16 }}>
              <fetcher.Form method="post" action={`/api/returns/${returnCase.id}/actions`}>
                <input type="hidden" name="json" value={JSON.stringify({ action: "refresh_fynd_details" })} />
                <s-button type="submit" variant="secondary" disabled={fetcher.state !== "idle"}>
                  {fetcher.state !== "idle" ? "Refreshing…" : "Refresh from Fynd"}
                </s-button>
              </fetcher.Form>
            </div>
          ) : null}
        </div>
      </s-section>

      {fyndOrderDetailsTab && fyndOrderDetailsTab.shipments.length > 0 ? (
        <s-section heading="Fynd Order details">
          <div style={{ ...cardStyle, marginBottom: 0 }}>
            <div style={{ marginBottom: 20 }}>
              <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4 }}>Fynd Order ID</div>
              <div style={{ fontFamily: "monospace", fontSize: 14, fontWeight: 500 }}>{fyndOrderDetailsTab.fyndOrderId || "—"}</div>
            </div>
            {fyndOrderDetailsTab.shipments.map((s, idx) => (
              <div key={idx} style={{ padding: 16, background: "#f9fafb", borderRadius: 8, border: "1px solid #e1e3e5", marginBottom: idx < fyndOrderDetailsTab.shipments.length - 1 ? 16 : 0 }}>
                <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: "#1a1a1a" }}>
                  Shipment {idx + 1} — {s.shipmentId}
                </h3>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12, marginBottom: 12 }}>
                  <div><div style={{ fontSize: 11, color: "#6d7175" }}>CP Name (Courier partner)</div><div style={{ fontFamily: "monospace", fontSize: 13 }}>{s.cpName || "—"}</div></div>
                  <div><div style={{ fontSize: 11, color: "#6d7175" }}>Forward AWB / Tracking</div><div style={{ fontFamily: "monospace", fontSize: 13 }}>{s.forwardAwb || "—"}</div></div>
                  <div><div style={{ fontSize: 11, color: "#6d7175" }}>Invoice number</div><div style={{ fontFamily: "monospace", fontSize: 13 }}>{s.invoiceNumber || "—"}</div></div>
                  <div><div style={{ fontSize: 11, color: "#6d7175" }}>Invoice ID</div><div style={{ fontFamily: "monospace", fontSize: 13 }}>{s.invoiceId || "—"}</div></div>
                  <div><div style={{ fontSize: 11, color: "#6d7175" }}>Fulfilling store</div><div style={{ fontFamily: "monospace", fontSize: 13 }}>{s.fulfillmentStore || "—"}</div></div>
                  <div><div style={{ fontSize: 11, color: "#6d7175" }}>Fulfillment options</div><div style={{ fontFamily: "monospace", fontSize: 13 }}>{s.fulfillmentOptions || "—"}</div></div>
                  <div><div style={{ fontSize: 11, color: "#6d7175" }}>Shipment status</div><div style={{ fontFamily: "monospace", fontSize: 13 }}>{s.shipmentStatus || "—"}</div></div>
                </div>
                {(s.items ?? []).length > 0 && (
                  <div>
                    <div style={{ fontSize: 11, color: "#6d7175", marginBottom: 8 }}>Item details</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                      {(s.items ?? []).map((it, i) => (
                        <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "8px 12px", background: "#fff", borderRadius: 6, border: "1px solid #e1e3e5" }}>
                          <span>{it.title || it.sku || it.identifier || "Item"}</span>
                          <span style={{ color: "#6d7175" }}>Qty: {it.quantity ?? 1} {it.sku ? `· ${it.sku}` : ""}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </s-section>
      ) : null}

      {fyndPayloadInfo && fyndPayloadInfo.shipments.length > 0 ? (
        <s-section heading="Fynd full payload (invoice, AWB, DP, logistics and all details)">
          <div style={{ ...cardStyle, marginBottom: 0 }}>
            {fyndPayloadInfo.shipments.map(({ index, fields }) => (
              <div key={index} style={{ marginBottom: index > 1 ? 24 : 0 }}>
                {fyndPayloadInfo.shipments.length > 1 && (
                  <h3 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12, color: "#1a1a1a" }}>Shipment {index}</h3>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12 }}>
                  {fields.map((f) => (
                    <div key={f.key ?? f.label}>
                      <div style={{ fontSize: 11, color: "#6d7175", marginBottom: 2 }}>{f.label}</div>
                      <div style={{ fontFamily: "monospace", fontSize: 13, wordBreak: "break-all" }}>
                        {f.value.length > 200 ? `${f.value.slice(0, 200)}…` : f.value}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div style={{ marginTop: 16 }}>
              <button
                type="button"
                onClick={() => setShowRawFynd((v) => !v)}
                style={{ fontSize: 13, color: "#005bd3", background: "none", border: "none", cursor: "pointer", padding: 0 }}
              >
                {showRawFynd ? "Hide raw JSON" : "Show raw JSON"}
              </button>
              {showRawFynd && (
                <pre style={{ marginTop: 8, padding: 12, background: "#f6f6f7", borderRadius: 8, overflow: "auto", fontSize: 11, maxHeight: 400 }}>
                  {fyndPayloadInfo.rawJson}
                </pre>
              )}
            </div>
          </div>
        </s-section>
      ) : !isManualReturn && ((returnCase as { fyndOrderId?: string | null }).fyndOrderId != null || (returnCase.shopifyOrderName ?? "").replace(/^#/, "").trim()) ? (
        <s-section heading="Fynd full payload">
          <div style={{ ...cardStyle, background: "#f9fafb" }}>
            <p style={{ margin: 0, color: "#6d7175", fontSize: 14 }}>No Fynd payload stored yet. Use &quot;Refresh from Fynd&quot; above to fetch invoice, AWB, DP and all details from Fynd.</p>
          </div>
        </s-section>
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
        <Link to="/app/returns">
          <s-button variant="primary">Back to Returns</s-button>
        </Link>
      </s-section>
    </s-page>
  );
}
