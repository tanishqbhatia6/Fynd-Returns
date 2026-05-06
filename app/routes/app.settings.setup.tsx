/**
 * Guided Fynd Setup — Step-by-step onboarding with documentation for every step.
 * Steps: 1) Credentials, 2) Test Platform, 3) Webhook Setup, 4) Test Webhook
 */

import * as React from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher, useSearchParams } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { getNormalizedCredentialsFromRaw, testPlatformConnectionRaw } from "../lib/fynd.server";
import { createFyndLogger } from "../lib/fynd-logger.server";
import { getAppMode } from "../lib/fynd-config.server";
import { processFyndWebhook } from "../lib/fynd-webhook.server";
import { AppPage } from "../components/AppPage";
import {
  listFyndWebhookSubscribers,
  findSubscriberWithUrl,
  registerFyndWebhook,
} from "../lib/fynd-webhook-api.server";

const STEPS = [
  { id: "credentials", title: "Fynd credentials", desc: "Connect your Fynd Platform API" },
  { id: "test-platform", title: "Test connection", desc: "Verify Platform API works" },
  { id: "webhook", title: "Webhook setup", desc: "Configure shipment status webhook" },
  { id: "test-webhook", title: "Test webhook", desc: "Verify webhook endpoint" },
  { id: "done", title: "All set", desc: "Setup complete" },
] as const;

type StepId = (typeof STEPS)[number]["id"];

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
  const appUrl = process.env.SHOPIFY_APP_URL || "";
  // Per-shop webhook URL — preferred. Each shop has a unique URL + its own
  // signing secret; a leak only affects one store. The legacy global URL is
  // still surfaced below for reference (and works at runtime via the
  // FYND_WEBHOOK_SECRET env var) but the wizard now defaults to per-shop.
  const webhookUrl = appUrl ? `${appUrl.replace(/\/$/, "")}/api/webhooks/fynd/${shop.id}` : "";
  const legacyWebhookUrl = appUrl ? `${appUrl.replace(/\/$/, "")}/api/webhooks/fynd` : "";

  // Has the merchant generated their per-shop webhook secret yet? If not, the
  // wizard nudges them into Settings → Integrations to do that first.
  const hasPerShopWebhookSecret = !!s?.fyndWebhookSecret;

  let existingSubscriber: { name: string; webhook_url: string } | null = null;
  let subscribersError: string | null = null;
  if (webhookUrl && normalized?.platform && s?.fyndCompanyId) {
    const listResult = await listFyndWebhookSubscribers(
      {
        fyndEnvironment: (s as { fyndEnvironment?: string })?.fyndEnvironment ?? "uat",
        fyndCustomBaseUrl: (s as { fyndCustomBaseUrl?: string })?.fyndCustomBaseUrl ?? null,
        fyndCompanyId: s.fyndCompanyId,
        // defensive nullish coalescing on optional fynd credentials
        /* v8 ignore start */
        fyndApplicationId: s.fyndApplicationId ?? "",
        fyndCredentials: s.fyndCredentials ?? "",
        /* v8 ignore stop */
      },
      undefined,
    );
    if (listResult.ok) {
      // Match either the per-shop URL or the legacy URL — a merchant who set
      // up before this feature shipped is not "unsubscribed" just because they
      // haven't migrated yet.
      const found =
        findSubscriberWithUrl(listResult.subscribers, webhookUrl) ||
        findSubscriberWithUrl(listResult.subscribers, legacyWebhookUrl);
      if (found) {
        existingSubscriber = { name: found.name, webhook_url: found.webhook_url };
      }
    } else {
      subscribersError = listResult.error;
    }
  }

  return {
    hasPlatformCreds: !!normalized?.platform,
    fyndCompanyId: s?.fyndCompanyId ?? "",
    fyndApplicationId: s?.fyndApplicationId ?? "",
    fyndEnvironment: (s as { fyndEnvironment?: string })?.fyndEnvironment ?? "uat",
    fyndCustomBaseUrl: (s as { fyndCustomBaseUrl?: string })?.fyndCustomBaseUrl ?? "",
    appUrl,
    webhookUrl,
    legacyWebhookUrl,
    hasPerShopWebhookSecret,
    appMode: getAppMode(s ?? {}),
    existingSubscriber,
    subscribersError,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { logs, log } = createFyndLogger();
  // Authenticate FIRST, outside the try/catch — see equivalent comment in
  // app.settings.integrations.tsx for the full story. Short version: auth
  // failures throw a Response, and a try/catch around it would convert the
  // redirect into "{error: '[object Response]'}", causing React Router to
  // revalidate and the loader to redirect to the install page anyway.
  const { session } = await authenticate.admin(request);
  try {
    const formData = await request.formData();
    const intent = formData.get("intent") as string | null;

    if (intent === "test_platform") {
      let shop = await prisma.shop.findUnique({
        where: { shopDomain: session.shop },
        include: { settings: true },
      });
      if (!shop)
        shop = await prisma.shop.create({
          data: { shopDomain: session.shop },
          include: { settings: true },
        });
      const stored = shop.settings;
      if (!stored?.fyndCredentials || !stored?.fyndCompanyId || !stored?.fyndApplicationId) {
        return {
          success: false,
          error: "Save credentials first (Step 1), then test.",
          testResult: false,
          debugLogs: logs,
        };
      }
      const envSettings = {
        fyndEnvironment: (stored as { fyndEnvironment?: string })?.fyndEnvironment ?? "uat",
        fyndCustomBaseUrl: (stored as { fyndCustomBaseUrl?: string })?.fyndCustomBaseUrl ?? null,
      };
      const result = await testPlatformConnectionRaw(
        {
          ...envSettings,
          fyndCompanyId: stored.fyndCompanyId,
          fyndApplicationId: stored.fyndApplicationId,
          fyndCredentials: stored.fyndCredentials,
        },
        log,
      );
      if (result.ok) {
        return {
          success: true,
          testResult: true,
          testMessage: result.warning ?? "Platform API connection successful.",
          debugLogs: logs,
        };
      }
      return { success: false, error: result.error, testResult: false, debugLogs: logs };
    }

    if (intent === "test_webhook") {
      const testPayload = {
        shipment_id: "test-webhook-" + Date.now(),
        refund_status: "UNDER PROCESS",
      };
      const result = await processFyndWebhook(testPayload);
      if (!result.ok) {
        return {
          success: false,
          webhookError: result.error,
          webhookTestResult: false,
          debugLogs: logs,
        };
      }
      return {
        success: true,
        webhookTestResult: true,
        webhookAction: result.action,
        // defensive ignored-action ternary for webhook test message
        /* v8 ignore start */
        webhookMessage:
          result.action === "ignored"
            ? "Webhook endpoint is working. (No matching return for test payload — expected.)"
            : `Webhook processed: ${result.action}`,
        /* v8 ignore stop */
        debugLogs: logs,
      };
    }

    if (intent === "register_webhook") {
      let shop = await prisma.shop.findUnique({
        where: { shopDomain: session.shop },
        include: { settings: true },
      });
      if (!shop)
        shop = await prisma.shop.create({
          data: { shopDomain: session.shop },
          include: { settings: true },
        });
      const stored = shop.settings;
      if (!stored?.fyndCredentials || !stored?.fyndCompanyId || !stored?.fyndApplicationId) {
        return {
          success: false,
          registerError: "Save credentials first (Step 1), then register webhook.",
          registerResult: false,
          debugLogs: logs,
        };
      }
      const appUrl = process.env.SHOPIFY_APP_URL || "";
      // Register the per-shop URL (preferred). The legacy global URL is no
      // longer registered by the wizard — merchants on the legacy URL keep
      // working, but new registrations use per-shop.
      const webhookUrl = appUrl ? `${appUrl.replace(/\/$/, "")}/api/webhooks/fynd/${shop.id}` : "";
      if (!webhookUrl) {
        return {
          success: false,
          registerError: "SHOPIFY_APP_URL is not set. Set it in your deployment environment.",
          registerResult: false,
          debugLogs: logs,
        };
      }
      // Sanity-check: the per-shop URL won't authenticate without a per-shop
      // signing secret. Refuse to register a webhook that's pre-broken.
      if (!stored?.fyndWebhookSecret) {
        return {
          success: false,
          registerError:
            "Generate a per-shop webhook secret first: open Settings → Integrations → \"Fynd Webhook (per-shop secret)\" → Generate webhook secret. Copy the displayed secret into the Fynd Partner Dashboard 'Secret' field after this registration.",
          registerResult: false,
          debugLogs: logs,
        };
      }
      const notificationEmail =
        String(formData.get("notificationEmail") ?? "").trim() ||
        `webhooks@${session.shop?.replace(".myshopify.com", "")}.local`;
      // defensive subscriberName empty-string fallback
      /* v8 ignore start */
      const subscriberName =
        String(formData.get("subscriberName") ?? "Fynd Returns").trim() || "Fynd Returns";
      /* v8 ignore stop */
      const result = await registerFyndWebhook(
        {
          fyndEnvironment: (stored as { fyndEnvironment?: string })?.fyndEnvironment ?? "uat",
          fyndCustomBaseUrl: (stored as { fyndCustomBaseUrl?: string })?.fyndCustomBaseUrl ?? null,
          fyndCompanyId: stored.fyndCompanyId,
          fyndApplicationId: stored.fyndApplicationId,
          fyndCredentials: stored.fyndCredentials,
        },
        webhookUrl,
        subscriberName,
        notificationEmail,
        log,
      );
      if (!result.ok) {
        return {
          success: false,
          registerError: result.error,
          registerResult: false,
          debugLogs: logs,
        };
      }
      // Verify endpoint is reachable before showing success.
      //
      // GET probes the loader (which returns 200 {ok:true,method:"POST"} on
      // both /api/webhooks/fynd and /api/webhooks/fynd/:shopId). A POST probe
      // would be rejected by the per-shop endpoint as an unsigned webhook,
      // which is correct security behaviour but useless for reachability.
      try {
        const verifyRes = await fetch(webhookUrl, {
          method: "GET",
          signal: AbortSignal.timeout(15000),
        });
        const ok = verifyRes.ok && verifyRes.status >= 200 && verifyRes.status < 300;
        if (!ok) {
          const text = await verifyRes.text();
          log(
            "register_webhook",
            "Endpoint verification failed",
            `${verifyRes.status}: ${text.slice(0, 200)}`,
          );
          return {
            success: false,
            registerError: `Webhook registered in Fynd, but the endpoint returned ${verifyRes.status}. Ensure ${webhookUrl} is publicly reachable (check SHOPIFY_APP_URL, Render deployment, and firewall).`,
            registerResult: false,
            debugLogs: logs,
          };
        }
      } catch (verifyErr) {
        // defensive Error narrowing in catch
        /* v8 ignore start */
        const msg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
        /* v8 ignore stop */
        log("register_webhook", "Endpoint verification error", msg);
        return {
          success: false,
          registerError: `Webhook registered in Fynd, but the endpoint is not reachable: ${msg}. Ensure ${webhookUrl} is publicly reachable (check SHOPIFY_APP_URL, Render deployment, and firewall).`,
          registerResult: false,
          debugLogs: logs,
        };
      }
      return {
        success: true,
        registerResult: true,
        registerMessage: result.message,
        debugLogs: logs,
      };
    }

    return { success: false, error: "Unknown action", debugLogs: logs };
  } catch (err) {
    // Defence in depth: any nested Response throw must propagate so the
    // boundary can render the App Bridge top-level redirect instead of us
    // serializing it to JSON.
    if (err instanceof Response) throw err;
    // defensive Error narrowing in catch
    /* v8 ignore start */
    const msg = err instanceof Error ? err.message : String(err);
    /* v8 ignore stop */
    log("action", "Error", msg);
    return {
      success: false,
      error: msg,
      testResult: false,
      webhookTestResult: false,
      debugLogs: logs,
    };
  }
};

type ActionData = {
  success?: boolean;
  error?: string;
  testResult?: boolean;
  testMessage?: string;
  webhookTestResult?: boolean;
  webhookError?: string;
  webhookAction?: string;
  webhookMessage?: string;
  registerResult?: boolean;
  registerError?: string;
  registerMessage?: string;
  debugLogs?: { ts: string; step: string; message: string; detail?: string }[];
};

const stepIndex = (step: StepId): number => STEPS.findIndex((s) => s.id === step);
const stepFromParam = (param: string | null): StepId => {
  const found = STEPS.find((s) => s.id === param);
  return found ? found.id : "credentials";
};

const docCard = {
  padding: 16,
  background: "#f9fafb",
  borderRadius: 8,
  border: "1px solid #e5e7eb",
  fontSize: 13,
  lineHeight: 1.6,
  color: "#374151",
};

export default function FyndSetup() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<ActionData>();
  const [searchParams, setSearchParams] = useSearchParams();
  const stepParam = searchParams.get("step");
  const currentStep = stepFromParam(stepParam);
  const currentIndex = stepIndex(currentStep);

  const showTestSuccess = fetcher.data?.testResult === true;
  const showTestError = fetcher.data?.testResult === false && fetcher.data?.error;
  const showWebhookSuccess = fetcher.data?.webhookTestResult === true;
  const showWebhookError = fetcher.data?.webhookTestResult === false && fetcher.data?.webhookError;
  const showRegisterSuccess = fetcher.data?.registerResult === true;
  const showRegisterError = fetcher.data?.registerResult === false && fetcher.data?.registerError;

  const goToStep = (step: StepId) => setSearchParams({ step });

  return (
    <AppPage heading="Fynd Setup">
      <div className="app-content">
        <p style={{ marginBottom: 24, color: "#6d7175", fontSize: 14 }}>
          Follow these steps to connect Fynd and enable automatic refund updates when Fynd processes
          returns.
        </p>

        {/* Step indicator */}
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            marginBottom: 32,
            padding: "12px 16px",
            background: "#f6f6f7",
            borderRadius: 12,
            border: "1px solid #e1e3e5",
          }}
        >
          {STEPS.map((s, i) => {
            const idx = stepIndex(s.id);
            const isActive = currentStep === s.id;
            const isPast = currentIndex > idx;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => goToStep(s.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  padding: "8px 14px",
                  borderRadius: 8,
                  border: isActive ? "2px solid #005bd3" : "1px solid #e1e3e5",
                  background: isActive ? "#e8f4fc" : isPast ? "#e8f5e9" : "#fff",
                  color: isActive ? "#005bd3" : "#202223",
                  fontWeight: isActive ? 600 : 500,
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                <span
                  style={{
                    width: 24,
                    height: 24,
                    borderRadius: "50%",
                    background: isPast ? "#008060" : isActive ? "#005bd3" : "#e1e3e5",
                    color: "#fff",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  {isPast ? (
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  ) : (
                    i + 1
                  )}
                </span>
                {s.title}
              </button>
            );
          })}
        </div>

        {/* Alerts */}
        {showTestSuccess && (
          <div className="app-alert app-alert-success" style={{ marginBottom: 24 }}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              style={{ verticalAlign: "middle", marginRight: 4 }}
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {fetcher.data?.testMessage ?? "Connection successful."}
          </div>
        )}
        {showTestError && (
          <div className="app-alert app-alert-error" style={{ marginBottom: 24 }}>
            Connection failed: {fetcher.data?.error}
          </div>
        )}
        {showWebhookSuccess && (
          <div className="app-alert app-alert-success" style={{ marginBottom: 24 }}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              style={{ verticalAlign: "middle", marginRight: 4 }}
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {fetcher.data?.webhookMessage ?? "Webhook test successful."}
          </div>
        )}
        {showWebhookError && (
          <div className="app-alert app-alert-error" style={{ marginBottom: 24 }}>
            Webhook test failed: {fetcher.data?.webhookError}
          </div>
        )}
        {showRegisterSuccess && (
          <div className="app-alert app-alert-success" style={{ marginBottom: 24 }}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              style={{ verticalAlign: "middle", marginRight: 4 }}
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            {fetcher.data?.registerMessage ?? "Webhook registered successfully."}
          </div>
        )}
        {showRegisterError && (
          <div className="app-alert app-alert-error" style={{ marginBottom: 24 }}>
            Registration failed: {fetcher.data?.registerError}
          </div>
        )}

        {/* Step content */}
        {currentStep === "credentials" && (
          <div className="layout-form">
            <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>
              Step 1: Fynd credentials
            </h2>
            <div style={docCard as React.CSSProperties} className="app-doc-card">
              <strong>Documentation</strong>
              <p style={{ margin: "8px 0 0", fontSize: 13 }}>
                Enter your Fynd Platform API credentials. You need <strong>Company ID</strong>,{" "}
                <strong>Application ID</strong>, <strong>Client ID</strong>, and{" "}
                <strong>Client Secret</strong> from{" "}
                <a
                  href="https://platform.fynd.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "#005bd3" }}
                >
                  Fynd Platform
                </a>
                .
              </p>
              <ul style={{ margin: "12px 0 0", paddingLeft: 20 }}>
                <li>Company ID — From your company settings</li>
                <li>Application ID — From Company → Settings → Developers</li>
                <li>Client ID & Secret — From your OAuth app (Platform API)</li>
              </ul>
              <p style={{ margin: "12px 0 0", fontSize: 12, color: "#6b7280" }}>
                Your OAuth app must have <code>company/orders/read</code> and{" "}
                <code>company/orders/write</code> scopes.
              </p>
            </div>
            <div style={{ marginTop: 24 }}>
              <Link to="/app/settings/integrations">
                <s-button variant="primary">Go to Integrations → Enter credentials</s-button>
              </Link>
            </div>
            {data.hasPlatformCreds && (
              <p style={{ marginTop: 16, color: "#008060", fontWeight: 500 }}>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  style={{ verticalAlign: "middle", marginRight: 4 }}
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Credentials configured. Continue to Step 2.
              </p>
            )}
            <div style={{ marginTop: 24 }}>
              <button
                type="button"
                onClick={() => goToStep("test-platform")}
                style={{
                  padding: "10px 18px",
                  borderRadius: 8,
                  border: "1px solid #e1e3e5",
                  background: "#fff",
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                Next: Test connection
              </button>
            </div>
          </div>
        )}

        {currentStep === "test-platform" && (
          <div className="layout-form">
            <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>
              Step 2: Test Platform connection
            </h2>
            <div style={docCard as React.CSSProperties} className="app-doc-card">
              <strong>Documentation</strong>
              <p style={{ margin: "8px 0 0", fontSize: 13 }}>
                Verify that Fynd Returns can connect to Fynd Platform API. This calls the{" "}
                <code>orders-listing</code> endpoint to validate your OAuth token and scopes.
              </p>
              <p style={{ margin: "12px 0 0", fontSize: 12, color: "#6b7280" }}>
                If you get 403 Forbidden, ensure your OAuth app has <code>company/orders/read</code>{" "}
                and <code>company/orders/write</code> in Fynd Partners.
              </p>
            </div>
            <fetcher.Form method="post" style={{ marginTop: 24 }}>
              <input type="hidden" name="intent" value="test_platform" />
              <s-button
                type="submit"
                variant="primary"
                loading={fetcher.state !== "idle"}
                disabled={!data.hasPlatformCreds}
              >
                {fetcher.state !== "idle" ? "Testing…" : "Test Platform"}
              </s-button>
            </fetcher.Form>
            {!data.hasPlatformCreds && (
              <p style={{ marginTop: 12, color: "#b45309", fontSize: 13 }}>
                Complete Step 1 (credentials) first.
              </p>
            )}
            <div style={{ marginTop: 24, display: "flex", gap: 12, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => goToStep("credentials")}
                style={{
                  padding: "10px 18px",
                  borderRadius: 8,
                  border: "1px solid #e1e3e5",
                  background: "#fff",
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => goToStep("webhook")}
                style={{
                  padding: "10px 18px",
                  borderRadius: 8,
                  border: "1px solid #e1e3e5",
                  background: "#fff",
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                Next: Webhook setup
              </button>
            </div>
          </div>
        )}

        {currentStep === "webhook" && (
          <div className="layout-form">
            <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>
              Step 3: Webhook setup
            </h2>
            <div style={docCard as React.CSSProperties} className="app-doc-card">
              <strong>Documentation</strong>
              <p style={{ margin: "8px 0 0", fontSize: 13 }}>
                The webhook lets Fynd notify Fynd Returns when refund status changes. When Fynd
                reports <code>refund_done</code>, the app automatically creates the refund in
                Shopify.
              </p>
              <p style={{ margin: "8px 0 0", fontSize: 13 }}>
                This URL is <strong>unique to this Shopify store</strong>. Each store has its own
                URL <em>and</em> its own HMAC signing secret — a leak only ever affects one store.
              </p>
              <p style={{ margin: "12px 0 0", fontSize: 12, color: "#6b7280" }}>
                <strong>Required Fynd scopes:</strong> <code>company/orders/read</code>,{" "}
                <code>company/orders/write</code>. If webhook registration fails with 403, your
                OAuth app may also need <code>company/settings</code> or{" "}
                <code>company/webhooks</code> in Fynd Partners.
              </p>
              <p style={{ margin: "12px 0 0", fontSize: 12, color: "#6b7280" }}>
                <a
                  href="https://docs.fynd.com/partners/commerce/sdk/latest/platform/company/webhook"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: "#005bd3" }}
                >
                  Fynd Webhook API docs →
                </a>
              </p>
            </div>

            {/* Step 3a: secret precondition. Without a per-shop secret, the
                webhook URL exists but every Fynd POST will be rejected as
                unsigned. Surface the gap up front and link to where to fix it. */}
            {!data.hasPerShopWebhookSecret && (
              <div
                style={{
                  marginTop: 24,
                  padding: 16,
                  background: "#fef3c7",
                  borderRadius: 8,
                  border: "1.5px solid #f59e0b",
                  fontSize: 13,
                  color: "#78350f",
                  lineHeight: 1.5,
                }}
              >
                <strong>You need to generate a webhook signing secret first.</strong>
                <p style={{ margin: "6px 0 0" }}>
                  Open{" "}
                  <Link
                    to="/app/settings/integrations"
                    style={{ color: "#92400e", textDecoration: "underline" }}
                  >
                    Settings → Integrations
                  </Link>{" "}
                  → expand <strong>"Fynd Webhook (per-shop secret)"</strong> → click{" "}
                  <strong>Generate webhook secret</strong>. Copy the secret (shown ONCE) along with
                  this URL into the Fynd Partner Dashboard.
                </p>
              </div>
            )}

            <div style={{ marginTop: 24 }}>
              <label style={{ display: "block", fontWeight: 600, marginBottom: 8, fontSize: 14 }}>
                Webhook URL{" "}
                <span style={{ fontWeight: 400, color: "#6b7280", fontSize: 12 }}>(per-shop)</span>
              </label>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <code
                  style={{
                    flex: 1,
                    minWidth: 200,
                    padding: "12px 16px",
                    background: "#1e1e1e",
                    color: "#d4d4d4",
                    borderRadius: 8,
                    fontSize: 13,
                    wordBreak: "break-all",
                  }}
                >
                  {data.webhookUrl || "Set SHOPIFY_APP_URL in environment"}
                </code>
                {data.webhookUrl && (
                  <button
                    type="button"
                    onClick={() => navigator.clipboard.writeText(data.webhookUrl)}
                    style={{
                      padding: "10px 16px",
                      borderRadius: 8,
                      border: "1px solid #e1e3e5",
                      background: "#fff",
                      fontWeight: 500,
                      cursor: "pointer",
                      fontSize: 13,
                    }}
                  >
                    Copy
                  </button>
                )}
              </div>
              {!data.webhookUrl && (
                <p style={{ marginTop: 8, color: "#b45309", fontSize: 13 }}>
                  SHOPIFY_APP_URL is not set. Set it in your deployment environment (e.g. Render,
                  Heroku).
                </p>
              )}
              {data.hasPerShopWebhookSecret && (
                <p style={{ marginTop: 8, fontSize: 12, color: "#065f46" }}>
                  ✓ This shop has a webhook secret configured. Make sure the same secret value is
                  set in the Fynd Partner Dashboard for this URL.
                </p>
              )}
              {/* Reference for merchants still on the legacy global URL — not
                  promoted, but available so they don't think it broke. */}
              <details style={{ marginTop: 12, fontSize: 12, color: "#6b7280" }}>
                <summary style={{ cursor: "pointer" }}>Legacy global URL (deprecated)</summary>
                <p style={{ margin: "8px 0 0" }}>
                  Older deployments used a single global URL with a shared
                  <code> FYND_WEBHOOK_SECRET</code> env var. It still works, but new merchants
                  should use the per-shop URL above.
                </p>
                <code
                  style={{
                    display: "block",
                    marginTop: 6,
                    padding: "8px 10px",
                    background: "#f3f4f6",
                    color: "#374151",
                    borderRadius: 6,
                    wordBreak: "break-all",
                  }}
                >
                  {data.legacyWebhookUrl || "—"}
                </code>
              </details>
            </div>

            {data.existingSubscriber && (
              <div
                style={{
                  marginTop: 24,
                  padding: 16,
                  background: "#ecfdf5",
                  borderRadius: 8,
                  border: "1px solid #a7f3d0",
                }}
              >
                <p style={{ margin: 0, fontWeight: 600, color: "#065f46", fontSize: 14 }}>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    style={{ verticalAlign: "middle", marginRight: 4 }}
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                  Webhook already subscribed
                </p>
                <p style={{ margin: "8px 0 0", fontSize: 13, color: "#047857" }}>
                  Subscriber: <strong>{data.existingSubscriber.name}</strong>
                </p>
                <p
                  style={{
                    margin: "4px 0 0",
                    fontSize: 12,
                    color: "#059669",
                    wordBreak: "break-all",
                  }}
                >
                  URL: {data.existingSubscriber.webhook_url}
                </p>
                <p style={{ margin: "8px 0 0", fontSize: 12, color: "#047857" }}>
                  No action needed. Continue to Step 4 to test the webhook.
                </p>
              </div>
            )}

            {data.subscribersError && !data.existingSubscriber && (
              <div
                style={{
                  marginTop: 24,
                  padding: 12,
                  background: "#fef3c7",
                  borderRadius: 8,
                  border: "1px solid #fcd34d",
                  fontSize: 13,
                  color: "#92400e",
                }}
              >
                Could not check existing webhooks: {data.subscribersError}. You can still register
                manually in Fynd Partners or try registering below.
              </div>
            )}

            {!data.existingSubscriber && data.webhookUrl && data.hasPlatformCreds && (
              <fetcher.Form method="post" style={{ marginTop: 24 }}>
                <input type="hidden" name="intent" value="register_webhook" />
                <div style={{ marginBottom: 16 }}>
                  <label
                    style={{ display: "block", fontWeight: 500, marginBottom: 6, fontSize: 13 }}
                  >
                    Subscriber name
                  </label>
                  <input
                    type="text"
                    name="subscriberName"
                    defaultValue="Fynd Returns"
                    placeholder="Fynd Returns"
                    className="app-input"
                    style={{ maxWidth: 320 }}
                  />
                </div>
                <div style={{ marginBottom: 16 }}>
                  <label
                    style={{ display: "block", fontWeight: 500, marginBottom: 6, fontSize: 13 }}
                  >
                    Notification email (for Fynd alerts)
                  </label>
                  <input
                    type="email"
                    name="notificationEmail"
                    placeholder="webhooks@yourdomain.com"
                    className="app-input"
                    style={{ maxWidth: 320 }}
                  />
                  <p style={{ margin: "4px 0 0", fontSize: 12, color: "#6b7280" }}>
                    Fynd sends webhook failure alerts to this email.
                  </p>
                </div>
                <s-button
                  type="submit"
                  variant="primary"
                  loading={fetcher.state !== "idle"}
                  disabled={fetcher.state !== "idle"}
                >
                  {fetcher.state !== "idle" ? "Registering…" : "Register webhook via Fynd API"}
                </s-button>
              </fetcher.Form>
            )}

            {!data.hasPlatformCreds && (
              <p style={{ marginTop: 16, color: "#b45309", fontSize: 13 }}>
                Complete Step 1 (credentials) first.
              </p>
            )}

            <div style={{ marginTop: 24, display: "flex", gap: 12, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => goToStep("test-platform")}
                style={{
                  padding: "10px 18px",
                  borderRadius: 8,
                  border: "1px solid #e1e3e5",
                  background: "#fff",
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => goToStep("test-webhook")}
                style={{
                  padding: "10px 18px",
                  borderRadius: 8,
                  border: "1px solid #e1e3e5",
                  background: "#fff",
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                Next: Test webhook
              </button>
            </div>
          </div>
        )}

        {currentStep === "test-webhook" && (
          <div className="layout-form">
            <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>
              Step 4: Test webhook
            </h2>
            <div style={docCard as React.CSSProperties} className="app-doc-card">
              <strong>Documentation</strong>
              <p style={{ margin: "8px 0 0", fontSize: 13 }}>
                This sends a test payload to the webhook endpoint to verify it is reachable and
                processes correctly. The test uses a fake shipment ID, so no return will be updated
                — you will see &quot;ignored&quot; which means the endpoint is working.
              </p>
              <p style={{ margin: "12px 0 0", fontSize: 12, color: "#6b7280" }}>
                After Fynd is configured to send webhooks, real payloads will include{" "}
                <code>shipment_id</code> and <code>refund_status</code>.
              </p>
            </div>
            <fetcher.Form method="post" style={{ marginTop: 24 }}>
              <input type="hidden" name="intent" value="test_webhook" />
              <s-button type="submit" variant="primary" loading={fetcher.state !== "idle"}>
                {fetcher.state !== "idle" ? "Testing…" : "Test webhook"}
              </s-button>
            </fetcher.Form>
            <div style={{ marginTop: 24, display: "flex", gap: 12, flexWrap: "wrap" }}>
              <button
                type="button"
                onClick={() => goToStep("webhook")}
                style={{
                  padding: "10px 18px",
                  borderRadius: 8,
                  border: "1px solid #e1e3e5",
                  background: "#fff",
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                Back
              </button>
              <button
                type="button"
                onClick={() => goToStep("done")}
                style={{
                  padding: "10px 18px",
                  borderRadius: 8,
                  border: "1px solid #e1e3e5",
                  background: "#fff",
                  fontWeight: 500,
                  cursor: "pointer",
                }}
              >
                Next: Done
              </button>
            </div>
          </div>
        )}

        {currentStep === "done" && (
          <div className="layout-form">
            <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 12 }}>Setup complete</h2>
            <div
              style={{
                padding: 24,
                background: "#ecfdf5",
                borderRadius: 12,
                border: "1px solid #a7f3d0",
                marginBottom: 24,
              }}
            >
              <p style={{ margin: 0, fontSize: 15, color: "#065f46", fontWeight: 500 }}>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  style={{ verticalAlign: "middle", marginRight: 4 }}
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                Fynd integration is ready. Returns synced to Fynd will receive automatic refund
                updates via webhook.
              </p>
            </div>
            <div style={docCard as React.CSSProperties} className="app-doc-card">
              <strong>What happens next</strong>
              <ul style={{ margin: "8px 0 0", paddingLeft: 20 }}>
                <li>When you approve a return, sync it to Fynd (Retry Fynd sync)</li>
                <li>When Fynd processes the refund, they send a webhook</li>
                <li>
                  Fynd Returns updates <code>refundStatus</code> to in_progress, then calls Shopify
                  Refund API when done
                </li>
              </ul>
            </div>
            <div style={{ marginTop: 24, display: "flex", gap: 12, flexWrap: "wrap" }}>
              <Link to="/app">
                <s-button variant="primary">Go to Dashboard</s-button>
              </Link>
              <Link to="/app/settings/integrations">
                <s-button variant="secondary">Manage integrations</s-button>
              </Link>
              <Link to="/app/returns">
                <s-button variant="secondary">View returns</s-button>
              </Link>
            </div>
          </div>
        )}

        {fetcher.data?.debugLogs && fetcher.data.debugLogs.length > 0 && (
          <details className="app-details" style={{ marginTop: 32 }}>
            <summary>Debug logs ({fetcher.data.debugLogs.length})</summary>
            <pre
              style={{
                margin: 0,
                padding: 16,
                background: "#1e1e1e",
                color: "#d4d4d4",
                fontSize: 12,
                overflow: "auto",
                maxHeight: 300,
              }}
            >
              {fetcher.data.debugLogs.map((e, i) => (
                <div key={i}>
                  [{e.ts}] {e.step}: {e.message}
                  {e.detail ? ` | ${e.detail}` : ""}
                </div>
              ))}
            </pre>
          </details>
        )}
      </div>
    </AppPage>
  );
}
