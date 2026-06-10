import "@shopify/ui-extensions/preact";
import { render } from "preact";
import { useEffect, useState } from "preact/hooks";

type ReturnRow = {
  id: string;
  returnRequestNo: string;
  status: string;
  refundStatus?: string | null;
  resolutionType?: string | null;
  fyndReturnNo?: string | null;
  returnAwb?: string | null;
  createdAt: string;
};

type ApiResponse = {
  ok?: boolean;
  returns?: ReturnRow[];
  appHost?: string;
  error?: string;
};

type ExtensionSettings = {
  app_host?: string | null;
};

declare const process:
  | {
      env?: {
        SHOPIFY_APP_URL?: string;
      };
    }
  | undefined;

function appHost(): string {
  const settings = shopify.settings.value as ExtensionSettings | undefined;
  const configuredHost = String(settings?.app_host || process?.env?.SHOPIFY_APP_URL || "").trim();
  return configuredHost.replace(/\/+$/, "");
}

export default async function (): Promise<void> {
  render(<Extension />, document.body);
}

function badgeTone(status: string): "critical" | "neutral" | "auto" {
  const s = (status || "").toLowerCase();
  if (s === "rejected" || s === "cancelled") return "critical";
  if (s === "completed" || s === "approved") return "auto";
  return "neutral";
}

function Extension() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [returns, setReturns] = useState<ReturnRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const host = appHost();
        if (!host) {
          setError("The app host URL is not configured.");
          setLoading(false);
          return;
        }
        const token = await shopify.sessionToken.get();
        const res = await fetch(`${host}/api/customer-account/returns`, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}` },
        });
        const body: ApiResponse = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok || body.ok !== true) {
          setError(body.error || `Request failed (${res.status})`);
          setLoading(false);
          return;
        }
        setReturns(body.returns || []);
        setLoading(false);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : "Could not load returns.");
        setLoading(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <s-section heading="My returns">
        <s-stack direction="inline" gap="base" align-items="center">
          <s-spinner accessibility-label="Loading returns" size="base"></s-spinner>
          <s-text color="subdued">Loading your return history…</s-text>
        </s-stack>
      </s-section>
    );
  }

  if (error) {
    return (
      <s-section heading="My returns">
        <s-banner tone="critical" heading="Could not load returns">
          {error}
        </s-banner>
      </s-section>
    );
  }

  if (returns.length === 0) {
    return (
      <s-section heading="My returns">
        <s-banner tone="info">
          You have not started any returns yet. To start a return, open an order.
        </s-banner>
      </s-section>
    );
  }

  return (
    <s-section heading="My returns">
      <s-stack direction="block" gap="base">
        {returns.map((r) => (
          <s-box
            key={r.id}
            padding="base"
            background="subdued"
            border="base"
            border-radius="base"
          >
            <s-stack direction="block" gap="small-200">
              <s-stack direction="inline" gap="base" align-items="center">
                <s-text type="strong">#{r.returnRequestNo}</s-text>
                <s-badge tone={badgeTone(r.status)}>{r.status}</s-badge>
                {r.refundStatus ? <s-badge tone="neutral">{r.refundStatus}</s-badge> : null}
              </s-stack>
              {r.fyndReturnNo ? (
                <s-text color="subdued">Carrier ref: {r.fyndReturnNo}</s-text>
              ) : null}
              {r.returnAwb ? <s-text color="subdued">Tracking #: {r.returnAwb}</s-text> : null}
              <s-time date-time={r.createdAt}>{r.createdAt}</s-time>
            </s-stack>
          </s-box>
        ))}
      </s-stack>
    </s-section>
  );
}
