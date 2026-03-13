import * as React from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { findOrCreateShop } from "../lib/shop.server";

type BlocklistEntryRow = {
  id: string;
  type: string;
  value: string;
  reason: string | null;
  blockedBy: string | null;
  createdAt: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop);
  const s = shop.settings;

  const entries: BlocklistEntryRow[] = [];
  if (s) {
    const rows = await prisma.blocklistEntry.findMany({
      where: { settingsId: s.id },
      orderBy: { createdAt: "desc" },
    });
    for (const r of rows) {
      entries.push({
        id: r.id,
        type: r.type,
        value: r.value,
        reason: r.reason,
        blockedBy: r.blockedBy,
        createdAt: r.createdAt.toISOString(),
      });
    }
  }

  return {
    blocklistEnabled: s?.blocklistEnabled ?? false,
    entries,
    shopLocale: s?.shopLocale ?? "en",
    shopTimezone: s?.shopTimezone ?? "UTC",
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = formData.get("intent") as string;
  const shop = await findOrCreateShop(session.shop);

  const settings = await prisma.shopSettings.upsert({
    where: { shopId: shop.id },
    create: { shopId: shop.id },
    update: {},
  });

  if (intent === "toggle") {
    const enabled = formData.get("blocklistEnabled") === "on";
    await prisma.shopSettings.update({
      where: { id: settings.id },
      data: { blocklistEnabled: enabled },
    });
    return { success: true };
  }

  if (intent === "add") {
    const type = (formData.get("type") as string || "").trim();
    const value = (formData.get("value") as string || "").trim().toLowerCase();
    const reason = (formData.get("reason") as string || "").trim() || null;

    if (!["email", "phone", "order_name", "ip"].includes(type)) {
      return { error: "Invalid entry type" };
    }
    if (!value || value.length > 256) {
      return { error: "Value is required (max 256 characters)" };
    }

    const existing = await prisma.blocklistEntry.findUnique({
      where: { settingsId_type_value: { settingsId: settings.id, type, value } },
    });
    if (existing) {
      return { error: "This entry already exists in the blocklist" };
    }

    await prisma.blocklistEntry.create({
      data: {
        settingsId: settings.id,
        type,
        value,
        reason,
        blockedBy: session.onlineAccessInfo?.associated_user?.email ?? session.shop,
      },
    });
    return { success: true };
  }

  if (intent === "delete") {
    const entryId = formData.get("entryId") as string;
    if (entryId) {
      await prisma.blocklistEntry.deleteMany({
        where: { id: entryId, settingsId: settings.id },
      });
    }
    return { success: true };
  }

  return { error: "Unknown action" };
};

const TYPE_LABELS: Record<string, string> = {
  email: "Email",
  phone: "Phone",
  order_name: "Order Name",
  ip: "IP Address",
};

export default function BlocklistSettings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const [type, setType] = React.useState("email");
  const [value, setValue] = React.useState("");
  const [reason, setReason] = React.useState("");

  const isSubmitting = fetcher.state !== "idle";

  React.useEffect(() => {
    if (fetcher.data?.success && fetcher.formData?.get("intent") === "add") {
      setValue("");
      setReason("");
    }
  }, [fetcher.data, fetcher.formData]);

  return (
    <s-page heading="Customer Blocklist">
      <div className="app-content">
        {fetcher.data?.success && (
          <div className="app-alert app-alert-success" style={{ marginBottom: 16 }}>
            {fetcher.formData?.get("intent") === "toggle" ? "Blocklist setting updated." :
             fetcher.formData?.get("intent") === "delete" ? "Entry removed from blocklist." :
             "Entry added to blocklist."}
          </div>
        )}
        {fetcher.data?.error && (
          <div className="app-alert app-alert-error" style={{ marginBottom: 16 }}>{fetcher.data.error}</div>
        )}

        <div className="layout-medium" style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          {/* Enable/Disable Toggle */}
          <s-section>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Blocklist enforcement</div>
                <p style={{ fontSize: 13, color: "#6d7175", margin: 0 }}>
                  When enabled, return requests from blocked customers will be automatically rejected.
                  The customer will see a generic error without revealing they are blocked.
                </p>
              </div>
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="toggle" />
                <input type="hidden" name="blocklistEnabled" value={data.blocklistEnabled ? "off" : "on"} />
                <s-button type="submit" variant={data.blocklistEnabled ? "primary" : "secondary"} disabled={isSubmitting}>
                  {data.blocklistEnabled ? "Enabled" : "Disabled"}
                </s-button>
              </fetcher.Form>
            </div>
          </s-section>

          {/* Add New Entry */}
          <s-section>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Add to blocklist</div>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 16 }}>
              Block specific customers by email, phone number, order name, or IP address.
            </p>
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="add" />
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
                <div>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#6d7175", marginBottom: 4 }}>Type</label>
                  <select
                    name="type"
                    value={type}
                    onChange={(e) => setType(e.target.value)}
                    style={{ padding: "9px 12px", borderRadius: "var(--rpm-radius-sm, 8px)", border: "var(--rpm-border, 1px solid #e1e3e5)", fontSize: 13, minWidth: 140, background: "var(--rpm-surface, #fff)", color: "var(--rpm-text, #0f172a)" }}
                  >
                    <option value="email">Email</option>
                    <option value="phone">Phone</option>
                    <option value="order_name">Order Name</option>
                    <option value="ip">IP Address</option>
                  </select>
                </div>
                <div style={{ flex: 1, minWidth: 200 }}>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#6d7175", marginBottom: 4 }}>Value</label>
                  <input
                    type="text"
                    name="value"
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder={type === "email" ? "customer@example.com" : type === "phone" ? "+1234567890" : type === "order_name" ? "#1234" : "192.168.1.1"}
                    style={{ width: "100%", padding: "9px 12px", borderRadius: "var(--rpm-radius-sm, 8px)", border: "var(--rpm-border, 1px solid #e1e3e5)", fontSize: 13, boxSizing: "border-box", background: "var(--rpm-surface, #fff)", color: "var(--rpm-text, #0f172a)" }}
                    required
                  />
                </div>
                <div style={{ flex: 1, minWidth: 160 }}>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#6d7175", marginBottom: 4 }}>Reason (optional)</label>
                  <input
                    type="text"
                    name="reason"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="e.g. Suspected fraud"
                    style={{ width: "100%", padding: "9px 12px", borderRadius: "var(--rpm-radius-sm, 8px)", border: "var(--rpm-border, 1px solid #e1e3e5)", fontSize: 13, boxSizing: "border-box", background: "var(--rpm-surface, #fff)", color: "var(--rpm-text, #0f172a)" }}
                  />
                </div>
                <s-button type="submit" variant="primary" disabled={isSubmitting || !value.trim()}>Add</s-button>
              </div>
            </fetcher.Form>
          </s-section>

          {/* Blocklist Table */}
          <s-section>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Blocked entries ({data.entries.length})</div>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 16 }}>
              Customers matching any of these entries will be unable to submit return requests.
            </p>
            {data.entries.length === 0 ? (
              <div style={{ padding: 32, textAlign: "center", color: "#9CA3AF", fontSize: 14, background: "#F9FAFB", borderRadius: 10, border: "1px solid #F3F4F6" }}>
                No entries in the blocklist yet. Add one above to get started.
              </div>
            ) : (
              <div style={{ border: "1px solid #e1e3e5", borderRadius: 10, overflow: "hidden" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "#F9FAFB" }}>
                      <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600, fontSize: 11, color: "#6d7175", textTransform: "uppercase", letterSpacing: "0.05em" }}>Type</th>
                      <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600, fontSize: 11, color: "#6d7175", textTransform: "uppercase", letterSpacing: "0.05em" }}>Value</th>
                      <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600, fontSize: 11, color: "#6d7175", textTransform: "uppercase", letterSpacing: "0.05em" }}>Reason</th>
                      <th style={{ textAlign: "left", padding: "10px 14px", fontWeight: 600, fontSize: 11, color: "#6d7175", textTransform: "uppercase", letterSpacing: "0.05em" }}>Added</th>
                      <th style={{ textAlign: "right", padding: "10px 14px", fontWeight: 600, fontSize: 11, color: "#6d7175" }}></th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.entries.map((entry) => (
                      <tr key={entry.id} style={{ borderTop: "1px solid #F3F4F6" }}>
                        <td style={{ padding: "10px 14px" }}>
                          <span style={{
                            display: "inline-block", padding: "2px 8px", borderRadius: 5, fontSize: 11, fontWeight: 600,
                            background: entry.type === "email" ? "#EFF6FF" : entry.type === "phone" ? "#F0FDF4" : entry.type === "order_name" ? "#FFFBEB" : "#F5F3FF",
                            color: entry.type === "email" ? "#1E40AF" : entry.type === "phone" ? "#166534" : entry.type === "order_name" ? "#92400E" : "#6D28D9",
                          }}>
                            {TYPE_LABELS[entry.type] || entry.type}
                          </span>
                        </td>
                        <td style={{ padding: "10px 14px", fontFamily: "monospace", fontSize: 12 }}>{entry.value}</td>
                        <td style={{ padding: "10px 14px", color: entry.reason ? "#374151" : "#9CA3AF" }}>{entry.reason || "--"}</td>
                        <td style={{ padding: "10px 14px", color: "#6d7175", fontSize: 12 }}>
                          {new Intl.DateTimeFormat(data.shopLocale || "en", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(entry.createdAt))}
                        </td>
                        <td style={{ padding: "10px 14px", textAlign: "right" }}>
                          <fetcher.Form method="post" style={{ display: "inline" }}>
                            <input type="hidden" name="intent" value="delete" />
                            <input type="hidden" name="entryId" value={entry.id} />
                            <button
                              type="submit"
                              disabled={isSubmitting}
                              style={{
                                background: "none", border: "1px solid #FECACA", borderRadius: 6,
                                padding: "4px 10px", cursor: "pointer", color: "#DC2626", fontSize: 12,
                                fontWeight: 500, transition: "all 0.15s",
                              }}
                            >
                              Remove
                            </button>
                          </fetcher.Form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </s-section>
        </div>

        <div className="app-actions">
          <Link to="/app/settings">
            <s-button variant="secondary" type="button">Back to Settings</s-button>
          </Link>
        </div>
      </div>
    </s-page>
  );
}
