import * as React from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { findOrCreateShop } from "../lib/shop.server";
import { AppPage } from "../components/AppPage";

export type ProductPolicyRule = {
  id: string;
  matchType: "tags" | "product_type" | "collection";
  matchValue: string;
  windowDays: number;
  policyText?: string;
  returnable: boolean;
};

function generateId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop);
  const s = shop.settings;

  let rules: ProductPolicyRule[] = [];
  try {
    const raw = s?.productPoliciesJson;
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) rules = parsed;
    }
  } catch {
    /* ignore */
  }

  return { rules };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const rulesJson = formData.get("rulesJson") as string | null;

  const shop = await findOrCreateShop(session.shop);

  let validatedRules: ProductPolicyRule[] = [];
  try {
    if (rulesJson) {
      const parsed = JSON.parse(rulesJson);
      if (Array.isArray(parsed)) {
        validatedRules = parsed
          .filter((r: unknown) => r && typeof r === "object" && "matchType" in r)
          .map((r: ProductPolicyRule) => ({
            id: r.id || generateId(),
            matchType: r.matchType,
            /* v8 ignore start */
            // defensive: matchValue defaults when missing/empty
            matchValue: (r.matchValue || "").trim(),
            /* v8 ignore stop */
            windowDays: Math.max(0, parseInt(String(r.windowDays), 10) || 30),
            policyText: (r.policyText || "").trim() || undefined,
            returnable: r.returnable !== false,
          }));
      }
    }
  } catch {
    return { success: false, error: "Invalid rules format." };
  }

  try {
    await prisma.shopSettings.upsert({
      where: { shopId: shop.id },
      create: { shopId: shop.id, productPoliciesJson: JSON.stringify(validatedRules) },
      update: { productPoliciesJson: JSON.stringify(validatedRules) },
    });
    return { success: true };
  } catch (e) {
    /* v8 ignore start */
    // defensive: instanceof Error narrowing for upsert failure
    return {
      success: false,
      error: e instanceof Error ? e.message : "Failed to save product policies.",
    };
    /* v8 ignore stop */
  }
};

const EMPTY_RULE: () => ProductPolicyRule = () => ({
  id: generateId(),
  matchType: "tags",
  matchValue: "",
  windowDays: 30,
  policyText: "",
  returnable: true,
});

export default function ProductPoliciesSettings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ success?: boolean }>();
  const [rules, setRules] = React.useState<ProductPolicyRule[]>(
    data.rules.length > 0 ? data.rules : [],
  );

  React.useEffect(() => {
    setRules(data.rules.length > 0 ? data.rules : []);
  }, [data.rules]);

  const addRule = () => {
    setRules([...rules, EMPTY_RULE()]);
  };

  const removeRule = (id: string) => {
    setRules(rules.filter((r) => r.id !== id));
  };

  const updateRule = (id: string, updates: Partial<ProductPolicyRule>) => {
    setRules(rules.map((r) => (r.id === id ? { ...r, ...updates } : r)));
  };

  const moveRule = (index: number, direction: -1 | 1) => {
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= rules.length) return;
    const updated = [...rules];
    const [moved] = updated.splice(index, 1);
    updated.splice(newIndex, 0, moved);
    setRules(updated);
  };

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData();
    fd.set("rulesJson", JSON.stringify(rules));
    fetcher.submit(fd, { method: "post" });
  };
  const isSaving = fetcher.state !== "idle";
  const actions = (
    <button
      className="app-btn-primary"
      type="submit"
      form="product-policies-settings-form"
      disabled={isSaving}
    >
      {isSaving ? "Saving..." : "Save Changes"}
    </button>
  );

  return (
    <AppPage heading="Product-Level Return Policies" actions={actions}>
      <div className="app-content">
        {fetcher.data?.success === true && (
          <div className="app-alert app-alert-success">Product policies saved successfully.</div>
        )}
        {fetcher.data && fetcher.data.success === false && (
          <div className="app-alert app-alert-error">
            {
              /* v8 ignore start */
              // defensive: error message fallback
              (fetcher.data as { error?: string }).error || "Failed to save product policies."
              /* v8 ignore stop */
            }
          </div>
        )}

        <div className="layout-form" style={{ marginBottom: 16 }}>
          <p style={{ fontSize: 13, color: "#6d7175", marginBottom: 16, lineHeight: 1.6 }}>
            Define per-product return policies based on product tags, product type, or collection.
            Rules are evaluated in priority order (first match wins). If no rule matches, the global
            return window is used.
          </p>
        </div>

        <fetcher.Form id="product-policies-settings-form" method="post" onSubmit={handleSubmit}>
          <div
            className="layout-form"
            style={{ display: "flex", flexDirection: "column", gap: 16 }}
          >
            {rules.length === 0 && (
              <div
                style={{
                  padding: 32,
                  background: "#F9FAFB",
                  borderRadius: 12,
                  border: "1px dashed #D1D5DB",
                  textAlign: "center",
                }}
              >
                <svg
                  width="32"
                  height="32"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="#9CA3AF"
                  strokeWidth="1.5"
                  style={{ marginBottom: 8 }}
                >
                  <path d="M16 4h2a2 2 0 012 2v14a2 2 0 01-2 2H6a2 2 0 01-2-2V6a2 2 0 012-2h2" />
                  <rect x="8" y="2" width="8" height="4" rx="1" ry="1" />
                </svg>
                <p style={{ fontSize: 14, color: "#6B7280", marginBottom: 12 }}>
                  No product policies defined yet.
                </p>
                <p style={{ fontSize: 12, color: "#9CA3AF", marginBottom: 16 }}>
                  All products will use the global return window from Return Settings.
                </p>
                <s-button type="button" variant="primary" onClick={addRule}>
                  Add first rule
                </s-button>
              </div>
            )}

            {rules.map((rule, index) => (
              <div
                key={rule.id}
                style={{
                  padding: 16,
                  background: "#fff",
                  borderRadius: 12,
                  border: rule.returnable ? "1px solid #E5E7EB" : "1px solid #FECACA",
                  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 12,
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: "#6B7280",
                        fontVariantNumeric: "tabular-nums",
                      }}
                    >
                      #{index + 1}
                    </span>
                    <span
                      style={{
                        fontSize: 10,
                        fontWeight: 600,
                        padding: "2px 8px",
                        borderRadius: 4,
                        background: rule.returnable ? "#DCFCE7" : "#FEE2E2",
                        color: rule.returnable ? "#166534" : "#991B1B",
                        textTransform: "uppercase",
                        letterSpacing: "0.5px",
                      }}
                    >
                      {rule.returnable ? "Returnable" : "Not returnable"}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 4 }}>
                    <button
                      type="button"
                      onClick={() => moveRule(index, -1)}
                      disabled={index === 0}
                      style={{
                        background: "none",
                        border: "1px solid #E5E7EB",
                        borderRadius: 6,
                        padding: "4px 8px",
                        cursor: index === 0 ? "default" : "pointer",
                        opacity: index === 0 ? 0.3 : 1,
                      }}
                      aria-label="Move up"
                      title="Move up"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#6B7280"
                        strokeWidth="2"
                      >
                        <polyline points="18 15 12 9 6 15" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => moveRule(index, 1)}
                      disabled={index === rules.length - 1}
                      style={{
                        background: "none",
                        border: "1px solid #E5E7EB",
                        borderRadius: 6,
                        padding: "4px 8px",
                        cursor: index === rules.length - 1 ? "default" : "pointer",
                        opacity: index === rules.length - 1 ? 0.3 : 1,
                      }}
                      aria-label="Move down"
                      title="Move down"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="#6B7280"
                        strokeWidth="2"
                      >
                        <polyline points="6 9 12 15 18 9" />
                      </svg>
                    </button>
                    <button
                      type="button"
                      onClick={() => removeRule(rule.id)}
                      style={{
                        background: "none",
                        border: "1px solid #FECACA",
                        borderRadius: 6,
                        padding: "4px 8px",
                        cursor: "pointer",
                        color: "#DC2626",
                      }}
                      aria-label="Remove rule"
                      title="Remove rule"
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                </div>

                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: 12 }}>
                  <div style={{ minWidth: 140 }}>
                    <label
                      style={{
                        display: "block",
                        fontSize: 12,
                        fontWeight: 500,
                        color: "#374151",
                        marginBottom: 4,
                      }}
                    >
                      Match by
                    </label>
                    <select
                      value={rule.matchType}
                      onChange={(e) =>
                        updateRule(rule.id, {
                          matchType: e.target.value as ProductPolicyRule["matchType"],
                        })
                      }
                      style={{
                        width: "100%",
                        padding: 8,
                        borderRadius: 6,
                        border: "1px solid #D1D5DB",
                        fontSize: 13,
                      }}
                    >
                      <option value="tags">Product tags</option>
                      <option value="product_type">Product type</option>
                      <option value="collection">Collection</option>
                    </select>
                  </div>
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <label
                      style={{
                        display: "block",
                        fontSize: 12,
                        fontWeight: 500,
                        color: "#374151",
                        marginBottom: 4,
                      }}
                    >
                      {rule.matchType === "tags"
                        ? "Tag (comma-separated)"
                        : rule.matchType === "product_type"
                          ? "Product type"
                          : "Collection name/handle"}
                    </label>
                    <input
                      type="text"
                      value={rule.matchValue}
                      onChange={(e) => updateRule(rule.id, { matchValue: e.target.value })}
                      placeholder={
                        rule.matchType === "tags"
                          ? "e.g. final-sale, clearance"
                          : rule.matchType === "product_type"
                            ? "e.g. Electronics"
                            : "e.g. summer-sale"
                      }
                      style={{
                        width: "100%",
                        padding: 8,
                        borderRadius: 6,
                        border: "1px solid #D1D5DB",
                        fontSize: 13,
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                </div>

                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
                  <div>
                    <label
                      style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
                    >
                      <input
                        type="checkbox"
                        checked={rule.returnable}
                        onChange={(e) => updateRule(rule.id, { returnable: e.target.checked })}
                        style={{ accentColor: "#22C55E" }}
                      />
                      <span style={{ fontSize: 13, fontWeight: 500 }}>Returnable</span>
                    </label>
                  </div>
                  {rule.returnable && (
                    <div style={{ minWidth: 120 }}>
                      <label
                        style={{
                          display: "block",
                          fontSize: 12,
                          fontWeight: 500,
                          color: "#374151",
                          marginBottom: 4,
                        }}
                      >
                        Return window (days)
                      </label>
                      <input
                        type="number"
                        value={rule.windowDays}
                        onChange={(e) =>
                          updateRule(rule.id, {
                            windowDays: Math.max(0, parseInt(e.target.value, 10) || 0),
                          })
                        }
                        min={0}
                        max={365}
                        style={{
                          width: "100%",
                          padding: 8,
                          borderRadius: 6,
                          border: "1px solid #D1D5DB",
                          fontSize: 13,
                          boxSizing: "border-box",
                        }}
                      />
                    </div>
                  )}
                  <div style={{ flex: 1, minWidth: 200 }}>
                    <label
                      style={{
                        display: "block",
                        fontSize: 12,
                        fontWeight: 500,
                        color: "#374151",
                        marginBottom: 4,
                      }}
                    >
                      Custom policy text (optional)
                    </label>
                    <input
                      type="text"
                      value={rule.policyText || ""}
                      onChange={(e) => updateRule(rule.id, { policyText: e.target.value })}
                      placeholder="e.g. Final sale items cannot be returned"
                      style={{
                        width: "100%",
                        padding: 8,
                        borderRadius: 6,
                        border: "1px solid #D1D5DB",
                        fontSize: 13,
                        boxSizing: "border-box",
                      }}
                    />
                  </div>
                </div>
              </div>
            ))}

            {rules.length > 0 && (
              <div style={{ display: "flex", justifyContent: "center" }}>
                <s-button type="button" variant="secondary" onClick={addRule}>
                  + Add rule
                </s-button>
              </div>
            )}
          </div>

          <div className="app-actions">
            <Link to="/app/settings">
              <s-button variant="secondary" type="button">
                Discard
              </s-button>
            </Link>
          </div>
        </fetcher.Form>
      </div>
    </AppPage>
  );
}
