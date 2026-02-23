import * as React from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { encrypt } from "../lib/encryption.server";
import { createFyndClientOrError, getNormalizedCredentialsFromRaw, testPlatformConnectionRaw } from "../lib/fynd.server";
import { createFyndLogger } from "../lib/fynd-logger.server";
import { FYND_ENVIRONMENTS, getAppMode } from "../lib/fynd-config.server";
import { sanitizeCredentialInputs } from "../lib/credential-validation.server";

export type PolicyFormValues = {
  returnWindowDays: number;
  allowExchange: boolean;
  minOrderValue: number;
  refundMethods: string[];
  defaultRefundMethod: string;
  excludedTags: string[];
  allowedCategories: string[];
  restockFeePercent: number;
};

const REFUND_METHOD_OPTIONS = [
  { value: "original_payment", label: "Original payment method" },
  { value: "store_credit", label: "Store credit" },
  { value: "exchange", label: "Exchange" },
];

function parsePolicyForForm(json: string | null | undefined): PolicyFormValues {
  const defaults: PolicyFormValues = {
    returnWindowDays: 30,
    allowExchange: false,
    minOrderValue: 0,
    refundMethods: ["original_payment", "store_credit"],
    defaultRefundMethod: "original_payment",
    excludedTags: [],
    allowedCategories: [],
    restockFeePercent: 0,
  };
  if (!json || !json.trim()) return defaults;
  try {
    const p = JSON.parse(json) as Record<string, unknown>;
    return {
      returnWindowDays: typeof p.returnWindowDays === "number" ? Math.max(1, Math.min(365, p.returnWindowDays)) : defaults.returnWindowDays,
      allowExchange: p.allowExchange === true,
      minOrderValue: typeof p.minOrderValue === "number" ? Math.max(0, p.minOrderValue) : defaults.minOrderValue,
      refundMethods: Array.isArray(p.refundMethods) ? p.refundMethods.filter((x): x is string => typeof x === "string" && REFUND_METHOD_OPTIONS.some((o) => o.value === x)) : defaults.refundMethods,
      defaultRefundMethod: typeof p.defaultRefundMethod === "string" && REFUND_METHOD_OPTIONS.some((o) => o.value === p.defaultRefundMethod) ? p.defaultRefundMethod : defaults.defaultRefundMethod,
      excludedTags: Array.isArray(p.excludedTags) ? p.excludedTags.filter((x): x is string => typeof x === "string") : defaults.excludedTags,
      allowedCategories: Array.isArray(p.allowedCategories) ? p.allowedCategories.filter((x): x is string => typeof x === "string") : defaults.allowedCategories,
      restockFeePercent: typeof p.restockFeePercent === "number" ? Math.max(0, Math.min(100, p.restockFeePercent)) : defaults.restockFeePercent,
    };
  } catch {
    return defaults;
  }
}

function buildPolicyJson(formData: FormData): string {
  const returnWindowDays = Math.min(365, Math.max(1, parseInt(String(formData.get("policyReturnWindowDays") ?? "30"), 10) || 30));
  const allowExchange = formData.get("policyAllowExchange") === "on";
  const minOrderValue = Math.max(0, parseFloat(String(formData.get("policyMinOrderValue") ?? "0")) || 0);
  const refundMethodsAll = formData.getAll("policyRefundMethods") as string[];
  const refundMethodsRaw = refundMethodsAll.length > 0 ? refundMethodsAll : String(formData.get("policyRefundMethods") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const refundMethods = refundMethodsRaw.length > 0 ? refundMethodsRaw.filter((v) => REFUND_METHOD_OPTIONS.some((o) => o.value === v)) : ["original_payment", "store_credit"];
  const defaultRefundMethod = String(formData.get("policyDefaultRefundMethod") ?? "original_payment");
  const excludedTags = String(formData.get("policyExcludedTags") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const allowedCategories = String(formData.get("policyAllowedCategories") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const restockFeePercent = Math.min(100, Math.max(0, parseFloat(String(formData.get("policyRestockFeePercent") ?? "0")) || 0));
  const obj: Record<string, unknown> = {
    returnWindowDays,
    allowExchange,
    minOrderValue: minOrderValue > 0 ? minOrderValue : undefined,
    refundMethods: refundMethods.length > 0 ? refundMethods : undefined,
    defaultRefundMethod: REFUND_METHOD_OPTIONS.some((o) => o.value === defaultRefundMethod) ? defaultRefundMethod : undefined,
    excludedTags: excludedTags.length > 0 ? excludedTags : undefined,
    allowedCategories: allowedCategories.length > 0 ? allowedCategories : undefined,
    restockFeePercent: restockFeePercent > 0 ? restockFeePercent : undefined,
  };
  return JSON.stringify(Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)));
}

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
  const normalized = getNormalizedCredentialsFromRaw(s?.fyndCredentials ?? null);
  const policy = parsePolicyForForm(s?.policyJson ?? null);
  return {
    fyndApiType: (s as { fyndApiType?: string })?.fyndApiType ?? "platform",
    fyndEnvironment: (s as { fyndEnvironment?: string })?.fyndEnvironment ?? "uat",
    policy,
    fyndCustomBaseUrl: (s as { fyndCustomBaseUrl?: string })?.fyndCustomBaseUrl ?? "",
    appMode: getAppMode(s ?? {}),
    fyndCompanyId: s?.fyndCompanyId ?? "",
    fyndApplicationId: s?.fyndApplicationId ?? "",
    fyndCredentials: s?.fyndCredentials ? "[configured]" : "",
    hasPlatformCreds: !!normalized?.platform,
    hasStorefrontCreds: !!normalized?.storefront,
    policyJson: s?.policyJson ?? "{}",
    fyndEnvironments: FYND_ENVIRONMENTS,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { logs, log } = createFyndLogger();
  try {
    const { session } = await authenticate.admin(request);
    const formData = await request.formData();
    const intent = formData.get("intent") as string | null;

    if (intent === "test_platform" || intent === "test_storefront" || intent === "test") {
      const fyndEnvironment = (formData.get("fyndEnvironment") as string) || "uat";
      const fyndCustomBaseUrl = String(formData.get("fyndCustomBaseUrl") ?? "").trim();
      const fyndCompanyId = String(formData.get("fyndCompanyId") ?? "").trim();
      const fyndApplicationId = String(formData.get("fyndApplicationId") ?? "").trim();
      const fyndClientId = String(formData.get("fyndClientId") ?? "").trim();
      const fyndClientSecret = String(formData.get("fyndClientSecret") ?? "").trim();
      const fyndApplicationToken = String(formData.get("fyndApplicationToken") ?? "").trim();

      let shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop }, include: { settings: true } });
      if (!shop) shop = await prisma.shop.create({ data: { shopDomain: session.shop }, include: { settings: true } });
      const stored = shop.settings;
      const existingNormalized = getNormalizedCredentialsFromRaw(stored?.fyndCredentials ?? null);

      const envSettings = { fyndEnvironment, fyndCustomBaseUrl: fyndCustomBaseUrl || null };
      const companyId = (fyndCompanyId || stored?.fyndCompanyId) ?? null;
      const applicationId = (fyndApplicationId || stored?.fyndApplicationId) ?? null;

      function buildCredsForTest(): string | null {
        const merged: Record<string, unknown> = {};
        if (fyndCompanyId && fyndClientId && fyndClientSecret) {
          merged.platform = { clientId: fyndClientId, clientSecret: fyndClientSecret };
        } else if (existingNormalized?.platform) {
          merged.platform = existingNormalized.platform;
        }
        if (Object.keys(merged).length === 0) return null;
        return encrypt(JSON.stringify(merged));
      }

      const creds = buildCredsForTest();
      if (!creds || !applicationId) {
        return { success: false, error: "Enter Application ID and Platform credentials (Company ID + Client ID & Secret), then Save or Test.", testResult: false, debugLogs: logs };
      }

      const requirePlatform = intent === "test_platform" || intent === "test" || intent === "test_storefront";

      if (requirePlatform) {
        const rawResult = await testPlatformConnectionRaw(
          { ...envSettings, fyndCompanyId: companyId, fyndApplicationId: applicationId, fyndCredentials: creds },
          log
        );
        if (rawResult.ok) {
          const msg = rawResult.warning
            ? `Platform API connection successful. ${rawResult.warning}`
            : "Platform API connection successful.";
          return { success: true, testResult: true, testMessage: msg, debugLogs: logs };
        }
        return { success: false, error: rawResult.error, testResult: false, debugLogs: logs };
      }

      if (requirePlatform) {
        const rawResult = await testPlatformConnectionRaw(
          { ...envSettings, fyndCompanyId: companyId, fyndApplicationId: applicationId, fyndCredentials: creds },
          log
        );
        if (rawResult.ok) {
          const msg = rawResult.warning
            ? `Platform API connection successful. ${rawResult.warning}`
            : "Platform API connection successful.";
          return { success: true, testResult: true, testMessage: msg, debugLogs: logs };
        }
        return { success: false, error: rawResult.error, testResult: false, debugLogs: logs };
      }
    }

    if (intent === "clear_token") {
      let shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
      if (!shop) shop = await prisma.shop.create({ data: { shopDomain: session.shop } });
      await prisma.shopSettings.upsert({
        where: { shopId: shop.id },
        create: { shopId: shop.id, fyndCredentials: null, fyndApiType: null },
        update: { fyndCredentials: null, fyndApiType: null },
      });
      return { success: true, cleared: true, debugLogs: logs };
    }

    // Save
    const fyndEnvironment = (formData.get("fyndEnvironment") as string) || "uat";
    const fyndCustomBaseUrl = String(formData.get("fyndCustomBaseUrl") ?? "").trim();
    const appMode = (formData.get("appMode") as string) || "prod";
    const fyndCompanyId = String(formData.get("fyndCompanyId") ?? "").trim();
    const fyndApplicationId = String(formData.get("fyndApplicationId") ?? "").trim();
    const fyndClientId = String(formData.get("fyndClientId") ?? "").trim();
    const fyndClientSecret = String(formData.get("fyndClientSecret") ?? "").trim();
    const fyndApplicationToken = String(formData.get("fyndApplicationToken") ?? "").trim();
    const policyJson = buildPolicyJson(formData);

    const validation = sanitizeCredentialInputs({
      fyndCompanyId: fyndCompanyId || undefined,
      fyndApplicationId: fyndApplicationId || undefined,
      fyndClientId: fyndClientId || undefined,
      fyndClientSecret: fyndClientSecret || undefined,
      fyndApplicationToken: fyndApplicationToken || undefined,
      fyndCustomBaseUrl: fyndCustomBaseUrl || undefined,
      policyJson: policyJson || undefined,
    });
    if (!validation.valid) {
      return { success: false, error: validation.error, debugLogs: logs };
    }
    const v = validation.sanitized!;

    let shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop }, include: { settings: true } });
    if (!shop) shop = await prisma.shop.create({ data: { shopDomain: session.shop }, include: { settings: true } });

    const existingNormalized = getNormalizedCredentialsFromRaw(shop.settings?.fyndCredentials ?? null);
    const merged: Record<string, unknown> = {};
    if (v.fyndCompanyId && v.fyndClientId && v.fyndClientSecret) {
      merged.platform = { clientId: v.fyndClientId, clientSecret: v.fyndClientSecret };
    } else if (existingNormalized?.platform) {
      merged.platform = existingNormalized.platform;
    }
    /* Platform only; Storefront API is not used */
    /* When we have existing credentials but can't parse them (e.g. decrypt fails), don't overwrite to avoid losing Platform creds */
    const hasExistingRaw = !!String(shop.settings?.fyndCredentials ?? "").trim();
    const credsToPersist =
      hasExistingRaw && existingNormalized === null
        ? (shop.settings?.fyndCredentials ?? null)
        : Object.keys(merged).length > 0
          ? encrypt(JSON.stringify(merged))
          : (shop.settings?.fyndCredentials ?? null);
    const fyndApiType = merged.platform ? "platform" : null;

    await prisma.shopSettings.upsert({
      where: { shopId: shop.id },
      create: {
        shopId: shop.id,
        fyndApiType: fyndApiType ?? null,
        fyndEnvironment: fyndEnvironment || null,
        fyndCustomBaseUrl: (v.fyndCustomBaseUrl || fyndCustomBaseUrl) || null,
        appMode: appMode === "dev" ? "dev" : "prod",
        fyndCompanyId: v.fyndCompanyId || null,
        fyndApplicationId: v.fyndApplicationId || null,
        fyndCredentials: credsToPersist,
        policyJson: (v.policyJson ?? policyJson) || null,
      },
      update: {
        fyndApiType: fyndApiType ?? undefined,
        fyndEnvironment: fyndEnvironment || undefined,
        fyndCustomBaseUrl: (v.fyndCustomBaseUrl || fyndCustomBaseUrl) || undefined,
        appMode: appMode === "dev" ? "dev" : "prod",
        fyndCompanyId: v.fyndCompanyId || undefined,
        fyndApplicationId: v.fyndApplicationId || undefined,
        fyndCredentials: credsToPersist ?? undefined,
        policyJson: (v.policyJson ?? policyJson) || undefined,
      },
    });

    return { success: true, tokenUpdated: Object.keys(merged).length > 0, debugLogs: logs };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("action", "Error", msg);
    return { success: false, error: msg, testResult: false, debugLogs: logs };
  }
};

type ActionData = {
  success?: boolean;
  error?: string;
  testResult?: boolean;
  testMessage?: string;
  tokenUpdated?: boolean;
  cleared?: boolean;
  debugLogs?: { ts: string; step: string; message: string; detail?: string }[];
};

export default function Integrations() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const [fyndEnvironment, setFyndEnvironment] = React.useState(data.fyndEnvironment);
  const [appMode, setAppMode] = React.useState(data.appMode);

  const showSaveSuccess = fetcher.data && "success" in fetcher.data && !("testResult" in fetcher.data) && !("cleared" in fetcher.data);
  const showCleared = fetcher.data && "cleared" in fetcher.data;
  const showTestSuccess = fetcher.data && "testResult" in fetcher.data && fetcher.data.testResult;
  const showTestError = fetcher.data && "testResult" in fetcher.data && !fetcher.data.testResult && fetcher.data.error;

  return (
    <s-page heading="Partner Integrations">
      <div className="app-content">
      {fetcher.data?.error && !showTestError && (
        <div className="app-alert app-alert-error">{fetcher.data.error}</div>
      )}
      {showSaveSuccess && (
        <div className="app-alert app-alert-success">
          {fetcher.data?.tokenUpdated ? "Credentials saved successfully." : "Settings saved successfully."}
        </div>
      )}
      {showCleared && (
        <div className="app-alert app-alert-success">Credentials cleared. Enter new values and Save.</div>
      )}
      {showTestSuccess && (
        <div className="app-alert app-alert-success">✓ {fetcher.data?.testMessage ?? "Connection successful."}</div>
      )}
      {showTestError && (
        <div className="app-alert app-alert-error" style={{ borderLeft: "4px solid #d72c0d" }}>
          <div style={{ fontWeight: 500, marginBottom: 6 }}>Connection failed: {fetcher.data?.error}</div>
          {(fetcher.data?.error?.includes("403") || fetcher.data?.error?.includes("Forbidden")) && (
            <div style={{ marginTop: 12, padding: 12, background: "rgba(255,255,255,0.5)", borderRadius: 8, fontSize: 13 }}>
              <strong>403 = Missing scopes.</strong> In Fynd Partners, your OAuth app needs <code>company/orders/read</code> and <code>company/orders/write</code>. Also verify: correct environment (UAT vs Prod), Company ID, Application ID. <a href="https://docs.fynd.com/partners/commerce/references/access-scopes" target="_blank" rel="noopener noreferrer" style={{ color: "#005bd3", textDecoration: "underline" }}>Scopes docs</a>
            </div>
          )}
        </div>
      )}

      {fetcher.data?.debugLogs && fetcher.data.debugLogs.length > 0 && (
        <details className="app-details" open={!!showTestError}>
          <summary>Debug logs ({fetcher.data.debugLogs.length})</summary>
          <pre style={{ margin: 0, padding: 16, background: "#1e1e1e", color: "#d4d4d4", fontSize: 12, overflow: "auto", maxHeight: 300 }}>
            {fetcher.data.debugLogs.map((e, i) => (
              <div key={i}>[{e.ts}] {e.step}: {e.message}{e.detail ? ` | ${e.detail}` : ""}</div>
            ))}
          </pre>
        </details>
      )}

      <fetcher.Form method="post">
        <div style={{ marginBottom: 24, padding: "12px 16px", background: "#e8f4fc", borderRadius: 8, border: "1px solid #b6d4fe" }}>
          <p className="app-field-helper" style={{ margin: 0, fontSize: 14 }}>
            <strong>New to Fynd?</strong> Use the{" "}
            <Link to="/app/settings/setup" style={{ color: "#005bd3", fontWeight: 600 }}>
              Fynd Setup Guide
            </Link>{" "}
            for step-by-step onboarding with webhook configuration and testing.
          </p>
        </div>
        <p className="app-field-helper" style={{ marginBottom: 24, fontSize: 14 }}>
          Connect Fynd for reverse logistics. All Fynd operations use <strong>Platform API only</strong> (OAuth). Storefront API is not used. From <a href="https://platform.fynd.com" target="_blank" rel="noreferrer" style={{ color: "#005bd3" }}>Fynd Platform</a>.
        </p>

        <s-section heading="App Mode">
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input type="radio" name="appMode" value="dev" checked={appMode === "dev"} onChange={() => setAppMode("dev")} />
              <span><strong>Dev</strong> — Test mode. Shows dev banner. Use with UAT credentials.</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input type="radio" name="appMode" value="prod" checked={appMode === "prod"} onChange={() => setAppMode("prod")} />
              <span><strong>Prod Live</strong> — Live mode. Real operations. Use with production credentials.</span>
            </label>
          </div>
        </s-section>

        <s-section heading="Fynd Environment">
          <div className="app-field">
            <label>API Base URL</label>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start", marginBottom: 8 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="radio" name="fyndEnvironment" value="uat" checked={fyndEnvironment === "uat"} onChange={() => setFyndEnvironment("uat")} />
                <span>UAT (Sandbox)</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="radio" name="fyndEnvironment" value="prod" checked={fyndEnvironment === "prod"} onChange={() => setFyndEnvironment("prod")} />
                <span>Production</span>
              </label>
            </div>
            <p className="app-field-helper">
              UAT: <code style={{ background: "#f1f1f1", padding: "2px 6px", borderRadius: 4 }}>{data.fyndEnvironments?.uat ?? "https://api.uat.fyndx1.de"}</code>
              {" · "}
              Prod: <code style={{ background: "#f1f1f1", padding: "2px 6px", borderRadius: 4 }}>{data.fyndEnvironments?.prod ?? "https://api.fynd.com"}</code>
            </p>
            <p className="app-field-helper">UAT and Prod use different credentials. Use credentials from the matching Fynd environment.</p>
          </div>
          <div className="app-field">
            <label>Custom URL (optional override)</label>
            <input type="text" name="fyndCustomBaseUrl" defaultValue={data.fyndCustomBaseUrl} placeholder="e.g. https://api.custom.fynd.com" autoComplete="off" className="app-input" />
            <p className="app-field-helper">Leave empty to use preset. Include https://</p>
          </div>
        </s-section>

        <s-section heading="Credentials">
          <div className="app-field">
            <label>Application ID</label>
            <input type="text" name="fyndApplicationId" defaultValue={data.fyndApplicationId} placeholder="e.g. 67a09b70c8ea7c9123f00fab" autoComplete="off" className="app-input" />
            <p className="app-field-helper">Shared by both APIs. From Company → Settings → Developers or your sales channel.</p>
          </div>

          <div className="app-card">
            <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 14 }}>Platform API (required)</div>
            <p className="app-field-helper" style={{ marginBottom: 8 }}>All Fynd operations use Platform API. Company ID + Client ID & Secret (OAuth).</p>
            <p className="app-field-helper" style={{ marginBottom: 16, padding: "10px 12px", background: "#fef3c7", borderRadius: 8, border: "1px solid #fcd34d", fontSize: 13 }}>
              <strong>Getting 403 Forbidden?</strong> Your OAuth app in Fynd Partners must have <code>company/orders/read</code> and <code>company/orders/write</code> scopes. Enable them in your extension/app config, then re-authorize. <a href="https://docs.fynd.com/partners/commerce/references/access-scopes" target="_blank" rel="noopener noreferrer" style={{ color: "#b45309", textDecoration: "underline" }}>Fynd scopes docs</a>
            </p>
            <div className="app-field">
              <label>Company ID</label>
              <input type="text" name="fyndCompanyId" defaultValue={data.fyndCompanyId} placeholder="e.g. 2263" autoComplete="off" className="app-input" />
            </div>
            <div className="app-field">
              <label>Client ID</label>
              <input type="text" name="fyndClientId" placeholder="Client ID" autoComplete="off" className="app-input" />
            </div>
            <div className="app-field">
              <label>Client Secret</label>
              <input type="text" name="fyndClientSecret" placeholder="Client Secret" autoComplete="off" className="app-input" />
            </div>
          </div>

          {data.fyndCredentials && (
            <p style={{ fontSize: 13, color: "#008060", marginTop: 16, fontWeight: 500 }}>
              ✓ Platform credentials configured. Enter new values to replace; leave blank to keep existing.
            </p>
          )}
        </s-section>

        <details className="app-details">
          <summary>Advanced — Policy</summary>
          <div className="app-details-content">
            <p className="app-field-helper" style={{ marginBottom: 16 }}>Configure return policy rules. Values are stored as JSON.</p>
            <div className="app-grid" style={{ marginBottom: 16 }}>
              <div className="app-field">
                <label>Return window (days)</label>
                <input type="number" name="policyReturnWindowDays" min={1} max={365} defaultValue={data.policy.returnWindowDays} className="app-input" />
              </div>
              <div className="app-field">
                <label>Min order value</label>
                <input type="number" name="policyMinOrderValue" min={0} step={1} defaultValue={data.policy.minOrderValue} className="app-input" />
              </div>
              <div className="app-field">
                <label>Restock fee (%)</label>
                <input type="number" name="policyRestockFeePercent" min={0} max={100} step={0.5} defaultValue={data.policy.restockFeePercent} className="app-input" />
              </div>
            </div>
            <div className="app-field" style={{ marginBottom: 16 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontWeight: 500 }}>
                <input type="checkbox" name="policyAllowExchange" defaultChecked={data.policy.allowExchange} />
                <span>Allow exchange</span>
              </label>
            </div>
            <div className="app-field" style={{ marginBottom: 16 }}>
              <label>Refund methods</label>
              <select name="policyRefundMethods" multiple size={3} defaultValue={data.policy.refundMethods} className="app-input">
                {REFUND_METHOD_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
              <p className="app-field-helper">Ctrl/Cmd+click to select multiple</p>
            </div>
            <div className="app-field" style={{ marginBottom: 16 }}>
              <label>Default refund method</label>
              <select name="policyDefaultRefundMethod" defaultValue={data.policy.defaultRefundMethod} className="app-input">
                {REFUND_METHOD_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </div>
            <div className="app-field" style={{ marginBottom: 16 }}>
              <label>Excluded tags (comma-separated)</label>
              <input type="text" name="policyExcludedTags" placeholder="e.g. final-sale, no-return" defaultValue={data.policy.excludedTags.join(", ")} className="app-input" />
            </div>
            <div className="app-field">
              <label>Allowed categories (comma-separated)</label>
              <input type="text" name="policyAllowedCategories" placeholder="e.g. Apparel, Footwear" defaultValue={data.policy.allowedCategories.join(", ")} className="app-input" />
            </div>
            {data.fyndCredentials && (
              <div style={{ marginTop: 24, paddingTop: 24, borderTop: "1px solid #e1e3e5" }}>
                <div className="app-field-helper" style={{ marginBottom: 8 }}>Danger zone</div>
                <button type="submit" name="intent" value="clear_token" disabled={fetcher.state !== "idle"} style={{ padding: "8px 16px", borderRadius: 8, border: "1px solid #d72c0d", background: "#fff", color: "#d72c0d", fontSize: 13, fontWeight: 500, cursor: fetcher.state !== "idle" ? "not-allowed" : "pointer" }}>
                  {fetcher.state !== "idle" ? "Please wait..." : "Clear credentials"}
                </button>
              </div>
            )}
          </div>
        </details>

        <div className="app-actions">
          <s-button type="submit" loading={fetcher.state !== "idle"}>Save</s-button>
          <Link to="/app/settings">
            <s-button variant="secondary" type="button">Discard</s-button>
          </Link>
          <span style={{ flex: 1, minWidth: 8 }} />
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            {data.hasPlatformCreds && (
              <button type="submit" name="intent" value="test_platform" disabled={fetcher.state !== "idle"} style={{ padding: "10px 18px", borderRadius: 8, border: "1px solid #e1e3e5", background: "#fff", color: "#202223", fontSize: 14, fontWeight: 500, cursor: fetcher.state !== "idle" ? "not-allowed" : "pointer", minHeight: 40 }}>{fetcher.state !== "idle" ? "Please wait…" : "Test Platform"}</button>
            )}
            {!data.hasPlatformCreds && (
              <button type="submit" name="intent" value="test" disabled={fetcher.state !== "idle"} style={{ padding: "10px 18px", borderRadius: 8, border: "1px solid #e1e3e5", background: "#fff", color: "#202223", fontSize: 14, fontWeight: 500, cursor: fetcher.state !== "idle" ? "not-allowed" : "pointer", minHeight: 40 }}>{fetcher.state !== "idle" ? "Please wait…" : "Test connection"}</button>
            )}
          </div>
        </div>
      </fetcher.Form>
      </div>
    </s-page>
  );
}
