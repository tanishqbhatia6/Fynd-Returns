import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher } from "react-router";
import React, { useState } from "react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { parsePortalTheme, DEFAULT_PORTAL_THEME, FONT_OPTIONS } from "../lib/portal-theme.server";
import { parsePortalConfig } from "../lib/portal-config.server";
import { findOrCreateShop } from "../lib/shop.server";
import { SUPPORTED_LANGUAGES, DEFAULT_LABELS, getPortalLabels } from "../lib/portal-i18n";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop);
  const theme = parsePortalTheme(shop.settings?.portalThemeJson);
  const portalConfig = parsePortalConfig(shop.settings?.portalConfigJson);
  const portalLanguage = shop.settings?.portalLanguage ?? "en";
  let portalLabelOverrides: Record<string, string> = {};
  try {
    if (shop.settings?.portalLabelsJson) portalLabelOverrides = JSON.parse(shop.settings.portalLabelsJson);
  } catch { /* ignore */ }
  const resolvedLabels = getPortalLabels(portalLanguage, portalLabelOverrides);
  const labelKeys = Object.keys(DEFAULT_LABELS);
  return {
    portalTheme: theme, portalConfig, fontOptions: FONT_OPTIONS,
    portalUrl: `https://${session.shop}/apps/returns`,
    portalLanguage, portalLabelOverrides, resolvedLabels, labelKeys,
    supportedLanguages: SUPPORTED_LANGUAGES,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const primaryColor = formData.get("primaryColor");
  const primaryHoverColor = formData.get("primaryHoverColor");
  const backgroundColor = formData.get("backgroundColor");
  const surfaceColor = formData.get("surfaceColor");
  const textColor = formData.get("textColor");
  const textMutedColor = formData.get("textMutedColor");
  const borderColor = formData.get("borderColor");
  const fontFamily = formData.get("fontFamily");
  const borderRadius = formData.get("borderRadius");
  const shadow = formData.get("shadow");

  const showOrderTracking = formData.get("showOrderTracking") === "on";
  const showReturnTracking = formData.get("showReturnTracking") === "on";
  const showCreateReturnTab = formData.get("showCreateReturnTab") === "on";
  const allowMediaUploads = formData.get("allowMediaUploads") === "on";
  const defaultTab = (formData.get("defaultTab") as string) || "return";
  const portalConfigJson = JSON.stringify({
    showOrderTracking,
    showReturnTracking,
    showCreateReturnTab,
    allowMediaUploads,
    defaultTab: ["order", "return", "create"].includes(defaultTab) ? defaultTab : "return",
  });

  let portalThemeJson: string | null = null;
  if (primaryColor || backgroundColor || fontFamily) {
    portalThemeJson = JSON.stringify({
      primaryColor: primaryColor || DEFAULT_PORTAL_THEME.primaryColor,
      primaryHoverColor: primaryHoverColor || DEFAULT_PORTAL_THEME.primaryHoverColor,
      backgroundColor: backgroundColor || DEFAULT_PORTAL_THEME.backgroundColor,
      surfaceColor: surfaceColor || DEFAULT_PORTAL_THEME.surfaceColor,
      textColor: textColor || DEFAULT_PORTAL_THEME.textColor,
      textMutedColor: textMutedColor || DEFAULT_PORTAL_THEME.textMutedColor,
      borderColor: borderColor || DEFAULT_PORTAL_THEME.borderColor,
      fontFamily: fontFamily || DEFAULT_PORTAL_THEME.fontFamily,
      headingFont: fontFamily || DEFAULT_PORTAL_THEME.headingFont,
      borderRadius: borderRadius || DEFAULT_PORTAL_THEME.borderRadius,
      shadow: shadow || DEFAULT_PORTAL_THEME.shadow,
    });
  }

  const portalLanguage = (formData.get("portalLanguage") as string) || "en";
  const portalLabelsRaw = formData.get("portalLabelsJson") as string | null;
  let portalLabelsJson: string | null = null;
  if (portalLabelsRaw) {
    try {
      const parsed = JSON.parse(portalLabelsRaw);
      const filtered: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string" && v.trim()) filtered[k] = v.trim();
      }
      if (Object.keys(filtered).length > 0) portalLabelsJson = JSON.stringify(filtered);
    } catch { /* ignore invalid JSON */ }
  }

  const shop = await findOrCreateShop(session.shop);

  await prisma.shopSettings.upsert({
    where: { shopId: shop.id },
    create: { shopId: shop.id, portalThemeJson, portalConfigJson, portalLanguage, portalLabelsJson },
    update: {
      portalThemeJson: portalThemeJson ?? undefined,
      portalConfigJson,
      portalLanguage,
      portalLabelsJson,
    },
  });
  return { success: true };
};

function ToggleRow({ icon, title, description, checked, onChange, last }: {
  icon: React.ReactNode; title: string; description: string;
  checked: boolean; onChange: (v: boolean) => void; last?: boolean;
}) {
  return (
    <label style={{
      display: "flex", alignItems: "center", gap: 14, padding: "14px 16px",
      cursor: "pointer", background: checked ? "#f8fafc" : "#fff",
      borderBottom: last ? "none" : "1px solid #f1f3f5",
      transition: "background 0.15s",
    }}>
      <span style={{
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 36, height: 36, borderRadius: 8, flexShrink: 0,
        background: checked ? "#eef2ff" : "#f9fafb",
        transition: "background 0.15s",
      }}>
        {icon}
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span style={{ display: "block", fontSize: 13.5, fontWeight: 600, color: "#1e293b", lineHeight: 1.3 }}>{title}</span>
        <span style={{ display: "block", fontSize: 12.5, color: "#64748b", lineHeight: 1.4, marginTop: 1 }}>{description}</span>
      </span>
      <span style={{ position: "relative", display: "inline-block", width: 44, height: 24, flexShrink: 0 }}>
        <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)}
          style={{ position: "absolute", opacity: 0, width: 0, height: 0 }} />
        <span style={{
          position: "absolute", inset: 0, borderRadius: 12, transition: "all 0.15s",
          background: checked ? "#3B82F6" : "#cbd5e1",
        }}>
          <span style={{
            position: "absolute", left: checked ? 22 : 2, top: 2, width: 20, height: 20,
            borderRadius: 10, background: "#fff", transition: "all 0.15s",
            boxShadow: "0 1px 3px rgba(0,0,0,.15)",
          }} />
        </span>
      </span>
    </label>
  );
}

export default function Widget() {
  const { portalTheme, portalConfig, fontOptions, portalUrl, portalLanguage, portalLabelOverrides, labelKeys, supportedLanguages } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ success?: boolean }>();
  const [labelOverrides, setLabelOverrides] = useState<Record<string, string>>(portalLabelOverrides);
  const [showCustomLabels, setShowCustomLabels] = useState(Object.keys(portalLabelOverrides).length > 0);
  const [orderTracking, setOrderTracking] = useState(portalConfig.showOrderTracking);
  const [returnTracking, setReturnTracking] = useState(portalConfig.showReturnTracking);
  const [createReturn, setCreateReturn] = useState(portalConfig.showCreateReturnTab);
  const [mediaUploads, setMediaUploads] = useState(portalConfig.allowMediaUploads);

  return (
    <s-page heading="Assure Return Widget">
      <div className="app-content">
        {fetcher.data && "success" in fetcher.data && (
          <div className="app-alert app-alert-success">Settings saved successfully.</div>
        )}

        <fetcher.Form method="post">
          <input type="hidden" name="portalLabelsJson" value={JSON.stringify(labelOverrides)} />
          <p style={{ marginBottom: 24, color: "#6d7175", fontSize: 14 }}>
            Manage your return portal. Choose which sections to show and customize the look and feel.
          </p>
          <s-section heading="Portal sections (what customers see)">
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 16 }}>
              Control which pages and tabs appear on the customer portal. Order tracking shows Shopify orders (by email lookup); return tracking shows returns; create return lets customers start a new return.
            </p>
            {orderTracking && <input type="hidden" name="showOrderTracking" value="on" />}
            {returnTracking && <input type="hidden" name="showReturnTracking" value="on" />}
            {createReturn && <input type="hidden" name="showCreateReturnTab" value="on" />}
            {mediaUploads && <input type="hidden" name="allowMediaUploads" value="on" />}
            <div style={{ display: "flex", flexDirection: "column", borderRadius: 10, border: "1px solid #e5e7eb", overflow: "hidden", marginBottom: 16 }}>
              <ToggleRow
                icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#6366f1" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M21 8V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h5" /><polyline points="16 2 16 6" /><polyline points="8 2 8 6" /><rect x="14" y="14" width="8" height="8" rx="1.5" /><path d="M18 14v3" /><path d="M18 20v.01" /></svg>}
                title="Order tracking"
                description={'Show "Your orders" after lookup (by email)'}
                checked={orderTracking}
                onChange={setOrderTracking}
              />
              <ToggleRow
                icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#0ea5e9" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><polyline points="1 4 1 10 7 10" /><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" /></svg>}
                title="Return tracking"
                description={'Show "Your returns" after lookup'}
                checked={returnTracking}
                onChange={setReturnTracking}
              />
              <ToggleRow
                icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#10b981" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" y1="8" x2="12" y2="16" /><line x1="8" y1="12" x2="16" y2="12" /></svg>}
                title="Create return"
                description="Tab to start a new return request"
                checked={createReturn}
                onChange={setCreateReturn}
              />
              <ToggleRow
                icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></svg>}
                title="Media uploads"
                description="Let customers attach images/videos to return requests"
                checked={mediaUploads}
                onChange={setMediaUploads}
                last
              />
            </div>
            <div className="app-field">
              <label>Default tab when portal opens</label>
              <select name="defaultTab" defaultValue={portalConfig.defaultTab} className="app-input">
                <option value="order">Order tracking</option>
                <option value="return">Return tracking</option>
                <option value="create">Create return</option>
              </select>
            </div>
          </s-section>
          <s-section heading="Portal language">
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 16 }}>
              Choose the language for your customer-facing portal. You can also override individual label text below.
            </p>
            <div className="app-field" style={{ marginBottom: 16 }}>
              <label>Language</label>
              <select name="portalLanguage" defaultValue={portalLanguage} className="app-input">
                {supportedLanguages.map((lang) => (
                  <option key={lang.code} value={lang.code}>{lang.label}</option>
                ))}
              </select>
            </div>
            <div style={{ marginBottom: 16 }}>
              <button type="button" onClick={() => setShowCustomLabels(!showCustomLabels)} style={{
                background: "none", border: "none", padding: 0, cursor: "pointer",
                fontSize: 13, fontWeight: 600, color: "#2563EB",
              }}>
                {showCustomLabels ? "Hide custom labels" : "Customize label text"}
              </button>
            </div>
            {showCustomLabels && (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ fontSize: 12, color: "#6d7175", marginBottom: 4 }}>
                  Override any label key with custom text. Leave blank to use the default translation.
                </div>
                {labelKeys.map((key) => (
                  <div key={key} style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 8, alignItems: "center" }}>
                    <label style={{ fontSize: 11, fontFamily: "monospace", color: "#6B7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={key}>{key}</label>
                    <input
                      type="text"
                      placeholder={DEFAULT_LABELS[key]}
                      value={labelOverrides[key] ?? ""}
                      onChange={(e) => {
                        setLabelOverrides((prev) => {
                          const next = { ...prev };
                          if (e.target.value.trim()) next[key] = e.target.value;
                          else delete next[key];
                          return next;
                        });
                      }}
                      className="app-input"
                      style={{ fontSize: 12, padding: "4px 8px" }}
                    />
                  </div>
                ))}
              </div>
            )}
          </s-section>
          <s-section heading="Portal theme">
            <div className="app-grid" style={{ marginBottom: 20 }}>
              <div className="app-field">
                <label>Primary color</label>
                <input type="color" name="primaryColor" defaultValue={portalTheme.primaryColor} style={{ width: "100%", maxWidth: 120, height: 40, padding: 4, cursor: "pointer", borderRadius: 6, border: "1px solid #e1e3e5", boxSizing: "border-box" }} />
              </div>
              <div className="app-field">
                <label>Background</label>
                <input type="color" name="backgroundColor" defaultValue={portalTheme.backgroundColor} style={{ width: "100%", maxWidth: 120, height: 40, padding: 4, cursor: "pointer", borderRadius: 6, border: "1px solid #e1e3e5", boxSizing: "border-box" }} />
              </div>
              <div className="app-field">
                <label>Card surface</label>
                <input type="color" name="surfaceColor" defaultValue={portalTheme.surfaceColor} style={{ width: "100%", maxWidth: 120, height: 40, padding: 4, cursor: "pointer", borderRadius: 6, border: "1px solid #e1e3e5", boxSizing: "border-box" }} />
              </div>
              <div className="app-field">
                <label>Font</label>
                <select name="fontFamily" defaultValue={portalTheme.fontFamily} className="app-input">
                  {fontOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
              </div>
              <div className="app-field">
                <label>Border radius</label>
                <select name="borderRadius" defaultValue={portalTheme.borderRadius} className="app-input">
                  <option value="8px">Minimal (8px)</option>
                  <option value="12px">Rounded (12px)</option>
                  <option value="16px">Soft (16px)</option>
                  <option value="24px">Pill (24px)</option>
                </select>
              </div>
            </div>
            <input type="hidden" name="primaryHoverColor" value={portalTheme.primaryHoverColor} />
            <input type="hidden" name="textColor" value={portalTheme.textColor} />
            <input type="hidden" name="textMutedColor" value={portalTheme.textMutedColor} />
            <input type="hidden" name="borderColor" value={portalTheme.borderColor} />
            <input type="hidden" name="shadow" value={portalTheme.shadow} />
          </s-section>
          <div className="app-actions">
            <s-button type="submit" loading={fetcher.state !== "idle"}>Save</s-button>
            <Link to="/app/settings">
              <s-button variant="secondary" type="button">Discard</s-button>
            </Link>
            <a href={portalUrl} target="_blank" rel="noopener noreferrer">
              <s-button variant="secondary" type="button">Preview portal</s-button>
            </a>
          </div>
        </fetcher.Form>
      </div>
    </s-page>
  );
}
