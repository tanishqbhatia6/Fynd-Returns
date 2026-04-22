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
    // Gorgias integration. Mask the API key: never echo the real value to the client
    // (P0 — DB dump or admin XSS used to leak the key). The form uses a sentinel so
    // the user can preserve the existing value without seeing it.
    gorgiasEnabled: s?.gorgiasEnabled ?? false,
    gorgiasApiKey: s?.gorgiasApiKey ? "__UNCHANGED__" : "",
    gorgiasWidgetUrl: `${process.env.SHOPIFY_APP_URL || ""}/api/integrations/gorgias?shop=${session.shop}`,
    // Per-shop Fynd webhook config. The secret itself is never sent to the
    // client after generation — we only signal whether one exists. The URL
    // (with shopId) is what the merchant pastes into Fynd Partner Dashboard.
    fyndWebhookSecretConfigured: !!shop.settings?.fyndWebhookSecret,
    fyndWebhookUrl: `${process.env.SHOPIFY_APP_URL || ""}/api/webhooks/fynd/${shop.id}`,
    // Set when the action just generated/rotated a secret — displayed once.
    // Pulled from the action's response, not the loader; kept in the type for
    // useActionData typing consistency.
    fyndWebhookSecretJustGenerated: undefined as string | undefined,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { logs, log } = createFyndLogger();
  // Authenticate FIRST, outside the try/catch.
  //
  // CRITICAL: authenticate.admin(request) signals an auth failure by THROWING
  // a Response (e.g. a 302 to /auth/login). React Router's boundary
  // recognises that thrown Response and lets App Bridge perform a top-level
  // redirect. If we wrap it in try/catch, the catch interprets the Response
  // as a regular error, returns it as JSON ({error: "[object Response]"}),
  // and React Router then revalidates the page — the loader hits the same
  // expired session, throws another Response, and the iframe ends up on the
  // install page. That was the "Generate Webhook Secret takes me to install"
  // bug. Letting the Response propagate from here keeps the boundary in
  // control of the redirect (App Bridge top-level → silent token refresh).
  const { session } = await authenticate.admin(request);
  try {
    const formData = await request.formData();
    const intent = formData.get("intent") as string | null;

    // Send a self-signed test request to the per-shop webhook endpoint and
    // report whether it accepts the signature + reaches processing. This
    // exercises the full path the same way Fynd will: read the stored secret,
    // sign a synthetic body, POST to the per-shop URL, parse the response.
    // Useful after generating/rotating a secret to confirm the merchant's
    // Fynd Partner Dashboard config matches what we have stored.
    if (intent === "test_fynd_webhook_secret") {
      const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop }, include: { settings: true } });
      if (!shop) return { success: false, fyndWebhookTestResult: false, fyndWebhookTestError: "Shop not found", debugLogs: logs };
      const storedSecret = shop.settings?.fyndWebhookSecret;
      if (!storedSecret) {
        return { success: false, fyndWebhookTestResult: false, fyndWebhookTestError: "No webhook secret configured. Generate one first.", debugLogs: logs };
      }
      const { decryptIfEncrypted } = await import("../lib/encryption.server");
      const plaintext = decryptIfEncrypted(storedSecret);
      if (!plaintext) {
        return { success: false, fyndWebhookTestResult: false, fyndWebhookTestError: "Could not decrypt stored secret. Generate a new one.", debugLogs: logs };
      }
      const appUrl = (process.env.SHOPIFY_APP_URL ?? "").replace(/\/$/, "");
      if (!appUrl) {
        return { success: false, fyndWebhookTestResult: false, fyndWebhookTestError: "SHOPIFY_APP_URL is not set on the server.", debugLogs: logs };
      }
      const url = `${appUrl}/api/webhooks/fynd/${shop.id}`;
      // The body matches what Fynd sends for a status update. We use a
      // distinctive shipment_id so the dedup window doesn't suppress repeats.
      const body = JSON.stringify({
        shipment_id: `selftest-${Date.now()}`,
        refund_status: "UNDER PROCESS",
        _shop_domain: shop.shopDomain,
      });
      const cryptoLib = await import("node:crypto");
      const signature = cryptoLib.createHmac("sha256", plaintext).update(body).digest("hex");
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Fynd-Signature": signature,
          },
          body,
          signal: AbortSignal.timeout(15_000),
        });
        if (res.ok) {
          return { success: true, fyndWebhookTestResult: true, debugLogs: logs };
        }
        const text = await res.text().catch(() => "");
        return {
          success: false,
          fyndWebhookTestResult: false,
          fyndWebhookTestError: `endpoint returned HTTP ${res.status}${text ? ` — ${text.slice(0, 200)}` : ""}`,
          debugLogs: logs,
        };
      } catch (err) {
        return {
          success: false,
          fyndWebhookTestResult: false,
          fyndWebhookTestError: err instanceof Error ? err.message : String(err),
          debugLogs: logs,
        };
      }
    }

    // Generate or rotate the per-shop Fynd webhook secret. The value is
    // returned ONCE in the action result so the merchant can copy it into the
    // Fynd Partner Dashboard. After that it lives encrypted in the DB and we
    // never expose it again.
    if (intent === "generate_fynd_webhook_secret" || intent === "rotate_fynd_webhook_secret") {
      const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop }, include: { settings: true } });
      if (!shop) return { success: false, error: "Shop not found", debugLogs: logs };
      const { generateWebhookSecret } = await import("../lib/fynd-webhook-verify.server");
      const { encryptIfNeeded } = await import("../lib/encryption.server");
      const plaintext = generateWebhookSecret();
      const encrypted = encryptIfNeeded(plaintext);
      await prisma.shopSettings.upsert({
        where: { shopId: shop.id },
        create: { shopId: shop.id, fyndWebhookSecret: encrypted },
        update: { fyndWebhookSecret: encrypted },
      });
      return {
        success: true,
        fyndWebhookSecretJustGenerated: plaintext,
        fyndWebhookUrl: `${process.env.SHOPIFY_APP_URL || ""}/api/webhooks/fynd/${shop.id}`,
        debugLogs: logs,
      };
    }

    if (intent === "test_platform" || intent === "test_storefront" || intent === "test") {
      const fyndEnvironment = (formData.get("fyndEnvironment") as string) || "uat";
      const fyndCustomBaseUrl = String(formData.get("fyndCustomBaseUrl") ?? "").trim();
      const fyndCompanyId = String(formData.get("fyndCompanyId") ?? "").trim();
      const fyndApplicationId = String(formData.get("fyndApplicationId") ?? "").trim();
      const fyndClientId = String(formData.get("fyndClientId") ?? "").trim();
      const fyndClientSecret = String(formData.get("fyndClientSecret") ?? "").trim();
      // fyndApplicationToken is not used for Platform API (OAuth only)

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
    // fyndApplicationToken is not used for Platform API (OAuth only)
    const policyJson = buildPolicyJson(formData);

    const validation = sanitizeCredentialInputs({
      fyndCompanyId: fyndCompanyId || undefined,
      fyndApplicationId: fyndApplicationId || undefined,
      fyndClientId: fyndClientId || undefined,
      fyndClientSecret: fyndClientSecret || undefined,
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
    /* If new credentials are provided, always encrypt and save them — even if old ones can't be decrypted (e.g. ENCRYPTION_KEY changed after migration) */
    const credsToPersist =
      Object.keys(merged).length > 0
        ? encrypt(JSON.stringify(merged))
        : (shop.settings?.fyndCredentials ?? null);
    const fyndApiType = merged.platform ? "platform" : null;

    // Resolve Gorgias API key with the same write-only-then-encrypt pattern as SMTP.
    // The form submits "__UNCHANGED__" when the user didn't touch the field; in that
    // case we keep the existing (encrypted) value. New plaintext is encrypted on the
    // way in via encryptIfNeeded (idempotent, safe if already encrypted).
    const submittedGorgiasKey = (formData.get("gorgiasApiKey") as string | null)?.trim() ?? "";
    const resolvedGorgiasApiKey: string | null = submittedGorgiasKey === ""
      ? null
      : submittedGorgiasKey === "__UNCHANGED__"
        ? (shop.settings?.gorgiasApiKey ?? null)
        : (await import("../lib/encryption.server")).encryptIfNeeded(submittedGorgiasKey);

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
        gorgiasEnabled: formData.get("gorgiasEnabled") === "on",
        gorgiasApiKey: resolvedGorgiasApiKey,
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
        gorgiasEnabled: formData.get("gorgiasEnabled") === "on",
        gorgiasApiKey: resolvedGorgiasApiKey,
      },
    });

    return { success: true, tokenUpdated: Object.keys(merged).length > 0, debugLogs: logs };
  } catch (err) {
    // Defence in depth: if any nested code throws a Response (e.g. a Shopify
    // Admin API call that triggered a re-auth, or another `authenticate.*`
    // helper), let it propagate so React Router / the App Bridge boundary
    // can handle the redirect. Otherwise we'd swallow it and end up on the
    // install page via revalidation.
    if (err instanceof Response) throw err;
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
  // Dedicated fetcher for the per-shop webhook secret generation.
  //
  // Why fetcher and not <Form>: a top-level <Form method="post"> navigates the
  // iframe, which strips the App Bridge session token from the request.
  // authenticate.admin() then fails and the boundary throws a redirect to
  // /auth/login — exactly the "redirected to install page" symptom merchants
  // were reporting. fetcher.Form uses fetch() under the hood, which the
  // AppProvider patches to attach the Authorization: Bearer <session-token>
  // header automatically, so auth survives across the request.
  const webhookFetcher = useFetcher<{
    success?: boolean;
    fyndWebhookSecretJustGenerated?: string;
    error?: string;
  }>();
  const justGeneratedSecret = webhookFetcher.data?.fyndWebhookSecretJustGenerated;
  const [fyndEnvironment, setFyndEnvironment] = React.useState(data.fyndEnvironment);
  const [appMode, setAppMode] = React.useState(data.appMode);

  const showSaveSuccess = fetcher.data?.success === true && !("testResult" in fetcher.data) && !("cleared" in fetcher.data);
  const showCleared = fetcher.data && "cleared" in fetcher.data;
  const showTestSuccess = fetcher.data && "testResult" in fetcher.data && fetcher.data.testResult;
  const showTestError = fetcher.data && "testResult" in fetcher.data && !fetcher.data.testResult && fetcher.data.error;

  return (
    <s-page fullWidth heading="Partner Integrations">
      <div className="app-content layout-form">
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
          <div className="app-alert app-alert-success">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ verticalAlign: "middle", marginRight: 4 }}>
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {fetcher.data?.testMessage ?? "Connection successful."}
          </div>
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
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
              <label style={{
                display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", padding: 14, flex: "1 1 220px",
                background: appMode === "dev" ? "#FFFBEB" : "#F9FAFB",
                borderRadius: 10, border: appMode === "dev" ? "2px solid #F59E0B" : "1px solid #E5E7EB",
                transition: "all 0.15s",
              }}>
                <input type="radio" name="appMode" value="dev" checked={appMode === "dev"} onChange={() => setAppMode("dev")} style={{ marginTop: 3 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={appMode === "dev" ? "#D97706" : "#6B7280"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="16 18 22 12 16 6" /><polyline points="8 6 2 12 8 18" />
                    </svg>
                    Development
                  </div>
                  <div style={{ fontSize: 12, color: "#6B7280", marginTop: 3 }}>Test mode with dev banner. Use with UAT credentials.</div>
                </div>
              </label>
              <label style={{
                display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", padding: 14, flex: "1 1 220px",
                background: appMode === "prod" ? "#F0FDF4" : "#F9FAFB",
                borderRadius: 10, border: appMode === "prod" ? "2px solid #22C55E" : "1px solid #E5E7EB",
                transition: "all 0.15s",
              }}>
                <input type="radio" name="appMode" value="prod" checked={appMode === "prod"} onChange={() => setAppMode("prod")} style={{ marginTop: 3 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={appMode === "prod" ? "#16A34A" : "#6B7280"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z" />
                      <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z" />
                      <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
                      <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
                    </svg>
                    Production
                  </div>
                  <div style={{ fontSize: 12, color: "#6B7280", marginTop: 3 }}>Live mode with real operations. Use with production credentials.</div>
                </div>
              </label>
            </div>
          </s-section>

          <s-section heading="Fynd Environment">
            <div className="app-field">
              <label>API Base URL</label>
              <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 8 }}>
                <label style={{
                  display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", padding: 14, flex: "1 1 200px",
                  background: fyndEnvironment === "uat" ? "#FFFBEB" : "#F9FAFB",
                  borderRadius: 10, border: fyndEnvironment === "uat" ? "2px solid #F59E0B" : "1px solid #E5E7EB",
                  transition: "all 0.15s",
                }}>
                  <input type="radio" name="fyndEnvironment" value="uat" checked={fyndEnvironment === "uat"} onChange={() => setFyndEnvironment("uat")} style={{ marginTop: 3 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={fyndEnvironment === "uat" ? "#D97706" : "#6B7280"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9 3h6l2 7H7L9 3z" /><path d="M7 10l-2 8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1l-2-8" /><path d="M12 3v7" />
                      </svg>
                      UAT (Sandbox)
                    </div>
                    <div style={{ fontSize: 12, color: "#6B7280", marginTop: 3 }}>Test environment for development and staging</div>
                  </div>
                </label>
                <label style={{
                  display: "flex", alignItems: "flex-start", gap: 10, cursor: "pointer", padding: 14, flex: "1 1 200px",
                  background: fyndEnvironment === "prod" ? "#F0FDF4" : "#F9FAFB",
                  borderRadius: 10, border: fyndEnvironment === "prod" ? "2px solid #22C55E" : "1px solid #E5E7EB",
                  transition: "all 0.15s",
                }}>
                  <input type="radio" name="fyndEnvironment" value="prod" checked={fyndEnvironment === "prod"} onChange={() => setFyndEnvironment("prod")} style={{ marginTop: 3 }} />
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={fyndEnvironment === "prod" ? "#16A34A" : "#6B7280"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="2" y="2" width="20" height="8" rx="2" ry="2" /><rect x="2" y="14" width="20" height="8" rx="2" ry="2" />
                        <line x1="6" y1="6" x2="6.01" y2="6" /><line x1="6" y1="18" x2="6.01" y2="18" />
                      </svg>
                      Production
                    </div>
                    <div style={{ fontSize: 12, color: "#6B7280", marginTop: 3 }}>Live Fynd environment for real operations</div>
                  </div>
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
                <input type="password" name="fyndClientSecret" placeholder="Client Secret" autoComplete="off" className="app-input" />
              </div>
            </div>

            {data.fyndCredentials && (
              <p style={{ fontSize: 13, color: "#008060", marginTop: 16, fontWeight: 500 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ verticalAlign: "middle", marginRight: 4 }}>
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Platform credentials configured. Enter new values to replace; leave blank to keep existing.
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
                <label style={{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer", fontWeight: 500 }}>
                  <span style={{ position: "relative", display: "inline-block", width: 40, height: 22, flexShrink: 0 }}>
                    <input type="checkbox" name="policyAllowExchange" defaultChecked={data.policy.allowExchange} style={{ position: "absolute", opacity: 0, width: 0, height: 0 }}
                      onChange={(e) => {
                        const track = e.target.nextElementSibling as HTMLElement;
                        if (track) {
                          track.style.background = e.target.checked ? "#22C55E" : "#D1D5DB";
                          const knob = track.firstElementChild as HTMLElement;
                          if (knob) knob.style.transform = e.target.checked ? "translateX(18px)" : "translateX(0)";
                        }
                      }}
                    />
                    <span style={{
                      position: "absolute", inset: 0, borderRadius: 11,
                      background: data.policy.allowExchange ? "#22C55E" : "#D1D5DB",
                      transition: "background 0.2s", cursor: "pointer",
                    }}>
                      <span style={{
                        position: "absolute", left: 2, top: 2, width: 18, height: 18, borderRadius: "50%",
                        background: "#fff", boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
                        transition: "transform 0.2s",
                        transform: data.policy.allowExchange ? "translateX(18px)" : "translateX(0)",
                      }} />
                    </span>
                  </span>
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

          {/* ── Per-Shop Fynd Webhook Secret ── */}
          <details style={{ marginTop: 24 }} open={!!justGeneratedSecret}>
            <summary style={{ cursor: "pointer", fontWeight: 700, fontSize: 16, padding: "12px 0", borderTop: "1px solid #E5E7EB" }}>
              Fynd Webhook (per-shop secret)
            </summary>
            <div style={{ padding: "16px 0", display: "flex", flexDirection: "column", gap: 16 }}>
              <p style={{ fontSize: 13, color: "var(--rpm-text-muted, #475569)", margin: 0, lineHeight: 1.5 }}>
                Each store gets its own webhook URL + signing secret. Configure both in
                the Fynd Partner Dashboard so Fynd can sign outgoing webhooks and we can
                verify them. A unique secret per shop means a leak never affects more
                than one store.
              </p>

              {/* Webhook URL — full-width readonly code box. Uses
                  .app-code-readonly (defined in styles.css) instead of .app-input
                  because .app-input has max-width: 480px which truncates long
                  URLs in monospace. The container is flex so the Copy button sits
                  beside the field on wide screens and wraps under it on narrow. */}
              <div>
                <label style={{ display: "block", fontWeight: 600, fontSize: 13, marginBottom: 6 }}>
                  Webhook URL (paste into Fynd Partner Dashboard)
                </label>
                <div style={{ display: "flex", gap: 8, alignItems: "stretch", flexWrap: "wrap" }}>
                  <input
                    type="text"
                    readOnly
                    value={data.fyndWebhookUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    className="app-code-readonly"
                    style={{ flex: "1 1 320px", minWidth: 0 }}
                    aria-label="Per-shop Fynd webhook URL"
                  />
                  <button
                    type="button"
                    className="app-btn"
                    onClick={(e) => {
                      navigator.clipboard.writeText(data.fyndWebhookUrl).then(
                        () => {
                          const btn = e.currentTarget;
                          if (!btn) return;
                          const orig = btn.textContent;
                          btn.textContent = "Copied ✓";
                          setTimeout(() => { if (btn) btn.textContent = orig; }, 1800);
                        },
                        () => { /* clipboard write rejected — leave label */ },
                      );
                    }}
                  >
                    Copy URL
                  </button>
                </div>
                <div style={{ marginTop: 6, fontSize: 12, color: "var(--rpm-text-muted, #6b7280)" }}>
                  This URL is unique to this shop. The path includes your internal
                  shop ID — opaque, not enumerable.
                </div>
              </div>

              {justGeneratedSecret ? (
                <div
                  style={{
                    padding: 14, borderRadius: 10,
                    background: "#FEF3C7", border: "1.5px solid #F59E0B",
                    fontSize: 13, color: "#78350F",
                    display: "flex", flexDirection: "column", gap: 10,
                  }}
                >
                  <div style={{ fontWeight: 700 }}>
                    ⚠ Copy this secret now — it won't be shown again
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "stretch", flexWrap: "wrap" }}>
                    <input
                      type="text"
                      readOnly
                      value={justGeneratedSecret}
                      onFocus={(e) => e.currentTarget.select()}
                      className="app-code-readonly"
                      style={{ flex: "1 1 320px", minWidth: 0, borderColor: "#92400e", background: "#fff" }}
                      aria-label="Generated webhook signing secret"
                    />
                    <button
                      type="button"
                      className="app-btn"
                      onClick={(e) => {
                        navigator.clipboard.writeText(justGeneratedSecret).then(
                          () => {
                            const btn = e.currentTarget;
                            if (!btn) return;
                            const orig = btn.textContent;
                            btn.textContent = "Copied ✓";
                            setTimeout(() => { if (btn) btn.textContent = orig; }, 1800);
                          },
                          () => { /* clipboard write rejected */ },
                        );
                      }}
                    >
                      Copy secret
                    </button>
                  </div>
                  <div style={{ fontSize: 12, lineHeight: 1.5 }}>
                    Paste this into Fynd Partner Dashboard → Webhook → Signing
                    Secret field for the URL above. After you navigate away, only
                    the encrypted value remains in our database — we cannot
                    recover the plaintext.
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    padding: "10px 12px",
                    borderRadius: 8,
                    background: data.fyndWebhookSecretConfigured ? "#ECFDF5" : "#F8FAFC",
                    border: `1px solid ${data.fyndWebhookSecretConfigured ? "#A7F3D0" : "#E2E8F0"}`,
                    color: data.fyndWebhookSecretConfigured ? "#065F46" : "#475569",
                    fontSize: 13,
                  }}
                >
                  {data.fyndWebhookSecretConfigured
                    ? "✓ A webhook secret is configured for this shop. Use “Rotate webhook secret” to issue a new one."
                    : "No webhook secret yet — generate one to start receiving signed Fynd webhooks at the per-shop URL."}
                </div>
              )}

              {/* Action buttons — Generate/Rotate + Test. Generate uses a
                  dedicated fetcher (not <Form>) so the request goes through
                  fetch() and App Bridge attaches the session token. A plain
                  <Form> POST navigates the iframe and loses the token, which
                  triggered the "redirected to install page" bug. */}
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                <webhookFetcher.Form method="post" style={{ display: "inline-flex" }}>
                  <input
                    type="hidden"
                    name="intent"
                    value={data.fyndWebhookSecretConfigured ? "rotate_fynd_webhook_secret" : "generate_fynd_webhook_secret"}
                  />
                  <button
                    type="submit"
                    className="app-btn-primary"
                    disabled={webhookFetcher.state !== "idle"}
                    onClick={(e) => {
                      if (data.fyndWebhookSecretConfigured) {
                        if (!confirm("Rotate the webhook secret? Fynd will be unable to deliver webhooks until you paste the new secret into the Fynd Partner Dashboard.")) {
                          e.preventDefault();
                        }
                      }
                    }}
                  >
                    {webhookFetcher.state !== "idle"
                      ? "Generating…"
                      : data.fyndWebhookSecretConfigured
                        ? "Rotate webhook secret"
                        : "Generate webhook secret"}
                  </button>
                </webhookFetcher.Form>
                {webhookFetcher.data?.error && (
                  <span style={{ fontSize: 13, color: "#991b1b" }}>
                    {webhookFetcher.data.error}
                  </span>
                )}
                {/* Test sends a synthetic webhook signed with the stored secret
                    via the same code path Fynd uses. Only meaningful AFTER a
                    secret exists. */}
                <fetcher.Form method="post" style={{ display: "inline-flex" }}>
                  <input type="hidden" name="intent" value="test_fynd_webhook_secret" />
                  <button
                    type="submit"
                    className="app-btn"
                    disabled={!data.fyndWebhookSecretConfigured || fetcher.state !== "idle"}
                    title={!data.fyndWebhookSecretConfigured ? "Generate a secret first" : undefined}
                  >
                    {fetcher.state !== "idle" && fetcher.formData?.get("intent") === "test_fynd_webhook_secret"
                      ? "Testing…"
                      : "Test webhook"}
                  </button>
                </fetcher.Form>
              </div>

              {/* Test result feedback — surfaces success or the specific HTTP
                  status the per-shop endpoint returned, so an admin can spot
                  config issues (wrong secret saved, endpoint unreachable). */}
              {fetcher.data && "fyndWebhookTestResult" in fetcher.data && (
                <div
                  style={{
                    padding: "10px 12px",
                    borderRadius: 8,
                    background: fetcher.data.fyndWebhookTestResult ? "#ECFDF5" : "#FEF2F2",
                    border: `1px solid ${fetcher.data.fyndWebhookTestResult ? "#A7F3D0" : "#FECACA"}`,
                    color: fetcher.data.fyndWebhookTestResult ? "#065F46" : "#991B1B",
                    fontSize: 13,
                  }}
                >
                  {fetcher.data.fyndWebhookTestResult
                    ? "✓ Webhook reachable and signature verified. The per-shop endpoint is correctly configured."
                    : `✗ Test failed: ${("fyndWebhookTestError" in fetcher.data ? (fetcher.data as { fyndWebhookTestError?: string }).fyndWebhookTestError : null) ?? "unknown error"}`}
                </div>
              )}

              {/* ── Inline testing reference (Postman / curl) ──
                  The merchant frequently asked "how do I test this from
                  Postman?" — the answer is the same algorithm Fynd uses, so we
                  surface it right here instead of burying it in /docs. The
                  example shows the exact header name, signature algorithm, and
                  a runnable curl one-liner using the merchant's actual
                  webhook URL. */}
              <details style={{ marginTop: 8 }}>
                <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600, color: "var(--rpm-text, #334155)", padding: "6px 0" }}>
                  How to test from Postman or curl
                </summary>
                <div style={{ padding: "10px 0", display: "flex", flexDirection: "column", gap: 12, fontSize: 13 }}>
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>Signature algorithm</div>
                    <div style={{ color: "var(--rpm-text-muted, #475569)", lineHeight: 1.5 }}>
                      <code>X-Fynd-Signature</code> = <code>HMAC-SHA256(secret, raw_body).hex</code>
                      . The signature is computed over the exact bytes of the
                      JSON body — no whitespace changes, no re-serialisation.
                      We accept both <code>&lt;hex&gt;</code> and
                      <code> sha256=&lt;hex&gt;</code> formats.
                    </div>
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>curl example</div>
                    <textarea
                      readOnly
                      onFocus={(e) => e.currentTarget.select()}
                      value={[
                        `# Replace SECRET with the secret you copied above.`,
                        `BODY='{"shipment_id":"selftest-1","refund_status":"UNDER PROCESS"}'`,
                        `SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "SECRET" | awk '{print $2}')`,
                        `curl -X POST "${data.fyndWebhookUrl}" \\`,
                        `  -H "Content-Type: application/json" \\`,
                        `  -H "X-Fynd-Signature: $SIG" \\`,
                        `  -d "$BODY"`,
                      ].join("\n")}
                      rows={7}
                      style={{
                        width: "100%", padding: "10px 12px", fontSize: 12,
                        fontFamily: "ui-monospace, SFMono-Regular, monospace",
                        background: "#0f172a", color: "#e2e8f0",
                        border: "1px solid #1e293b", borderRadius: 8,
                        resize: "vertical", whiteSpace: "pre", overflowX: "auto",
                      }}
                      aria-label="curl example for testing the per-shop webhook"
                    />
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 4 }}>Sample payload Fynd will send</div>
                    <textarea
                      readOnly
                      onFocus={(e) => e.currentTarget.select()}
                      value={JSON.stringify({
                        shipment_id: "16xxxx2345678",
                        refund_status: "refund_done",
                        order_id: "FY10000001",
                        amount: 1299,
                        currency: "INR",
                      }, null, 2)}
                      rows={7}
                      style={{
                        width: "100%", padding: "10px 12px", fontSize: 12,
                        fontFamily: "ui-monospace, SFMono-Regular, monospace",
                        background: "#f8fafc", color: "#0f172a",
                        border: "1px solid #e2e8f0", borderRadius: 8,
                        resize: "vertical",
                      }}
                      aria-label="Sample Fynd webhook payload"
                    />
                  </div>
                  <div style={{ color: "var(--rpm-text-muted, #475569)", lineHeight: 1.5 }}>
                    <strong>Expected responses:</strong>{" "}
                    <code>200 {"{ ok: true }"}</code> on success,{" "}
                    <code>401</code> if the signature doesn't match the stored
                    secret or no secret is configured for this shop,{" "}
                    <code>413</code> for payloads over 1 MB.
                  </div>
                </div>
              </details>
            </div>
          </details>

          {/* ── Gorgias Helpdesk Integration ── */}
          <details style={{ marginTop: 24 }}>
            <summary style={{ cursor: "pointer", fontWeight: 700, fontSize: 16, padding: "12px 0", borderTop: "1px solid #E5E7EB" }}>
              Gorgias Helpdesk Integration
            </summary>
            <div style={{ padding: "16px 0", display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <div>
                  <div style={{ fontWeight: 600, fontSize: 14 }}>Enable Gorgias integration</div>
                  <p style={{ fontSize: 13, color: "#6d7175", margin: "4px 0 0" }}>
                    Display return data in Gorgias sidebar when viewing customer tickets.
                  </p>
                </div>
                <label style={{ position: "relative", display: "inline-block", width: 44, height: 24, flexShrink: 0, cursor: "pointer" }}>
                  <input type="checkbox" name="gorgiasEnabled" defaultChecked={data.gorgiasEnabled}
                    style={{ position: "absolute", opacity: 0, width: 0, height: 0 }} />
                  <span style={{ position: "absolute", inset: 0, borderRadius: 12, transition: "all 0.15s", background: data.gorgiasEnabled ? "#3B82F6" : "#cbd5e1" }}>
                    <span style={{ position: "absolute", left: data.gorgiasEnabled ? 22 : 2, top: 2, width: 20, height: 20, borderRadius: 10, background: "#fff", transition: "all 0.15s", boxShadow: "0 1px 3px rgba(0,0,0,.15)" }} />
                  </span>
                </label>
              </div>
              <div className="app-field">
                <label>Gorgias API Key (for authentication)</label>
                <input type="text" name="gorgiasApiKey" defaultValue={data.gorgiasApiKey} placeholder="Optional — leave blank to disable auth" className="app-input" />
                <div className="app-field-helper">If set, Gorgias must include this key as <code>api_key</code> query parameter.</div>
              </div>
              <div className="app-field">
                <label>Widget URL (paste into Gorgias HTTP integration)</label>
                <div style={{ display: "flex", gap: 8, minWidth: 0 }}>
                  <input type="text" readOnly value={data.gorgiasWidgetUrl} className="app-input" style={{ flex: 1, background: "#F9FAFB", fontSize: 12, fontFamily: "monospace", overflow: "hidden", textOverflow: "ellipsis", minWidth: 0 }} />
                </div>
                <div className="app-field-helper">Append <code>&amp;email=customer_email</code> for customer context.</div>
              </div>
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
