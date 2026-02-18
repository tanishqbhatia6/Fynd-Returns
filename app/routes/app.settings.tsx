import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { encrypt } from "../lib/encryption.server";
import { parsePortalTheme, DEFAULT_PORTAL_THEME, FONT_OPTIONS } from "../lib/portal-theme.server";

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

  const s = shop.settings;
  const portalTheme = parsePortalTheme(s?.portalThemeJson);
  const returnReasons = s?.returnReasonsJson ? (() => { try { return JSON.parse(s.returnReasonsJson); } catch { return []; } })() : [];
  return {
    settings: {
      fyndCompanyId: s?.fyndCompanyId || "",
      fyndApplicationId: s?.fyndApplicationId || "",
      fyndCredentials: s?.fyndCredentials ? "[encrypted]" : "",
      policyJson: s?.policyJson || "{}",
      returnWindowDays: s?.returnWindowDays ?? 30,
      returnPolicyText: s?.returnPolicyText || "",
      returnReasonsJson: Array.isArray(returnReasons) ? JSON.stringify(returnReasons, null, 2) : "[]",
      autoApproveEnabled: s?.autoApproveEnabled ?? false,
    },
    portalTheme,
    fontOptions: FONT_OPTIONS,
    portalUrl: `https://${session.shop}/apps/returns`,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const fyndCompanyId = String(formData.get("fyndCompanyId") ?? "").trim();
  const fyndApplicationId = String(formData.get("fyndApplicationId") ?? "").trim();
  const fyndCredentials = formData.get("fyndCredentials") as string | null;
  const policyJson = String(formData.get("policyJson") ?? "{}").trim();
  const returnWindowDays = parseInt(String(formData.get("returnWindowDays") ?? "30"), 10) || 30;
  const returnPolicyText = String(formData.get("returnPolicyText") ?? "").trim();
  const returnReasonsJson = String(formData.get("returnReasonsJson") ?? "[]").trim();
  const autoApproveEnabled = formData.get("autoApproveEnabled") === "on";
  const portalThemeJson = (() => {
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
    if (primaryColor || backgroundColor || fontFamily) {
      return JSON.stringify({
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
    return "";
  })();

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

  let credsToStore = shop.settings?.fyndCredentials;
  if (fyndCredentials && fyndCredentials !== "[encrypted]") {
    credsToStore = encrypt(JSON.stringify({ accessToken: fyndCredentials }));
  }

  let portalThemeToStore: string | null = null;
  if (portalThemeJson) {
    try {
      JSON.parse(portalThemeJson);
      portalThemeToStore = portalThemeJson;
    } catch {
      portalThemeToStore = null;
    }
  }

  try {
    await prisma.shopSettings.upsert({
    where: { shopId: shop.id },
    create: {
      shopId: shop.id,
      fyndCompanyId: fyndCompanyId || null,
      fyndApplicationId: fyndApplicationId || null,
      fyndCredentials: credsToStore,
      policyJson: policyJson || null,
      portalThemeJson: portalThemeToStore,
      returnWindowDays,
      returnPolicyText: returnPolicyText || null,
      returnReasonsJson: returnReasonsJson || null,
      autoApproveEnabled,
    },
    update: {
      fyndCompanyId: fyndCompanyId || undefined,
      fyndApplicationId: fyndApplicationId || undefined,
      fyndCredentials: credsToStore ?? undefined,
      policyJson: policyJson || undefined,
      portalThemeJson: portalThemeToStore ?? undefined,
      returnWindowDays,
      returnPolicyText: returnPolicyText || undefined,
      returnReasonsJson: returnReasonsJson || undefined,
      autoApproveEnabled,
    },
  });
  } catch (err) {
    console.error("Settings save error:", err);
    return { success: false, error: "Failed to save settings" };
  }

  return { success: true };
};

export default function Settings() {
  const { settings, portalTheme, fontOptions, portalUrl } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const error = fetcher.data && "error" in fetcher.data ? fetcher.data.error : null;
  const success = fetcher.data && "success" in fetcher.data && fetcher.data.success;

  return (
    <s-page heading="Settings">
      {error && (
        <s-section><p style={{ color: "#d72c0d", marginBottom: 16 }}>{error}</p></s-section>
      )}
      {success && (
        <s-section><p style={{ color: "#008060", marginBottom: 16 }}>Settings saved successfully.</p></s-section>
      )}
      <fetcher.Form method="post">
        <s-section heading="Fynd integration">
          <s-text-field
            name="fyndCompanyId"
            label="Fynd Company ID"
            value={settings.fyndCompanyId}
          />
          <s-text-field
            name="fyndApplicationId"
            label="Fynd Application ID"
            value={settings.fyndApplicationId}
          />
          <s-text-field
            name="fyndCredentials"
            label="Fynd Access Token"
            type="password"
            value={settings.fyndCredentials === "[encrypted]" ? "" : settings.fyndCredentials}
            details="Leave blank to keep existing"
          />
          <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>Policy (JSON)</label>
          <textarea name="policyJson" rows={4} defaultValue={settings.policyJson} style={{ width: "100%", marginBottom: 16, padding: 12, borderRadius: 8, border: "1px solid #e1e3e5" }} />
        </s-section>

        <s-section heading="Return policy">
          <p style={{ marginBottom: 16, color: "#6d7175" }}>
            Configure return eligibility and rules for your store.
          </p>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>Return window (days)</label>
            <input
              type="number"
              name="returnWindowDays"
              defaultValue={settings.returnWindowDays}
              min={1}
              max={365}
              style={{ width: 120, padding: 10, borderRadius: 6, border: "1px solid #e1e3e5" }}
            />
            <p style={{ fontSize: 13, color: "#6d7175", marginTop: 4 }}>Customers can initiate returns within this many days after delivery.</p>
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>Return policy text</label>
            <textarea
              name="returnPolicyText"
              defaultValue={settings.returnPolicyText}
              rows={4}
              placeholder="e.g. We accept returns within 30 days for unused items..."
              style={{ width: "100%", padding: 12, borderRadius: 8, border: "1px solid #e1e3e5" }}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>Return reasons (JSON array)</label>
            <textarea
              name="returnReasonsJson"
              defaultValue={settings.returnReasonsJson}
              rows={6}
              placeholder='["Damaged", "Wrong item", "Changed mind", "Not as described"]'
              style={{ width: "100%", padding: 12, borderRadius: 8, border: "1px solid #e1e3e5", fontFamily: "monospace", fontSize: 13 }}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input type="checkbox" name="autoApproveEnabled" defaultChecked={settings.autoApproveEnabled} />
              <span>Auto-approve returns (requires Fynd integration)</span>
            </label>
          </div>
        </s-section>

        <s-section heading="Portal theme">
        <p style={{ marginBottom: 20, color: "#6d7175" }}>
          Customize the look and feel of your customer returns portal. Changes apply immediately.
        </p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 20, marginBottom: 20 }}>
          <div>
            <label style={{ display: "block", marginBottom: 8, fontWeight: 600, fontSize: 14 }}>Primary color</label>
            <input type="color" name="primaryColor" defaultValue={portalTheme.primaryColor} style={{ width: "100%", height: 40, padding: 4, cursor: "pointer", borderRadius: 6, border: "1px solid #e1e3e5" }} />
          </div>
          <div>
            <label style={{ display: "block", marginBottom: 8, fontWeight: 600, fontSize: 14 }}>Background</label>
            <input type="color" name="backgroundColor" defaultValue={portalTheme.backgroundColor} style={{ width: "100%", height: 40, padding: 4, cursor: "pointer", borderRadius: 6, border: "1px solid #e1e3e5" }} />
          </div>
          <div>
            <label style={{ display: "block", marginBottom: 8, fontWeight: 600, fontSize: 14 }}>Card surface</label>
            <input type="color" name="surfaceColor" defaultValue={portalTheme.surfaceColor} style={{ width: "100%", height: 40, padding: 4, cursor: "pointer", borderRadius: 6, border: "1px solid #e1e3e5" }} />
          </div>
          <div>
            <label style={{ display: "block", marginBottom: 8, fontWeight: 600, fontSize: 14 }}>Font</label>
            <select name="fontFamily" defaultValue={portalTheme.fontFamily} style={{ width: "100%", padding: 10, borderRadius: 6, border: "1px solid #e1e3e5", fontSize: 14 }}>
              {fontOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label style={{ display: "block", marginBottom: 8, fontWeight: 600, fontSize: 14 }}>Border radius</label>
            <select name="borderRadius" defaultValue={portalTheme.borderRadius} style={{ width: "100%", padding: 10, borderRadius: 6, border: "1px solid #e1e3e5", fontSize: 14 }}>
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
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <s-button type="submit" loading={fetcher.state !== "idle"}>
            Save all settings
          </s-button>
          <a href={portalUrl} target="_blank" rel="noopener noreferrer">
            <s-button variant="secondary">Preview portal</s-button>
          </a>
        </div>
        </s-section>
      </fetcher.Form>
    </s-page>
  );
}
