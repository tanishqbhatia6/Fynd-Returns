import React, { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { findOrCreateShop } from "../lib/shop.server";
import { AppPage } from "../components/AppPage";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop);
  const scopes = process.env.SCOPES?.split(",") ?? [];
  const hasReadAllOrders = scopes.some((s) => s.trim().toLowerCase().includes("read_all_orders"));
  return {
    readAllOrdersEnabled: shop.settings?.readAllOrdersEnabled ?? false,
    hasReadAllOrdersScope: hasReadAllOrders,
    scopes,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const readAllOrdersEnabled = formData.get("readAllOrdersEnabled") === "on";

  const shop = await findOrCreateShop(session.shop);

  try {
    await prisma.shopSettings.upsert({
      where: { shopId: shop.id },
      create: { shopId: shop.id, readAllOrdersEnabled },
      update: { readAllOrdersEnabled },
    });
    return { success: true };
  } catch (e) {
    /* v8 ignore start */
    // defensive: prisma errors always extend Error; non-Error fallback unreachable
    return { success: false, error: e instanceof Error ? e.message : "Failed to save settings." };
    /* v8 ignore stop */
  }
};

export default function Permissions() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ success?: boolean }>();
  const [enabled, setEnabled] = useState(data.readAllOrdersEnabled);
  const saved = fetcher.data?.success === true;

  return (
    <AppPage heading="Permissions">
      <div className="app-content">
        {saved && (
          <div className="app-alert app-alert-success">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
            <span>Permission settings saved successfully.</span>
          </div>
        )}
        {fetcher.data && fetcher.data.success === false && (
          <div className="app-alert app-alert-error">
            {(fetcher.data as { error?: string }).error || "Failed to save permission settings."}
          </div>
        )}

        <fetcher.Form method="post">
          <p style={{ marginBottom: 28, color: "var(--rpm-text-muted)", fontSize: 14, lineHeight: 1.6 }}>
            Manage app permissions to control what order data can be accessed for return and refund processing.
          </p>

          <div
            style={{
              padding: 24,
              background: "var(--rpm-surface)",
              borderRadius: "var(--rpm-radius-lg)",
              border: "var(--rpm-border)",
              boxShadow: "var(--rpm-shadow-xs)",
              maxWidth: "var(--rpm-layout-form-sm)",
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", gap: 16, marginBottom: 20 }}>
              <div
                style={{
                  width: 48,
                  height: 48,
                  borderRadius: "var(--rpm-radius)",
                  background: "var(--rpm-info-bg)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 24,
                  flexShrink: 0,
                }}
              >
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 16, marginBottom: 6 }}>read_all_orders</div>
                <p style={{ fontSize: 14, color: "var(--rpm-text-muted)", lineHeight: 1.6, marginBottom: 8 }}>
                  Shopify apps can read only the last 60 days of orders by default. Fynd Returns
                  manages the full return lifecycle — which by nature spans orders from any point
                  in time — so four specific flows need broader access:
                </p>
                <ul style={{ fontSize: 13, color: "var(--rpm-text-muted)", lineHeight: 1.65, margin: 0, paddingLeft: 18 }}>
                  <li>
                    <strong>Extended return windows.</strong> Merchants regularly set 90-, 180-,
                    or 365-day return policies (apparel, electronics with manufacturer defects,
                    gift purchases). When a customer starts a return through the storefront
                    portal, we look up their order to verify eligibility, value, and fulfillment
                    status. Without this scope, the lookup fails for the exact orders most
                    likely to be returned under an extended policy — defeating the feature.
                  </li>
                  <li>
                    <strong>Fynd &harr; Shopify order matching.</strong> Merchants using Fynd
                    OMS receive webhooks carrying an <code style={{ fontSize: 12, padding: "1px 4px", background: "rgba(0,0,0,0.05)", borderRadius: 3 }}>affiliate_order_id</code> that identifies
                    the corresponding Shopify order. Those orders can be arbitrarily old —
                    especially for merchants migrating historical data. Without this scope we
                    can't resolve legacy references, breaking reverse-logistics automation.
                  </li>
                  <li>
                    <strong>Historical analytics.</strong> The dashboard supports date ranges
                    over any window the merchant selects (This year, Last 90 days, custom). Return
                    rate and revenue-impact metrics require reading order volume over the same
                    period — so every multi-month report depends on reading historical orders.
                  </li>
                  <li>
                    <strong>Retroactive policy changes.</strong> When a merchant extends their
                    return window (e.g. for a holiday promotion), orders that were previously
                    outside the window become newly eligible. Without this scope the portal
                    would wrongly reject eligible orders.
                  </li>
                </ul>
                <div style={{ fontSize: 12, color: "var(--rpm-text-muted)", marginTop: 12, padding: "8px 12px", background: "var(--rpm-surface-subtle)", borderRadius: 6, lineHeight: 1.55 }}>
                  <strong>Privacy:</strong> order data is never sent to third parties. Customer PII
                  is deleted within 30 days of a <code style={{ fontSize: 11 }}>customers/redact</code> webhook and
                  all per-shop data is wiped on <code style={{ fontSize: 11 }}>shop/redact</code>. This scope is
                  opt-in — you control when to enable it below.
                </div>
              </div>
            </div>

            {/* Scope status */}
            <div
              style={{
                padding: "12px 16px",
                borderRadius: "var(--rpm-radius)",
                marginBottom: 20,
                background: data.hasReadAllOrdersScope ? "var(--rpm-success-bg)" : "var(--rpm-warning-bg)",
                border: `1px solid ${data.hasReadAllOrdersScope ? "var(--rpm-success-border)" : "var(--rpm-warning-border)"}`,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              <span style={{ display: "flex", alignItems: "center" }}>{data.hasReadAllOrdersScope ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg> : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>}</span>
              {data.hasReadAllOrdersScope ? (
                <span style={{ fontSize: 14, color: "#047857", fontWeight: 500 }}>Scope is configured in your app environment</span>
              ) : (
                <span style={{ fontSize: 13, color: "#b45309", lineHeight: 1.5 }}>
                  Add <code style={{ background: "rgba(0,0,0,0.06)", padding: "1px 6px", borderRadius: 4, fontSize: 12 }}>read_all_orders</code> to your SCOPES environment variable and reinstall the app to enable this permission.
                </span>
              )}
            </div>

            {/* Toggle */}
            <div className="app-notification-item" style={{ marginBottom: 0 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Enable read_all_orders</div>
                <div style={{ fontSize: 13, color: "var(--rpm-text-muted)", marginTop: 2 }}>
                  I acknowledge and want full order access for returns
                </div>
              </div>
              <label className="app-toggle">
                <input
                  type="checkbox"
                  name="readAllOrdersEnabled"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                <span className="app-toggle-track" />
              </label>
            </div>
          </div>

          <div className="app-actions">
            <s-button type="submit" loading={fetcher.state !== "idle"}>Save</s-button>
            <Link to="/app/settings">
              <s-button variant="secondary" type="button">Discard</s-button>
            </Link>
          </div>
        </fetcher.Form>
      </div>
    </AppPage>
  );
}
