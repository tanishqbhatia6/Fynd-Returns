import React, { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { findOrCreateShop } from "../lib/shop.server";

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
    return { success: false, error: e instanceof Error ? e.message : "Failed to save settings." };
  }
};

export default function Permissions() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ success?: boolean }>();
  const [enabled, setEnabled] = useState(data.readAllOrdersEnabled);
  const saved = fetcher.data?.success === true;

  return (
    <s-page heading="Permissions">
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
              maxWidth: 560,
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
                <p style={{ fontSize: 14, color: "var(--rpm-text-muted)", lineHeight: 1.6, marginBottom: 0 }}>
                  This permission allows the app to access all orders in your store, including those outside the default 60-day window. Required for full return and refund functionality.
                </p>
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
    </s-page>
  );
}
