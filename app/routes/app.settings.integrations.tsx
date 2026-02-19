import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { encrypt } from "../lib/encryption.server";
import { createFyndClient, FyndClient } from "../lib/fynd.server";
import { createFyndLogger } from "../lib/fynd-logger.server";

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
    fyndCompanyId: s?.fyndCompanyId || "",
    fyndApplicationId: s?.fyndApplicationId || "",
    fyndCredentials: s?.fyndCredentials ? "[encrypted]" : "",
    policyJson: s?.policyJson || "{}",
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { logs, log } = createFyndLogger();
  const { session } = await authenticate.admin(request);
  log("action", "Request received", `shop=${session.shop}`);

  const formData = await request.formData();
  const intent = formData.get("intent") as string | null;
  log("action", "Form parsed", `intent=${intent ?? "save"}`);

  // Test credentials (real-time API call)
  if (intent === "test") {
    const fyndCompanyId = String(formData.get("fyndCompanyId") ?? "").trim();
    const fyndApplicationId = String(formData.get("fyndApplicationId") ?? "").trim();
    const fyndCredentialsRaw = formData.get("fyndCredentials");
    const fyndCredentialsFromForm = typeof fyndCredentialsRaw === "string" ? fyndCredentialsRaw.trim() : "";

    log("test", "Form values", `companyId=${fyndCompanyId}, appId=${fyndApplicationId}, tokenFromForm=${fyndCredentialsFromForm ? `present(${fyndCredentialsFromForm.length} chars)` : "empty"}`);

    if (!fyndCompanyId || !fyndApplicationId) {
      log("test", "Validation failed", "Company ID and Application ID required");
      return { success: false, error: "Company ID and Application ID are required to test.", testResult: false, debugLogs: logs };
    }

    let shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop }, include: { settings: true } });
    if (!shop) shop = await prisma.shop.create({ data: { shopDomain: session.shop }, include: { settings: true } });
    log("test", "Shop loaded", `hasSettings=${!!shop.settings}, hasStoredCreds=${!!shop.settings?.fyndCredentials}`);

    let token = fyndCredentialsFromForm;
    if (!token && shop.settings?.fyndCredentials) {
      log("test", "Using stored token", "Attempting to decrypt and create client");
      const client = createFyndClient(shop.settings, log);
      if (client) {
        try {
          log("test", "Calling Fynd API", "getReturnReasons");
          await client.getReturnReasons();
          log("test", "API success", "Connection valid");
          return { success: true, testResult: true, testMessage: "Connection successful. Credentials are valid.", debugLogs: logs };
        } catch (err) {
          const msg = err instanceof Error ? err.message : "Connection failed.";
          log("test", "API failed", String(err));
          return { success: false, error: msg, testResult: false, debugLogs: logs };
        }
      }
      log("test", "createFyndClient returned null", "Decryption or token extraction failed");
      return { success: false, error: "No token available. Enter a token and save, or use Test after saving.", testResult: false, debugLogs: logs };
    }
    if (!token) {
      log("test", "No token", "Neither form nor stored");
      return { success: false, error: "No token available. Enter a token to test.", testResult: false, debugLogs: logs };
    }

    try {
      log("test", "Using form token", `length=${token.length}`);
      const client = new FyndClient(fyndCompanyId, fyndApplicationId, token, log);
      log("test", "Calling Fynd API", "getReturnReasons");
      await client.getReturnReasons();
      log("test", "API success", "Connection valid");
      return { success: true, testResult: true, testMessage: "Connection successful. Credentials are valid.", debugLogs: logs };
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Connection failed.";
      log("test", "API failed", String(err));
      return { success: false, error: msg, testResult: false, debugLogs: logs };
    }
  }

  // Clear stored token
  if (intent === "clear_token") {
    log("clear", "Clearing stored token");
    let shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
    if (!shop) shop = await prisma.shop.create({ data: { shopDomain: session.shop } });
    await prisma.shopSettings.upsert({
      where: { shopId: shop.id },
      create: { shopId: shop.id, fyndCredentials: null },
      update: { fyndCredentials: null },
    });
    log("clear", "Token cleared");
    return { success: true, cleared: true, debugLogs: logs };
  }

  // Save
  const fyndCompanyId = String(formData.get("fyndCompanyId") ?? "").trim();
  const fyndApplicationId = String(formData.get("fyndApplicationId") ?? "").trim();
  const fyndCredentialsRaw = formData.get("fyndCredentials");
  const fyndCredentials = typeof fyndCredentialsRaw === "string" ? fyndCredentialsRaw.trim() : "";
  const policyJson = String(formData.get("policyJson") ?? "{}").trim();

  log("save", "Form values", `companyId=${fyndCompanyId}, appId=${fyndApplicationId}, tokenFromForm=${fyndCredentials ? `present(${fyndCredentials.length} chars)` : "empty"}`);

  let shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop }, include: { settings: true } });
  if (!shop) shop = await prisma.shop.create({ data: { shopDomain: session.shop }, include: { settings: true } });
  log("save", "Shop loaded", `hasSettings=${!!shop.settings}`);

  let credsToStore: string | null | undefined = shop.settings?.fyndCredentials;
  if (fyndCredentials.length > 0) {
    try {
      log("save", "Encrypting token");
      credsToStore = encrypt(JSON.stringify({ accessToken: fyndCredentials }));
      log("save", "Encryption success", `encryptedLength=${credsToStore.length}`);
    } catch (err) {
      log("save", "Encryption failed", String(err));
      return { success: false, error: "Failed to save token. Ensure ENCRYPTION_KEY is set (64-char hex) in production.", debugLogs: logs };
    }
  } else {
    log("save", "No new token in form", "Keeping existing credentials");
  }

  try {
    log("save", "Upserting to database");
    await prisma.shopSettings.upsert({
      where: { shopId: shop.id },
      create: {
        shopId: shop.id,
        fyndCompanyId: fyndCompanyId || null,
        fyndApplicationId: fyndApplicationId || null,
        fyndCredentials: credsToStore ?? null,
        policyJson: policyJson || null,
      },
      update: {
        fyndCompanyId: fyndCompanyId || undefined,
        fyndApplicationId: fyndApplicationId || undefined,
        fyndCredentials: credsToStore !== undefined ? credsToStore : undefined,
        policyJson: policyJson || undefined,
      },
    });
    log("save", "Database upsert success", `tokenUpdated=${fyndCredentials.length > 0}`);
  } catch (err) {
    log("save", "Database upsert failed", String(err));
    return { success: false, error: "Failed to save settings. Please try again.", debugLogs: logs };
  }
  return { success: true, tokenUpdated: fyndCredentials.length > 0, debugLogs: logs };
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

  const showSaveSuccess = fetcher.data && "success" in fetcher.data && !("testResult" in fetcher.data) && !("cleared" in fetcher.data);
  const showCleared = fetcher.data && "cleared" in fetcher.data;
  const showTestSuccess = fetcher.data && "testResult" in fetcher.data && fetcher.data.testResult;
  const showTestError = fetcher.data && "testResult" in fetcher.data && !fetcher.data.testResult && fetcher.data.error;

  return (
    <s-page heading="Partner Integrations">
      {fetcher.data && "error" in fetcher.data && fetcher.data.error && !showTestError && (
        <div style={{ padding: 12, marginBottom: 16, background: "#fef2f2", borderRadius: 8, color: "#d72c0d" }}>
          {fetcher.data.error}
        </div>
      )}
      {showSaveSuccess && (
        <div style={{ padding: 12, marginBottom: 16, background: "#e8f5e9", borderRadius: 8, color: "#2e7d32" }}>
          {fetcher.data && "tokenUpdated" in fetcher.data && fetcher.data.tokenUpdated
            ? "Token saved successfully."
            : "Settings saved successfully."}
        </div>
      )}
      {showCleared && (
        <div style={{ padding: 12, marginBottom: 16, background: "#e8f5e9", borderRadius: 8, color: "#2e7d32" }}>
          Stored token cleared. Enter a new token and click Save.
        </div>
      )}
      {showTestSuccess && (
        <div style={{ padding: 12, marginBottom: 16, background: "#e8f5e9", borderRadius: 8, color: "#2e7d32" }}>
          ✓ {fetcher.data.testMessage ?? "Connection successful. Credentials are valid."}
        </div>
      )}
      {showTestError && (
        <div style={{ padding: 12, marginBottom: 16, background: "#fef2f2", borderRadius: 8, color: "#d72c0d" }}>
          <div style={{ fontWeight: 500, marginBottom: 6 }}>Connection failed: {fetcher.data.error}</div>
          <div style={{ fontSize: 13, opacity: 0.9 }}>
            The stored token may be invalid or expired. Enter a new token in the field below and click <strong>Save</strong> first, then <strong>Test connection</strong>.
          </div>
        </div>
      )}

      {fetcher.data?.debugLogs && fetcher.data.debugLogs.length > 0 && (
        <details style={{ marginBottom: 24, border: "1px solid #e1e3e5", borderRadius: 8, overflow: "hidden" }} open={!!showTestError || !!fetcher.data?.error}>
          <summary style={{ padding: 12, background: "#f6f6f7", cursor: "pointer", fontWeight: 600, fontSize: 14 }}>
            Debug logs ({fetcher.data.debugLogs.length} entries)
          </summary>
          <pre style={{ margin: 0, padding: 16, background: "#1e1e1e", color: "#d4d4d4", fontSize: 12, overflow: "auto", maxHeight: 400 }}>
            {fetcher.data.debugLogs.map((e, i) => (
              <div key={i} style={{ marginBottom: 4, fontFamily: "monospace" }}>
                [{e.ts}] {e.step}: {e.message}{e.detail ? ` | ${e.detail}` : ""}
              </div>
            ))}
          </pre>
        </details>
      )}

      <fetcher.Form method="post">
        <p style={{ marginBottom: 24, color: "#6d7175", fontSize: 14 }}>
          Manage your partner integrations. Connect Fynd for reverse logistics and return fulfillment.
        </p>
        <s-section heading="Fynd integration">
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>Fynd Company ID</label>
            <input
              type="text"
              name="fyndCompanyId"
              defaultValue={data.fyndCompanyId}
              placeholder="e.g. 2263"
              autoComplete="off"
              style={{ width: "100%", padding: 12, borderRadius: 8, border: "1px solid #e1e3e5", fontSize: 14 }}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>Fynd Application ID</label>
            <input
              type="text"
              name="fyndApplicationId"
              defaultValue={data.fyndApplicationId}
              placeholder="e.g. 67a09b70c8ea7c9123f00fab"
              autoComplete="off"
              style={{ width: "100%", padding: 12, borderRadius: 8, border: "1px solid #e1e3e5", fontSize: 14 }}
            />
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>Fynd Access Token</label>
            <div style={{ position: "relative" }}>
              <input
                type="text"
                name="fyndCredentials"
                placeholder="Enter token to save, or leave blank to keep existing"
                autoComplete="off"
                style={{ width: "100%", padding: 12, borderRadius: 8, border: "1px solid #e1e3e5", fontSize: 14, fontFamily: "monospace" }}
              />
              <p style={{ fontSize: 12, color: "#6d7175", marginTop: 6 }}>
                Using text field (password fields often fail to submit in embedded apps)
              </p>
            </div>
            {data.fyndCredentials ? (
              <p style={{ fontSize: 13, color: "#008060", marginTop: 6, fontWeight: 500 }}>✓ Token configured (hidden for security). Enter a new token to replace it.</p>
            ) : (
              <p style={{ fontSize: 13, color: "#6d7175", marginTop: 6 }}>Enter your Fynd access token. Use Bearer token for Platform APIs, or base64(application_id:application_token) for Application APIs.</p>
            )}
          </div>
          <div style={{ marginBottom: 16 }}>
            <label style={{ display: "block", marginBottom: 8, fontWeight: 600 }}>Policy (JSON)</label>
            <textarea name="policyJson" rows={4} defaultValue={data.policyJson} style={{ width: "100%", padding: 12, borderRadius: 8, border: "1px solid #e1e3e5", fontFamily: "monospace", fontSize: 13 }} />
          </div>
        </s-section>
        <div style={{ marginTop: 24, display: "flex", gap: 12, flexWrap: "wrap" }}>
          <s-button type="submit" loading={fetcher.state !== "idle"}>Save</s-button>
          <button
            type="submit"
            name="intent"
            value="test"
            disabled={fetcher.state !== "idle"}
            style={{
              padding: "10px 20px",
              borderRadius: 8,
              border: "1px solid #e1e3e5",
              background: "#fff",
              color: "#202223",
              fontSize: 14,
              fontWeight: 500,
              cursor: fetcher.state !== "idle" ? "not-allowed" : "pointer",
            }}
          >
            {fetcher.state !== "idle" ? "Please wait..." : "Test connection"}
          </button>
          {data.fyndCredentials && (
            <button
              type="submit"
              name="intent"
              value="clear_token"
              disabled={fetcher.state !== "idle"}
              style={{
                padding: "10px 20px",
                borderRadius: 8,
                border: "1px solid #d72c0d",
                background: "#fff",
                color: "#d72c0d",
                fontSize: 14,
                fontWeight: 500,
                cursor: fetcher.state !== "idle" ? "not-allowed" : "pointer",
              }}
            >
              Clear stored token
            </button>
          )}
          <Link to="/app/settings">
            <s-button variant="secondary" type="button">Discard</s-button>
          </Link>
        </div>
      </fetcher.Form>
    </s-page>
  );
}
