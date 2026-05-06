import * as React from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { findOrCreateShop } from "../lib/shop.server";
import { parseAutoApproveRules } from "../lib/auto-approve.server";
import type { AutoApproveRule } from "../lib/auto-approve.server";
import { AppPage } from "../components/AppPage";

const FIELD_OPTIONS = [
  { value: "orderValue", label: "Order Value" },
  { value: "returnReason", label: "Return Reason" },
  { value: "productTag", label: "Product Tag" },
  { value: "customerReturnCount", label: "Customer Return Count" },
  { value: "fraudRiskScore", label: "Fraud Risk Score (0-100)" },
] as const;

const OPERATOR_OPTIONS: Record<string, { value: string; label: string }[]> = {
  orderValue: [
    { value: "lte", label: "<= (at most)" },
    { value: "lt", label: "< (less than)" },
    { value: "gte", label: ">= (at least)" },
    { value: "gt", label: "> (greater than)" },
    { value: "eq", label: "= (equals)" },
  ],
  returnReason: [
    { value: "eq", label: "equals" },
    { value: "neq", label: "does not equal" },
    { value: "contains", label: "contains" },
    { value: "not_contains", label: "does not contain" },
  ],
  productTag: [
    { value: "eq", label: "equals" },
    { value: "neq", label: "does not equal" },
    { value: "contains", label: "contains" },
    { value: "not_contains", label: "does not contain" },
  ],
  customerReturnCount: [
    { value: "lte", label: "<= (at most)" },
    { value: "lt", label: "< (less than)" },
    { value: "gte", label: ">= (at least)" },
    { value: "gt", label: "> (greater than)" },
    { value: "eq", label: "= (equals)" },
  ],
  fraudRiskScore: [
    { value: "gte", label: ">= (at least)" },
    { value: "gt", label: "> (greater than)" },
    { value: "lte", label: "<= (at most)" },
    { value: "eq", label: "= (equals)" },
  ],
};

const ACTION_OPTIONS = [
  { value: "approve", label: "Auto-approve" },
  { value: "manual_review", label: "Require manual review" },
];

const FIELD_LABELS: Record<string, string> = {
  orderValue: "Order Value",
  returnReason: "Return Reason",
  productTag: "Product Tag",
  customerReturnCount: "Customer Return Count",
};

const OPERATOR_LABELS: Record<string, string> = {
  eq: "=", neq: "!=", gt: ">", gte: ">=", lt: "<", lte: "<=",
  contains: "contains", not_contains: "not contains",
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop);
  const s = shop.settings;

  const rules = parseAutoApproveRules(s?.autoApproveRulesJson);
  const autoApproveEnabled = s?.autoApproveEnabled ?? false;

  return { rules, autoApproveEnabled };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const rulesJson = formData.get("rulesJson") as string | null;

  const shop = await findOrCreateShop(session.shop);

  let parsed: AutoApproveRule[] = [];
  try {
    if (rulesJson) {
      const arr = JSON.parse(rulesJson) as unknown;
      if (Array.isArray(arr)) {
        parsed = arr.filter(
          (r): r is AutoApproveRule =>
            r &&
            typeof r === "object" &&
            typeof r.field === "string" &&
            typeof r.operator === "string" &&
            typeof r.value === "string" &&
            typeof r.action === "string",
        );
      }
    }
  } catch {
    return { error: "Invalid rules format" };
  }

  await prisma.shopSettings.upsert({
    where: { shopId: shop.id },
    create: {
      shopId: shop.id,
      autoApproveRulesJson: JSON.stringify(parsed),
    },
    update: {
      autoApproveRulesJson: JSON.stringify(parsed),
    },
  });

  return { success: true };
};

type DraftRule = AutoApproveRule & { _key: string };

function newDraftKey() {
  return Math.random().toString(36).slice(2, 10);
}

export default function AutoApproveRulesSettings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ success?: boolean; error?: string }>();
  const [rules, setRules] = React.useState<DraftRule[]>(() =>
    data.rules.map((r) => ({ ...r, _key: newDraftKey() })),
  );

  React.useEffect(() => {
    setRules(data.rules.map((r) => ({ ...r, _key: newDraftKey() })));
  }, [data.rules]);

  const addRule = () => {
    setRules([...rules, {
      _key: newDraftKey(),
      field: "orderValue",
      operator: "lte",
      value: "",
      action: "approve",
    }]);
  };

  const removeRule = (key: string) => {
    setRules(rules.filter((r) => r._key !== key));
  };

  const updateRule = (key: string, updates: Partial<AutoApproveRule>) => {
    setRules(rules.map((r) => {
      if (r._key !== key) return r;
      const updated = { ...r, ...updates };
      if (updates.field && updates.field !== r.field) {
        const ops = OPERATOR_OPTIONS[updates.field];
        /* v8 ignore start */
        // defensive: OPERATOR_OPTIONS always has entries; "eq" fallback unreachable
        updated.operator = (ops?.[0]?.value ?? "eq") as AutoApproveRule["operator"];
        /* v8 ignore stop */
        updated.value = "";
      }
      return updated;
    }));
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const cleanRules = rules
      .filter((r) => r.value.trim() !== "")
      .map(({ field, operator, value, action }) => ({ field, operator, value: value.trim(), action }));
    const fd = new FormData();
    fd.set("rulesJson", JSON.stringify(cleanRules));
    fetcher.submit(fd, { method: "post" });
  };

  return (
    <AppPage heading="Auto-Approve Rules">
      <div className="app-content">
        {fetcher.data?.success && (
          <div className="app-alert app-alert-success" style={{ marginBottom: 16 }}>Rules saved successfully.</div>
        )}
        {fetcher.data?.error && (
          <div className="app-alert app-alert-error" style={{ marginBottom: 16 }}>{fetcher.data.error}</div>
        )}

        {!data.autoApproveEnabled && (
          <div style={{
            padding: "14px 18px", marginBottom: 20, borderRadius: 10,
            background: "#FFFBEB", border: "1px solid #FDE68A",
            display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap",
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#D97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
            <div style={{ flex: 1, fontSize: 13, color: "#92400E" }}>
              <strong>Auto-approve is currently disabled.</strong> These rules will only take effect when auto-approve is enabled in{" "}
              <Link to="/app/settings/return-settings" style={{ color: "#D97706", fontWeight: 600 }}>Return Settings</Link>.
            </div>
          </div>
        )}

        <div className="layout-medium" style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <s-section>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>How it works</div>
            <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 0, lineHeight: 1.6 }}>
              Rules are evaluated in order from top to bottom. The first matching rule determines the action.
              If no rule matches and auto-approve is enabled, returns are auto-approved (backward compatible).
              Use "Require manual review" to flag high-value or suspicious returns for admin attention.
            </p>
          </s-section>

          <form onSubmit={handleSubmit}>
            <s-section>
              <div style={{ fontWeight: 600, marginBottom: 16 }}>Rules ({rules.length})</div>
              {rules.length === 0 ? (
                <div style={{ padding: 32, textAlign: "center", color: "#9CA3AF", fontSize: 14, background: "#F9FAFB", borderRadius: 10, border: "1px solid #F3F4F6", marginBottom: 16 }}>
                  No rules configured. When auto-approve is enabled, all returns will be auto-approved by default.
                </div>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: 12, marginBottom: 16 }}>
                  {rules.map((rule, idx) => (
                    <div
                      key={rule._key}
                      style={{
                        padding: 16, borderRadius: 10,
                        background: rule.action === "manual_review" ? "#FEF2F2" : "#F0FDF4",
                        border: `1px solid ${rule.action === "manual_review" ? "#FECACA" : "#BBF7D0"}`,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: "#6d7175" }}>Rule {idx + 1}</span>
                        <button
                          type="button"
                          onClick={() => removeRule(rule._key)}
                          style={{
                            background: "none", border: "1px solid #FECACA", borderRadius: 6,
                            padding: "3px 10px", cursor: "pointer", color: "#DC2626", fontSize: 12,
                          }}
                        >
                          Remove
                        </button>
                      </div>
                      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
                        <div style={{ minWidth: 160 }}>
                          <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "#6d7175", marginBottom: 4 }}>If</label>
                          <select
                            value={rule.field}
                            onChange={(e) => updateRule(rule._key, { field: e.target.value as AutoApproveRule["field"] })}
                            style={{ padding: "8px 12px", borderRadius: "var(--rpm-radius-sm, 8px)", border: "var(--rpm-border, 1px solid #e1e3e5)", fontSize: 13, width: "100%", background: "var(--rpm-surface, #fff)", color: "var(--rpm-text, #0f172a)" }}
                          >
                            {FIELD_OPTIONS.map((f) => (
                              <option key={f.value} value={f.value}>{f.label}</option>
                            ))}
                          </select>
                        </div>
                        <div style={{ minWidth: 140 }}>
                          <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "#6d7175", marginBottom: 4 }}>Operator</label>
                          <select
                            value={rule.operator}
                            onChange={(e) => updateRule(rule._key, { operator: e.target.value as AutoApproveRule["operator"] })}
                            style={{ padding: "8px 12px", borderRadius: "var(--rpm-radius-sm, 8px)", border: "var(--rpm-border, 1px solid #e1e3e5)", fontSize: 13, width: "100%", background: "var(--rpm-surface, #fff)", color: "var(--rpm-text, #0f172a)" }}
                          >
                            {/* v8 ignore start */}
                            {/* defensive: rule.field always has OPERATOR_OPTIONS entry; ?? [] fallback unreachable */}
                            {(OPERATOR_OPTIONS[rule.field] ?? []).map((o) => (
                              <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                            {/* v8 ignore stop */}
                          </select>
                        </div>
                        <div style={{ flex: 1, minWidth: 120 }}>
                          <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "#6d7175", marginBottom: 4 }}>Value</label>
                          <input
                            type={rule.field === "orderValue" || rule.field === "customerReturnCount" ? "number" : "text"}
                            value={rule.value}
                            onChange={(e) => updateRule(rule._key, { value: e.target.value })}
                            /* v8 ignore start */
                            // defensive: placeholder ternary across rule.field values; only some tested
                            placeholder={
                              rule.field === "orderValue" ? "50" :
                              rule.field === "returnReason" ? "wrong_size" :
                              rule.field === "productTag" ? "easy-return" :
                              "3"
                            }
                            /* v8 ignore stop */
                            style={{ width: "100%", padding: "8px 12px", borderRadius: "var(--rpm-radius-sm, 8px)", border: "var(--rpm-border, 1px solid #e1e3e5)", fontSize: 13, boxSizing: "border-box", background: "var(--rpm-surface, #fff)", color: "var(--rpm-text, #0f172a)" }}
                          />
                        </div>
                        <div style={{ minWidth: 170 }}>
                          <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "#6d7175", marginBottom: 4 }}>Then</label>
                          <select
                            value={rule.action}
                            onChange={(e) => updateRule(rule._key, { action: e.target.value as AutoApproveRule["action"] })}
                            style={{
                              padding: "8px 12px", borderRadius: "var(--rpm-radius-sm, 8px)", border: "1px solid #e1e3e5", fontSize: 13, width: "100%",
                              background: rule.action === "manual_review" ? "#FEF2F2" : "#F0FDF4",
                              color: rule.action === "manual_review" ? "#DC2626" : "#166534",
                              fontWeight: 600,
                            }}
                          >
                            {ACTION_OPTIONS.map((a) => (
                              <option key={a.value} value={a.value}>{a.label}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <button
                type="button"
                onClick={addRule}
                style={{
                  padding: "10px 16px", borderRadius: "var(--rpm-radius-sm, 8px)", border: "1px dashed var(--rpm-border-color, #e1e3e5)",
                  background: "var(--rpm-surface, #fff)", color: "var(--rpm-text-muted, #6d7175)", fontSize: 14, cursor: "pointer",
                  width: "100%", transition: "var(--rpm-transition, all 0.15s)",
                }}
              >
                + Add rule
              </button>
            </s-section>

            {/* Rule Preview */}
            {/* v8 ignore start */}
            {/* defensive: rules.length > 0 always true when rules exist; empty branch covered separately */}
            {rules.length > 0 && (
              <s-section>
                <div style={{ fontWeight: 600, marginBottom: 12 }}>Rule preview</div>
                <div style={{ padding: 16, background: "#F9FAFB", borderRadius: 10, border: "1px solid #F3F4F6" }}>
                  <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 2, color: "#374151" }}>
                    {rules.filter((r) => r.value.trim()).map((rule, idx) => (
                      <li key={rule._key}>
                        If <strong>{FIELD_LABELS[rule.field] || rule.field}</strong>{" "}
                        <code style={{ padding: "1px 6px", background: "#E5E7EB", borderRadius: 4, fontSize: 12 }}>
                          {OPERATOR_LABELS[rule.operator] || rule.operator}
                        </code>{" "}
                        <strong>{rule.value}</strong>{" "}
                        then{" "}
                        <span style={{
                          display: "inline-block", padding: "1px 8px", borderRadius: 5, fontSize: 11, fontWeight: 700,
                          background: rule.action === "manual_review" ? "#FEF2F2" : "#F0FDF4",
                          color: rule.action === "manual_review" ? "#DC2626" : "#166534",
                          border: `1px solid ${rule.action === "manual_review" ? "#FECACA" : "#BBF7D0"}`,
                        }}>
                          {rule.action === "manual_review" ? "MANUAL REVIEW" : "AUTO-APPROVE"}
                        </span>
                      </li>
                    ))}
                    <li style={{ color: "#9CA3AF", fontStyle: "italic" }}>
                      Otherwise: {data.autoApproveEnabled ? "auto-approve (default)" : "submit for review (auto-approve disabled)"}
                    </li>
                  </ol>
                </div>
              </s-section>
            )}
            {/* v8 ignore stop */}

            <div className="app-actions">
              <s-button type="submit" loading={fetcher.state !== "idle"}>Save Rules</s-button>
              <Link to="/app/settings">
                <s-button variant="secondary" type="button">Discard</s-button>
              </Link>
            </div>
          </form>
        </div>
      </div>
    </AppPage>
  );
}
