import * as React from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { encrypt } from "../lib/encryption.server";
import { createFyndClient } from "../lib/fynd.server";
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
  return {
    fyndApiType: (s as { fyndApiType?: string })?.fyndApiType ?? "platform",
    fyndEnvironment: (s as { fyndEnvironment?: string })?.fyndEnvironment ?? "uat",
    fyndCustomBaseUrl: (s as { fyndCustomBaseUrl?: string })?.fyndCustomBaseUrl ?? "",
    appMode: getAppMode(s ?? {}),
    fyndCompanyId: s?.fyndCompanyId ?? "",
    fyndApplicationId: s?.fyndApplicationId ?? "",
    fyndCredentials: s?.fyndCredentials ? "[configured]" : "",
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

    if (intent === "test") {
      const apiType = (formData.get("fyndApiType") as string) || "platform";
      const fyndEnvironment = (formData.get("fyndEnvironment") as string) || "uat";
      const fyndCustomBaseUrl = String(formData.get("fyndCustomBaseUrl") ?? "").trim();
      const fyndCompanyId = String(formData.get("fyndCompanyId") ?? "").trim();
      const fyndApplicationId = String(formData.get("fyndApplicationId") ?? "").trim();
      const fyndClientId = String(formData.get("fyndClientId") ?? "").trim();
      const fyndClientSecret = String(formData.get("fyndClientSecret") ?? "").trim();
      const fyndApplicationToken = String(formData.get("fyndApplicationToken") ?? "").trim();

      const validation = sanitizeCredentialInputs({
        fyndCompanyId: fyndCompanyId || undefined,
        fyndApplicationId: fyndApplicationId || undefined,
        fyndClientId: fyndClientId || undefined,
        fyndClientSecret: fyndClientSecret || undefined,
        fyndApplicationToken: fyndApplicationToken || undefined,
        fyndCustomBaseUrl: fyndCustomBaseUrl || undefined,
      });
      if (!validation.valid) {
        return { success: false, error: validation.error, testResult: false, debugLogs: logs };
      }
      const v = validation.sanitized!;

      const envSettings = { fyndEnvironment, fyndCustomBaseUrl: (v.fyndCustomBaseUrl || fyndCustomBaseUrl) || null };
      log("test", "Form", `apiType=${apiType} env=${fyndEnvironment} companyId=*** appId=***`);

      if (apiType === "platform") {
        if (!v.fyndCompanyId || !v.fyndApplicationId || !v.fyndClientId || !v.fyndClientSecret) {
          return { success: false, error: "Platform API requires Company ID, Application ID, Client ID, and Client Secret.", testResult: false, debugLogs: logs };
        }
        try {
          const client = await createFyndClient({
            ...envSettings,
            fyndCompanyId: v.fyndCompanyId,
            fyndApplicationId: v.fyndApplicationId,
            fyndCredentials: JSON.stringify({ apiType: "platform", clientId: v.fyndClientId, clientSecret: v.fyndClientSecret }),
          }, log);
          if (!client) return { success: false, error: "Failed to create Platform client.", testResult: false, debugLogs: logs };
          await client.testConnection();
          return { success: true, testResult: true, testMessage: "Platform API connection successful.", debugLogs: logs };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : "Connection failed.", testResult: false, debugLogs: logs };
        }
      }

      if (apiType === "storefront") {
        if (!v.fyndApplicationId || !v.fyndApplicationToken) {
          return { success: false, error: "Storefront API requires Application ID and Application Token.", testResult: false, debugLogs: logs };
        }
        try {
          const client = await createFyndClient({
            ...envSettings,
            fyndCompanyId: null,
            fyndApplicationId: v.fyndApplicationId,
            fyndCredentials: JSON.stringify({ apiType: "storefront", applicationToken: v.fyndApplicationToken }),
          }, log);
          if (!client) return { success: false, error: "Failed to create Storefront client.", testResult: false, debugLogs: logs };
          await client.testConnection();
          return { success: true, testResult: true, testMessage: "Storefront API connection successful.", debugLogs: logs };
        } catch (err) {
          return { success: false, error: err instanceof Error ? err.message : "Connection failed.", testResult: false, debugLogs: logs };
        }
      }

      return { success: false, error: "Invalid API type.", testResult: false, debugLogs: logs };
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
    const fyndApiType = (formData.get("fyndApiType") as string) || "platform";
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

    let credsToStore: string | null = null;
    if (fyndApiType === "platform" && v.fyndCompanyId && v.fyndApplicationId && v.fyndClientId && v.fyndClientSecret) {
      credsToStore = encrypt(JSON.stringify({ apiType: "platform", clientId: v.fyndClientId, clientSecret: v.fyndClientSecret }));
    } else if (fyndApiType === "storefront" && v.fyndApplicationId && v.fyndApplicationToken) {
      credsToStore = encrypt(JSON.stringify({ apiType: "storefront", applicationToken: v.fyndApplicationToken }));
    }

    await prisma.shopSettings.upsert({
      where: { shopId: shop.id },
      create: {
        shopId: shop.id,
        fyndApiType: fyndApiType || null,
        fyndEnvironment: fyndEnvironment || null,
        fyndCustomBaseUrl: (v.fyndCustomBaseUrl || fyndCustomBaseUrl) || null,
        appMode: appMode === "dev" ? "dev" : "prod",
        fyndCompanyId: v.fyndCompanyId || null,
        fyndApplicationId: v.fyndApplicationId || null,
        fyndCredentials: credsToStore,
        policyJson: (v.policyJson ?? policyJson) || null,
      },
      update: {
        fyndApiType: fyndApiType || undefined,
        fyndEnvironment: fyndEnvironment || undefined,
        fyndCustomBaseUrl: (v.fyndCustomBaseUrl || fyndCustomBaseUrl) || undefined,
        appMode: appMode === "dev" ? "dev" : "prod",
        fyndCompanyId: v.fyndCompanyId || undefined,
        fyndApplicationId: v.fyndApplicationId || undefined,
        fyndCredentials: credsToStore ?? undefined,
        policyJson: (v.policyJson ?? policyJson) || undefined,
      },
    });

    return { success: true, tokenUpdated: !!credsToStore, debugLogs: logs };
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
  const [apiType, setApiType] = React.useState(data.fyndApiType);
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
          Connect Fynd for reverse logistics. Choose environment, API type, and enter credentials from <a href="https://platform.fynd.com" target="_blank" rel="noreferrer" style={{ color: "#005bd3" }}>Fynd Platform</a>.
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

        <s-section heading="API Type">
          <div style={{ display: "flex", gap: 24, marginBottom: 16 }}>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input type="radio" name="fyndApiType" value="platform" checked={apiType === "platform"} onChange={() => setApiType("platform")} />
              <span><strong>Platform API</strong> — Order management, returns, shipments. Uses Client ID + Secret (OAuth).</span>
            </label>
            <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
              <input type="radio" name="fyndApiType" value="storefront" checked={apiType === "storefront"} onChange={() => setApiType("storefront")} />
              <span><strong>Storefront API</strong> — Customer-facing storefront. Uses Application ID + Token (Basic auth).</span>
            </label>
          </div>
        </s-section>

        <s-section heading="Credentials">
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>Application ID</label>
            <input type="text" name="fyndApplicationId" defaultValue={data.fyndApplicationId} placeholder="e.g. 67a09b70c8ea7c9123f00fab" autoComplete="off" style={{ width: "100%", padding: 12, borderRadius: 8, border: "1px solid #e1e3e5", fontSize: 14 }} />
            <p style={{ fontSize: 12, color: "#6d7175", marginTop: 6 }}>From Company → Settings → Developers → Application Token (Storefront) or your sales channel.</p>
          </div>

          {apiType === "platform" && (
            <>
              <input type="hidden" name="fyndApplicationToken" value="" />
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>Company ID</label>
                <input type="text" name="fyndCompanyId" defaultValue={data.fyndCompanyId} placeholder="e.g. 2263" autoComplete="off" style={{ width: "100%", padding: 12, borderRadius: 8, border: "1px solid #e1e3e5", fontSize: 14 }} />
                <p style={{ fontSize: 12, color: "#6d7175", marginTop: 6 }}>From Fynd Platform → Developers → Clients.</p>
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>Client ID</label>
                <input type="text" name="fyndClientId" placeholder="Client ID" autoComplete="off" style={{ width: "100%", padding: 12, borderRadius: 8, border: "1px solid #e1e3e5", fontSize: 14 }} />
              </div>
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>Client Secret</label>
                <input type="text" name="fyndClientSecret" placeholder="Client Secret" autoComplete="off" style={{ width: "100%", padding: 12, borderRadius: 8, border: "1px solid #e1e3e5", fontSize: 14 }} />
                <p style={{ fontSize: 12, color: "#6d7175", marginTop: 6 }}>Company → Settings → Developers → Clients → Create Client.</p>
              </div>
            </>
          )}

          {apiType === "storefront" && (
            <>
              <input type="hidden" name="fyndCompanyId" value="" />
              <input type="hidden" name="fyndClientId" value="" />
              <input type="hidden" name="fyndClientSecret" value="" />
              <div style={{ marginBottom: 16 }}>
                <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>Application Token</label>
              <input type="text" name="fyndApplicationToken" placeholder="Application Token" autoComplete="off" style={{ width: "100%", padding: 12, borderRadius: 8, border: "1px solid #e1e3e5", fontSize: 14 }} />
              <p style={{ fontSize: 12, color: "#6d7175", marginTop: 6 }}>Company → Settings → Developers → Application Token tab.</p>
              </div>
            </>
          )}

          {data.fyndCredentials && (
            <p style={{ fontSize: 13, color: "#008060", marginTop: 8, fontWeight: 500 }}>✓ Credentials configured. Enter new values to replace.</p>
          )}
        </s-section>

        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>Policy (JSON)</label>
          <textarea name="policyJson" rows={4} defaultValue={data.policyJson} style={{ width: "100%", padding: 12, borderRadius: 8, border: "1px solid #e1e3e5", fontFamily: "monospace", fontSize: 13 }} />
        </div>

        <div style={{ marginTop: 24, display: "flex", gap: 12, flexWrap: "wrap" }}>
          <s-button type="submit" loading={fetcher.state !== "idle"}>Save</s-button>
          <button type="submit" name="intent" value="test" disabled={fetcher.state !== "idle"} style={{ padding: "10px 20px", borderRadius: 8, border: "1px solid #e1e3e5", background: "#fff", color: "#202223", fontSize: 14, fontWeight: 500, cursor: fetcher.state !== "idle" ? "not-allowed" : "pointer" }}>
            {fetcher.state !== "idle" ? "Please wait..." : "Test connection"}
          </button>
          {data.fyndCredentials && (
            <button type="submit" name="intent" value="clear_token" disabled={fetcher.state !== "idle"} style={{ padding: "10px 20px", borderRadius: 8, border: "1px solid #d72c0d", background: "#fff", color: "#d72c0d", fontSize: 14, fontWeight: 500, cursor: fetcher.state !== "idle" ? "not-allowed" : "pointer" }}>Clear credentials</button>
          )}
          <Link to="/app/settings"><s-button variant="secondary" type="button">Discard</s-button></Link>
        </div>
      </fetcher.Form>
    </s-page>
  );
}
