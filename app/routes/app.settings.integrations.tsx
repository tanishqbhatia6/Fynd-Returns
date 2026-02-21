import * as React from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { encrypt } from "../lib/encryption.server";
import { createFyndClientOrError, getNormalizedCredentialsFromRaw } from "../lib/fynd.server";
import { createFyndLogger } from "../lib/fynd-logger.server";
import { FYND_ENVIRONMENTS, getAppMode } from "../lib/fynd-config.server";
import { sanitizeCredentialInputs } from "../lib/credential-validation.server";

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
  return {
    fyndApiType: (s as { fyndApiType?: string })?.fyndApiType ?? "platform",
    fyndEnvironment: (s as { fyndEnvironment?: string })?.fyndEnvironment ?? "uat",
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
        if (fyndApplicationToken) {
          merged.storefront = { applicationToken: fyndApplicationToken };
        } else if (existingNormalized?.storefront) {
          merged.storefront = existingNormalized.storefront;
        }
        if (Object.keys(merged).length === 0) return null;
        return encrypt(JSON.stringify(merged));
      }

      const creds = buildCredsForTest();
      if (!creds || !applicationId) {
        return { success: false, error: "Enter Application ID and at least one set of credentials (Platform or Storefront), then Save or Test.", testResult: false, debugLogs: logs };
      }

      const requirePlatform = intent === "test_platform";
      const requireStorefront = intent === "test_storefront";

      const result = await createFyndClientOrError(
        { ...envSettings, fyndCompanyId: companyId, fyndApplicationId: applicationId, fyndCredentials: creds },
        { requirePlatform, requireStorefront, log }
      );
      if (!result.ok) return { success: false, error: result.error, testResult: false, debugLogs: logs };
      try {
        await result.client.testConnection();
        const msg = requirePlatform ? "Platform API connection successful." : requireStorefront ? "Storefront API connection successful." : "Connection successful.";
        return { success: true, testResult: true, testMessage: msg, debugLogs: logs };
      } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : "Connection failed.", testResult: false, debugLogs: logs };
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
    const policyJson = String(formData.get("policyJson") ?? "{}").trim();

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
    if (v.fyndApplicationToken) {
      merged.storefront = { applicationToken: v.fyndApplicationToken };
    } else if (existingNormalized?.storefront) {
      merged.storefront = existingNormalized.storefront;
    }
    const credsToPersist = Object.keys(merged).length > 0 ? encrypt(JSON.stringify(merged)) : (shop.settings?.fyndCredentials ?? null);
    const fyndApiType = merged.platform && merged.storefront ? null : merged.platform ? "platform" : merged.storefront ? "storefront" : null;

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
      {fetcher.data?.error && !showTestError && (
        <div style={{ padding: 12, marginBottom: 16, background: "#fef2f2", borderRadius: 8, color: "#d72c0d" }}>{fetcher.data.error}</div>
      )}
      {showSaveSuccess && (
        <div style={{ padding: 12, marginBottom: 16, background: "#e8f5e9", borderRadius: 8, color: "#2e7d32" }}>
          {fetcher.data?.tokenUpdated ? "Credentials saved successfully." : "Settings saved successfully."}
        </div>
      )}
      {showCleared && (
        <div style={{ padding: 12, marginBottom: 16, background: "#e8f5e9", borderRadius: 8, color: "#2e7d32" }}>Credentials cleared. Enter new values and Save.</div>
      )}
      {showTestSuccess && (
        <div style={{ padding: 12, marginBottom: 16, background: "#e8f5e9", borderRadius: 8, color: "#2e7d32" }}>✓ {fetcher.data?.testMessage ?? "Connection successful."}</div>
      )}
      {showTestError && (
        <div style={{ padding: 12, marginBottom: 16, background: "#fef2f2", borderRadius: 8, color: "#d72c0d" }}>
          <div style={{ fontWeight: 500, marginBottom: 6 }}>Connection failed: {fetcher.data?.error}</div>
        </div>
      )}

      {fetcher.data?.debugLogs && fetcher.data.debugLogs.length > 0 && (
        <details style={{ marginBottom: 24, border: "1px solid #e1e3e5", borderRadius: 8, overflow: "hidden" }} open={!!showTestError}>
          <summary style={{ padding: 12, background: "#f6f6f7", cursor: "pointer", fontWeight: 600, fontSize: 14 }}>Debug logs ({fetcher.data.debugLogs.length})</summary>
          <pre style={{ margin: 0, padding: 16, background: "#1e1e1e", color: "#d4d4d4", fontSize: 12, overflow: "auto", maxHeight: 300 }}>
            {fetcher.data.debugLogs.map((e, i) => (
              <div key={i}>[{e.ts}] {e.step}: {e.message}{e.detail ? ` | ${e.detail}` : ""}</div>
            ))}
          </pre>
        </details>
      )}

      <fetcher.Form method="post">
        <p style={{ marginBottom: 24, color: "#6d7175", fontSize: 14 }}>
          Connect Fynd for reverse logistics. You can add <strong>Platform</strong> and/or <strong>Storefront</strong> credentials; the app uses the right API per operation (e.g. Platform for creating returns, Storefront for storefront features). From <a href="https://platform.fynd.com" target="_blank" rel="noreferrer" style={{ color: "#005bd3" }}>Fynd Platform</a>.
        </p>

        <s-section heading="App Mode">
          <div style={{ display: "flex", gap: 24, marginBottom: 16, flexWrap: "wrap" }}>
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
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>API Base URL</label>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="radio" name="fyndEnvironment" value="uat" checked={fyndEnvironment === "uat"} onChange={() => setFyndEnvironment("uat")} />
                <span>UAT (Sandbox)</span>
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="radio" name="fyndEnvironment" value="prod" checked={fyndEnvironment === "prod"} onChange={() => setFyndEnvironment("prod")} />
                <span>Production</span>
              </label>
            </div>
            <p style={{ fontSize: 12, color: "#6d7175", marginTop: 8 }}>
              UAT: <code style={{ background: "#f1f1f1", padding: "2px 6px", borderRadius: 4 }}>{data.fyndEnvironments?.uat ?? "https://api.uat.fyndx1.de"}</code>
              {" · "}
              Prod: <code style={{ background: "#f1f1f1", padding: "2px 6px", borderRadius: 4 }}>{data.fyndEnvironments?.prod ?? "https://api.fynd.com"}</code>
            </p>
            <p style={{ fontSize: 12, color: "#6d7175", marginTop: 4 }}>UAT and Prod use different credentials. Use credentials from the matching Fynd environment.</p>
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>Custom URL (optional override)</label>
            <input type="text" name="fyndCustomBaseUrl" defaultValue={data.fyndCustomBaseUrl} placeholder="e.g. https://api.custom.fynd.com" autoComplete="off" style={{ width: "100%", maxWidth: 400, padding: 12, borderRadius: 8, border: "1px solid #e1e3e5", fontSize: 14 }} />
            <p style={{ fontSize: 12, color: "#6d7175", marginTop: 6 }}>Leave empty to use preset. Include https://</p>
          </div>
        </s-section>

        <s-section heading="Credentials">
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>Application ID</label>
            <input type="text" name="fyndApplicationId" defaultValue={data.fyndApplicationId} placeholder="e.g. 67a09b70c8ea7c9123f00fab" autoComplete="off" style={{ width: "100%", padding: 12, borderRadius: 8, border: "1px solid #e1e3e5", fontSize: 14 }} />
            <p style={{ fontSize: 12, color: "#6d7175", marginTop: 6 }}>Shared by both APIs. From Company → Settings → Developers or your sales channel.</p>
          </div>

          <div style={{ marginBottom: 20, padding: "12px 16px", background: "#f6f6f7", borderRadius: 8, border: "1px solid #e1e3e5" }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Platform API (optional)</div>
            <p style={{ fontSize: 12, color: "#6d7175", marginBottom: 12 }}>Required for creating returns on Fynd and refreshing details. Company ID + Client ID & Secret (OAuth).</p>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: "block", marginBottom: 6, fontWeight: 500 }}>Company ID</label>
              <input type="text" name="fyndCompanyId" defaultValue={data.fyndCompanyId} placeholder="e.g. 2263" autoComplete="off" style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #e1e3e5", fontSize: 14 }} />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ display: "block", marginBottom: 6, fontWeight: 500 }}>Client ID</label>
              <input type="text" name="fyndClientId" placeholder="Client ID" autoComplete="off" style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #e1e3e5", fontSize: 14 }} />
            </div>
            <div>
              <label style={{ display: "block", marginBottom: 6, fontWeight: 500 }}>Client Secret</label>
              <input type="text" name="fyndClientSecret" placeholder="Client Secret" autoComplete="off" style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #e1e3e5", fontSize: 14 }} />
            </div>
          </div>

          <div style={{ marginBottom: 16, padding: "12px 16px", background: "#f6f6f7", borderRadius: 8, border: "1px solid #e1e3e5" }}>
            <div style={{ fontWeight: 600, marginBottom: 8 }}>Storefront API (optional)</div>
            <p style={{ fontSize: 12, color: "#6d7175", marginBottom: 12 }}>For storefront features. Application Token (Basic auth).</p>
            <div>
              <label style={{ display: "block", marginBottom: 6, fontWeight: 500 }}>Application Token</label>
              <input type="text" name="fyndApplicationToken" placeholder="Application Token" autoComplete="off" style={{ width: "100%", padding: 10, borderRadius: 8, border: "1px solid #e1e3e5", fontSize: 14 }} />
              <p style={{ fontSize: 12, color: "#6d7175", marginTop: 6 }}>Company → Settings → Developers → Application Token tab.</p>
            </div>
          </div>

          {data.fyndCredentials && (
            <p style={{ fontSize: 13, color: "#008060", marginTop: 8, fontWeight: 500 }}>
              ✓ Credentials configured ({[data.hasPlatformCreds && "Platform", data.hasStorefrontCreds && "Storefront"].filter(Boolean).join(", ")}). Enter new values to replace; leave blank to keep existing.
            </p>
          )}
        </s-section>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>Policy (JSON)</label>
          <textarea name="policyJson" rows={4} defaultValue={data.policyJson} style={{ width: "100%", padding: 12, borderRadius: 8, border: "1px solid #e1e3e5", fontFamily: "monospace", fontSize: 13 }} />
        </div>

        <div style={{ marginTop: 24, display: "flex", gap: 12, flexWrap: "wrap" }}>
          <s-button type="submit" loading={fetcher.state !== "idle"}>Save</s-button>
          {data.hasPlatformCreds && (
            <button type="submit" name="intent" value="test_platform" disabled={fetcher.state !== "idle"} style={{ padding: "10px 20px", borderRadius: 8, border: "1px solid #e1e3e5", background: "#fff", color: "#202223", fontSize: 14, fontWeight: 500, cursor: fetcher.state !== "idle" ? "not-allowed" : "pointer" }}>
              {fetcher.state !== "idle" ? "Please wait..." : "Test Platform"}
            </button>
          )}
          {data.hasStorefrontCreds && (
            <button type="submit" name="intent" value="test_storefront" disabled={fetcher.state !== "idle"} style={{ padding: "10px 20px", borderRadius: 8, border: "1px solid #e1e3e5", background: "#fff", color: "#202223", fontSize: 14, fontWeight: 500, cursor: fetcher.state !== "idle" ? "not-allowed" : "pointer" }}>
              {fetcher.state !== "idle" ? "Please wait..." : "Test Storefront"}
            </button>
          )}
          {(!data.hasPlatformCreds && !data.hasStorefrontCreds) && (
            <button type="submit" name="intent" value="test" disabled={fetcher.state !== "idle"} style={{ padding: "10px 20px", borderRadius: 8, border: "1px solid #e1e3e5", background: "#fff", color: "#202223", fontSize: 14, fontWeight: 500, cursor: fetcher.state !== "idle" ? "not-allowed" : "pointer" }}>
              {fetcher.state !== "idle" ? "Please wait..." : "Test connection"}
            </button>
          )}
          {data.fyndCredentials && (
            <button type="submit" name="intent" value="clear_token" disabled={fetcher.state !== "idle"} style={{ padding: "10px 20px", borderRadius: 8, border: "1px solid #d72c0d", background: "#fff", color: "#d72c0d", fontSize: 14, fontWeight: 500, cursor: fetcher.state !== "idle" ? "not-allowed" : "pointer" }}>Clear credentials</button>
          )}
          <Link to="/app/settings"><s-button variant="secondary" type="button">Discard</s-button></Link>
        </div>
      </fetcher.Form>
    </s-page>
  );
}
