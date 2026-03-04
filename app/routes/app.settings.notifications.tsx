import { useState } from "react";
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
  icon: string;
}) {
  const [checked, setChecked] = useState(defaultChecked);

  return (
    <div className="app-notification-item">
      <div style={{ fontSize: 24, flexShrink: 0 }}>{icon}</div>
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
            <span>✓</span>
            <span>Notification settings saved successfully.</span>
          </div>
        )}

        {!data.hasResendKey && (
          <div className="app-alert app-alert-warning" style={{ marginBottom: 20 }}>
            <span>⚠️</span>
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
              icon="📩"
              label="New return request"
              description="Send a confirmation email when a customer submits a new return request through the portal."
            />
            <Toggle
              name="notificationApproved"
              defaultChecked={data.notificationApproved}
              icon="✅"
              label="Return approved"
              description="Notify the customer when their return request has been approved and is being processed."
            />
            <Toggle
              name="notificationRejected"
              defaultChecked={data.notificationRejected}
              icon="❌"
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
