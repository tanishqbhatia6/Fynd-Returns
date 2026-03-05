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

export default function Widget() {
  const { portalTheme, portalConfig, fontOptions, portalUrl, portalLanguage, portalLabelOverrides, labelKeys, supportedLanguages } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ success?: boolean }>();
  const [labelOverrides, setLabelOverrides] = useState<Record<string, string>>(portalLabelOverrides);
  const [showCustomLabels, setShowCustomLabels] = useState(Object.keys(portalLabelOverrides).length > 0);

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
            <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 16 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                <input type="checkbox" name="showOrderTracking" defaultChecked={portalConfig.showOrderTracking} />
                <span><strong>Order tracking</strong> — Show &quot;Your orders&quot; after lookup (by email)</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                <input type="checkbox" name="showReturnTracking" defaultChecked={portalConfig.showReturnTracking} />
                <span><strong>Return tracking</strong> — Show &quot;Your returns&quot; after lookup</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                <input type="checkbox" name="showCreateReturnTab" defaultChecked={portalConfig.showCreateReturnTab} />
                <span><strong>Create return</strong> — Tab to start a new return request</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer", marginTop: 8 }}>
                <input type="checkbox" name="allowMediaUploads" defaultChecked={portalConfig.allowMediaUploads} />
                <span><strong>Allow media uploads</strong> — Let customers attach images/videos to return requests</span>
              </label>
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
