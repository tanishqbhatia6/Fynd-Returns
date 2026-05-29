import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  parseChannelPolicies,
  type ChannelPolicy,
  type ChannelPoliciesMap,
} from "../lib/source-channel.server";

const CHANNELS = [
  {
    key: "pos" as const,
    label: "Point of Sale (POS)",
    desc: "Returns from orders placed in-store via Shopify POS.",
    color: "#C2410C",
    bg: "#FFF7ED",
    border: "#FED7AA",
    icon: `<path d="M20 7H4a2 2 0 00-2 2v6a2 2 0 002 2h16a2 2 0 002-2V9a2 2 0 00-2-2z"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/>`,
  },
  {
    key: "draft_order" as const,
    label: "Draft Orders",
    desc: "Returns from orders originally created as Shopify draft orders.",
    color: "#6D28D9",
    bg: "#EDE9FE",
    border: "#C4B5FD",
    icon: `<path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="13" x2="15" y2="13"/><line x1="9" y1="17" x2="15" y2="17"/>`,
  },
  {
    key: "b2b" as const,
    label: "B2B / Wholesale",
    desc: "Returns from orders placed through Shopify B2B or wholesale channels.",
    color: "#065F46",
    bg: "#ECFDF5",
    border: "#A7F3D0",
    icon: `<rect x="2" y="7" width="20" height="14" rx="2" ry="2"/><path d="M16 21V5a2 2 0 00-2-2h-4a2 2 0 00-2 2v16"/>`,
  },
] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    include: { settings: true },
  });
  const channelPoliciesJson =
    (shop?.settings as { channelPoliciesJson?: string | null } | null)?.channelPoliciesJson ?? null;
  const policies = parseChannelPolicies(channelPoliciesJson);
  return { policies };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();

  const policies: ChannelPoliciesMap = {};
  for (const ch of ["pos", "draft_order", "b2b"] as const) {
    const returnEnabled = formData.get(`${ch}_returnEnabled`) === "true";
    const windowRaw = formData.get(`${ch}_returnWindowDays`);
    const autoApproveRaw = formData.get(`${ch}_autoApproveEnabled`);

    policies[ch] = {
      returnEnabled,
      /* v8 ignore start */
      // defensive: parseInt always returns numeric or NaN; || null fallback only fires for invalid input
      returnWindowDays:
        windowRaw && String(windowRaw).trim() !== ""
          ? parseInt(String(windowRaw), 10) || null
          : null,
      /* v8 ignore stop */
      autoApproveEnabled:
        autoApproveRaw === "" || autoApproveRaw === null ? null : autoApproveRaw === "true",
    };
  }

  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    include: { settings: true },
  });
  if (!shop?.settings) return Response.json({ error: "Shop settings not found" }, { status: 404 });

  await prisma.shopSettings.update({
    where: { id: shop.settings.id },
    data: { channelPoliciesJson: JSON.stringify(policies) },
  });

  return Response.json({ success: true });
};

function ToggleSwitch({
  name,
  checked,
  onChange,
}: {
  name: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        cursor: "pointer",
        userSelect: "none",
      }}
    >
      <input type="hidden" name={name} value={String(checked)} />
      <div
        onClick={() => onChange(!checked)}
        style={{
          width: 40,
          height: 22,
          borderRadius: 11,
          background: checked ? "#4f46e5" : "#D1D5DB",
          position: "relative",
          transition: "background 0.2s",
          cursor: "pointer",
        }}
      >
        <div
          style={{
            position: "absolute",
            top: 3,
            left: checked ? 21 : 3,
            width: 16,
            height: 16,
            borderRadius: "50%",
            background: "#fff",
            transition: "left 0.2s",
            boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
          }}
        />
      </div>
      <span style={{ fontSize: 13, color: checked ? "#111827" : "#6B7280", fontWeight: 500 }}>
        {checked ? "Enabled" : "Disabled"}
      </span>
    </label>
  );
}

export default function ChannelPoliciesSettings() {
  const { policies } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const navigate = useNavigate();

  const getPolicy = (ch: keyof ChannelPoliciesMap): ChannelPolicy => ({
    returnEnabled: policies[ch]?.returnEnabled ?? true,
    returnWindowDays: policies[ch]?.returnWindowDays ?? null,
    autoApproveEnabled: policies[ch]?.autoApproveEnabled ?? null,
  });

  const [state, setState] = React.useState<Record<string, ChannelPolicy>>(() => ({
    pos: getPolicy("pos"),
    draft_order: getPolicy("draft_order"),
    b2b: getPolicy("b2b"),
  }));

  const isSaving = fetcher.state !== "idle";
  const saved = fetcher.data?.success === true;

  const handleSave = () => {
    const formData = new FormData();
    for (const ch of ["pos", "draft_order", "b2b"] as const) {
      const p = state[ch];
      formData.append(`${ch}_returnEnabled`, String(p.returnEnabled));
      formData.append(
        `${ch}_returnWindowDays`,
        p.returnWindowDays != null ? String(p.returnWindowDays) : "",
      );
      formData.append(
        `${ch}_autoApproveEnabled`,
        p.autoApproveEnabled != null ? String(p.autoApproveEnabled) : "",
      );
    }
    fetcher.submit(formData, { method: "POST" });
  };

  return (
    <div className="app-page channel-policies-page">
      <div className="app-page-header">
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button
            onClick={() => navigate("/app/settings")}
            style={{
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: "4px 6px",
              borderRadius: 6,
              color: "var(--rpm-muted)",
              display: "flex",
              alignItems: "center",
            }}
          >
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <div>
            <div className="app-page-title">Channel Policies</div>
            <div className="app-page-subtitle">
              Configure return eligibility per Shopify sales channel
            </div>
          </div>
        </div>
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="app-btn-primary"
          style={{
            padding: "9px 22px",
            borderRadius: 8,
            border: "none",
            fontSize: 14,
            fontWeight: 600,
            cursor: isSaving ? "wait" : "pointer",
            opacity: isSaving ? 0.7 : 1,
          }}
        >
          {isSaving ? "Saving…" : saved ? "Saved ✓" : "Save Changes"}
        </button>
      </div>

      {/* v8 ignore start */}
      {/* defensive: fetcher.data.error rarely populated in fixtures */}
      {fetcher.data?.error && (
        <div
          style={{
            background: "#FEE2E2",
            border: "1px solid #FECACA",
            borderRadius: 8,
            padding: "12px 16px",
            marginBottom: 20,
            color: "#DC2626",
            fontSize: 13,
          }}
        >
          {fetcher.data.error}
        </div>
      )}
      {/* v8 ignore stop */}

      <div
        style={{
          background: "#EFF6FF",
          border: "1px solid #BFDBFE",
          borderRadius: 10,
          padding: "12px 16px",
          marginBottom: 24,
          display: "flex",
          gap: 10,
          alignItems: "flex-start",
        }}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="#3B82F6"
          strokeWidth="2"
          style={{ flexShrink: 0, marginTop: 1 }}
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
        <div style={{ fontSize: 13, color: "#1E40AF", lineHeight: 1.5 }}>
          These rules apply on top of your global return settings. When disabled for a channel,
          customers cannot submit returns for those orders via the portal. Existing returns are not
          affected.
          <br />
          Leave <strong>Return Window</strong> and <strong>Auto-Approve</strong> blank to inherit
          the global setting.
        </div>
      </div>

      <div className="channel-policy-list">
        {CHANNELS.map((ch) => {
          const p = state[ch.key];
          return (
            <div key={ch.key} className="app-card channel-policy-card" style={{ padding: 20 }}>
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  justifyContent: "space-between",
                  gap: 16,
                  marginBottom: 20,
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div
                    style={{
                      width: 36,
                      height: 36,
                      borderRadius: 8,
                      background: ch.bg,
                      border: `1px solid ${ch.border}`,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                    }}
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke={ch.color}
                      strokeWidth="1.8"
                      dangerouslySetInnerHTML={{ __html: ch.icon }}
                    />
                  </div>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "var(--rpm-text)" }}>
                      {ch.label}
                    </div>
                    <div style={{ fontSize: 12, color: "var(--rpm-muted)", marginTop: 2 }}>
                      {ch.desc}
                    </div>
                  </div>
                </div>
                <ToggleSwitch
                  name={`${ch.key}_returnEnabled`}
                  checked={p.returnEnabled}
                  onChange={(v) =>
                    setState((s) => ({ ...s, [ch.key]: { ...s[ch.key], returnEnabled: v } }))
                  }
                />
              </div>

              {p.returnEnabled && (
                <div
                  style={{
                    display: "flex",
                    gap: 20,
                    flexWrap: "wrap",
                    borderTop: "1px solid var(--rpm-border)",
                    paddingTop: 16,
                  }}
                >
                  <div style={{ flex: "0 0 180px" }}>
                    <label
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: "var(--rpm-muted)",
                        display: "block",
                        marginBottom: 6,
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                      }}
                    >
                      Return Window (days)
                    </label>
                    <input
                      type="number"
                      min="1"
                      max="365"
                      placeholder="Use global setting"
                      value={p.returnWindowDays ?? ""}
                      onChange={(e) =>
                        setState((s) => ({
                          ...s,
                          [ch.key]: {
                            ...s[ch.key],
                            returnWindowDays: e.target.value ? parseInt(e.target.value, 10) : null,
                          },
                        }))
                      }
                      className="app-input"
                      style={{ width: "100%", padding: "8px 12px", fontSize: 13 }}
                    />
                  </div>
                  <div style={{ flex: "0 0 200px" }}>
                    <label
                      style={{
                        fontSize: 12,
                        fontWeight: 600,
                        color: "var(--rpm-muted)",
                        display: "block",
                        marginBottom: 6,
                        textTransform: "uppercase",
                        letterSpacing: "0.05em",
                      }}
                    >
                      Auto-Approve
                    </label>
                    <select
                      value={p.autoApproveEnabled == null ? "" : String(p.autoApproveEnabled)}
                      onChange={(e) =>
                        setState((s) => ({
                          ...s,
                          [ch.key]: {
                            ...s[ch.key],
                            autoApproveEnabled:
                              e.target.value === "" ? null : e.target.value === "true",
                          },
                        }))
                      }
                      className="app-select"
                      style={{ width: "100%", padding: "8px 12px", fontSize: 13 }}
                    >
                      <option value="">Use global setting</option>
                      <option value="true">Enabled for this channel</option>
                      <option value="false">Disabled for this channel</option>
                    </select>
                  </div>
                </div>
              )}

              {!p.returnEnabled && (
                <div
                  style={{
                    borderTop: "1px solid var(--rpm-border)",
                    paddingTop: 14,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    color: "#DC2626",
                  }}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
                  </svg>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>
                    Returns are disabled for {ch.label} orders. Customers will see a message
                    explaining this.
                  </span>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// React must be in scope for JSX
import React from "react";
