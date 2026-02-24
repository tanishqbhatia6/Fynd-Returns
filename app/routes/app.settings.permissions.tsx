import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  let shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    include: { settings: true },
  });
  if (!shop) {
    shop = await prisma.shop.create({
      data: { shopDomain: session.shop },
      include: { settings: true },
    });
  }
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

  let shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!shop) shop = await prisma.shop.create({ data: { shopDomain: session.shop } });

  await prisma.shopSettings.upsert({
    where: { shopId: shop.id },
    create: { shopId: shop.id, readAllOrdersEnabled },
    update: { readAllOrdersEnabled },
  });
  return { success: true };
};

export default function Permissions() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ success?: boolean }>();
  const [enabled, setEnabled] = useState(data.readAllOrdersEnabled);
  const saved = fetcher.data && "success" in fetcher.data;

  return (
    <s-page heading="Permissions">
      <div className="app-content">
        {saved && (
          <div className="app-alert app-alert-success">
            <span>✓</span>
            <span>Permission settings saved successfully.</span>
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
                📄
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
              <span style={{ fontSize: 16 }}>{data.hasReadAllOrdersScope ? "✓" : "⚠️"}</span>
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
