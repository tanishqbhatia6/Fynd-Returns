import React, { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { findOrCreateShop } from "../lib/shop.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop);
  const s = shop.settings;
  return {
    notificationNewReturn: s?.notificationNewReturn ?? true,
    notificationApproved: s?.notificationApproved ?? true,
    notificationRejected: s?.notificationRejected ?? true,
    hasResendKey: !!process.env.RESEND_API_KEY,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const notificationNewReturn = formData.get("notificationNewReturn") === "on";
  const notificationApproved = formData.get("notificationApproved") === "on";
  const notificationRejected = formData.get("notificationRejected") === "on";

  const shop = await findOrCreateShop(session.shop);

  await prisma.shopSettings.upsert({
    where: { shopId: shop.id },
    create: {
      shopId: shop.id,
      notificationNewReturn,
      notificationApproved,
      notificationRejected,
    },
    update: {
      notificationNewReturn,
      notificationApproved,
      notificationRejected,
    },
  });
  return { success: true };
};

function Toggle({ name, defaultChecked, label, description, icon }: {
  name: string;
  defaultChecked: boolean;
  label: string;
  description: string;
  icon: React.ReactNode;
}) {
  const [checked, setChecked] = useState(defaultChecked);

  return (
    <div className="app-notification-item">
      <div style={{ flexShrink: 0, display: "flex", alignItems: "center" }}>{icon}</div>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4, color: "var(--rpm-text)" }}>{label}</div>
        <div style={{ fontSize: 13, color: "var(--rpm-text-muted)", lineHeight: 1.5 }}>{description}</div>
      </div>
      <label className="app-toggle">
        <input
          type="checkbox"
          name={name}
          checked={checked}
          onChange={(e) => setChecked(e.target.checked)}
        />
        <span className="app-toggle-track" />
      </label>
    </div>
  );
}

export default function Notifications() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ success?: boolean }>();
  const saved = fetcher.data && "success" in fetcher.data;

  return (
    <s-page heading="Notifications">
      <div className="app-content">
        {saved && (
          <div className="app-alert app-alert-success">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
            <span>Notification settings saved successfully.</span>
          </div>
        )}

        {!data.hasResendKey && (
          <div className="app-alert app-alert-warning" style={{ marginBottom: 20 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
            <div>
              <p style={{ fontWeight: 500, marginBottom: 4 }}>Email notifications require Resend API</p>
              <p style={{ fontSize: 13, opacity: 0.9 }}>
                Set <code style={{ background: "rgba(0,0,0,0.08)", padding: "1px 6px", borderRadius: 4 }}>RESEND_API_KEY</code> environment variable to enable customer email notifications.
                Get a free key at <a href="https://resend.com" target="_blank" rel="noopener noreferrer" style={{ color: "inherit", fontWeight: 600 }}>resend.com</a>.
              </p>
            </div>
          </div>
        )}

        <fetcher.Form method="post">
          <p style={{ marginBottom: 8, color: "var(--rpm-text-muted)", fontSize: 14, lineHeight: 1.6 }}>
            Choose which events trigger email notifications to your customers. Toggle each notification type on or off.
          </p>

          <div style={{ display: "flex", flexDirection: "column", gap: 14, maxWidth: 560, marginTop: 24 }}>
            <Toggle
              name="notificationNewReturn"
              defaultChecked={data.notificationNewReturn}
              icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>}
              label="New return request"
              description="Send a confirmation email when a customer submits a new return request through the portal."
            />
            <Toggle
              name="notificationApproved"
              defaultChecked={data.notificationApproved}
              icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>}
              label="Return approved"
              description="Notify the customer when their return request has been approved and is being processed."
            />
            <Toggle
              name="notificationRejected"
              defaultChecked={data.notificationRejected}
              icon={<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>}
              label="Return rejected"
              description="Notify the customer when their return request has been declined, including the reason."
            />
          </div>

          <div className="app-actions">
            <s-button type="submit" loading={fetcher.state !== "idle"}>Save notifications</s-button>
            <Link to="/app/settings">
              <s-button variant="secondary" type="button">Discard</s-button>
            </Link>
          </div>
        </fetcher.Form>
      </div>
    </s-page>
  );
}
