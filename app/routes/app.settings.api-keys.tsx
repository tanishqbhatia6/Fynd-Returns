import React, { useState } from "react";
import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import { useLoaderData, useFetcher, Link } from "react-router";

// Client-side constant for permissions (server uses ALL_PERMISSIONS from api-key-auth.server)
const PERMISSIONS_LIST = ["read_returns", "write_returns", "read_settings", "manage_webhooks"] as const;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { authenticate } = await import("../shopify.server");
  const prisma = (await import("../db.server")).default;

  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!shop) return { keys: [] };

  const keys = await prisma.apiKey.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      permissions: true,
      isActive: true,
      lastUsedAt: true,
      revokedAt: true,
      createdAt: true,
    },
  });

  return { keys };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { authenticate } = await import("../shopify.server");
  const prisma = (await import("../db.server")).default;
  const { generateApiKey, ALL_PERMISSIONS } = await import("../lib/api-key-auth.server");

  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!shop) return { error: "Shop not found" };

  const formData = await request.formData();
  const actionType = formData.get("_action") as string;

  if (actionType === "generate") {
    const name = (formData.get("name") as string || "").trim();
    if (!name) return { error: "Key name is required" };
    if (name.length > 100) return { error: "Key name must be 100 characters or less" };

    const permissions = ALL_PERMISSIONS.filter((p) => formData.get(`perm_${p}`) === "on");
    if (permissions.length === 0) return { error: "Select at least one permission" };

    const { fullKey, keyPrefix, keyHash } = await generateApiKey();

    await prisma.apiKey.create({
      data: {
        shopId: shop.id,
        name,
        keyHash,
        keyPrefix,
        permissions: JSON.stringify(permissions),
      },
    });

    return { generatedKey: fullKey, keyName: name };
  }

  if (actionType === "revoke") {
    const keyId = formData.get("keyId") as string;
    if (!keyId) return { error: "Key ID required" };

    await prisma.apiKey.update({
      where: { id: keyId },
      data: { isActive: false, revokedAt: new Date() },
    });

    return { success: "API key revoked" };
  }

  if (actionType === "delete") {
    const keyId = formData.get("keyId") as string;
    if (!keyId) return { error: "Key ID required" };

    await prisma.apiKey.delete({ where: { id: keyId } });

    return { success: "API key deleted" };
  }

  return { error: "Unknown action" };
};

const PERM_LABELS: Record<string, string> = {
  read_returns: "Read Returns",
  write_returns: "Write Returns (approve, reject, refund)",
  read_settings: "Read Settings",
  manage_webhooks: "Manage Webhooks",
};

export default function ApiKeysSettings() {
  const { keys } = useLoaderData<typeof loader>();
  // Single fetcher reused across generate / revoke / delete intents.
  // Why fetcher (not <Form>): in an embedded Shopify app, plain <Form method=
  // "post"> navigations strip the App Bridge session token from the request,
  // causing authenticate.admin() to fail and the boundary to redirect to
  // /auth/login. fetcher.Form goes through fetch() which the Shopify
  // AppProvider patches to inject the bearer token automatically.
  const fetcher = useFetcher<typeof action>();
  const isSubmitting = fetcher.state !== "idle";
  const actionData = fetcher.data;

  const [showForm, setShowForm] = useState(false);
  const [copiedKey, setCopiedKey] = useState(false);

  const generatedKey = actionData && "generatedKey" in actionData ? actionData.generatedKey : null;

  function copyKey() {
    if (generatedKey) {
      navigator.clipboard.writeText(generatedKey);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    }
  }

  return (
    <s-page fullWidth heading="API Keys" backAction={{ content: "Settings", url: "/app/settings" }}>
      <div className="app-content layout-medium">

        {/* Generated Key Banner */}
        {generatedKey && (
          <div style={{
            padding: "16px 20px", marginBottom: 20,
            background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 10,
          }}>
            <div style={{ fontWeight: 700, color: "#166534", marginBottom: 8, fontSize: 14 }}>
              API Key Generated Successfully
            </div>
            <div style={{ fontSize: 12, color: "#15803D", marginBottom: 10 }}>
              Copy this key now — it will not be shown again.
            </div>
            <div style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "10px 14px", background: "white", borderRadius: 6,
              border: "1px solid #D1FAE5", fontFamily: "monospace", fontSize: 13,
              wordBreak: "break-all",
            }}>
              <span style={{ flex: 1 }}>{generatedKey}</span>
              <button
                onClick={copyKey}
                style={{
                  padding: "6px 14px", borderRadius: 6, border: "1px solid #BBF7D0",
                  background: copiedKey ? "#059669" : "white",
                  color: copiedKey ? "white" : "#059669",
                  cursor: "pointer", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap",
                }}
              >
                {copiedKey ? "Copied!" : "Copy"}
              </button>
            </div>
          </div>
        )}

        {/* Error */}
        {actionData && "error" in actionData && (
          <div style={{
            padding: "12px 16px", marginBottom: 16,
            background: "#FEF2F2", border: "1px solid #FECACA", borderRadius: 8,
            color: "#DC2626", fontSize: 13,
          }}>
            {actionData.error}
          </div>
        )}

        {/* Success */}
        {actionData && "success" in actionData && (
          <div style={{
            padding: "12px 16px", marginBottom: 16,
            background: "#F0FDF4", border: "1px solid #BBF7D0", borderRadius: 8,
            color: "#166534", fontSize: 13,
          }}>
            {actionData.success}
          </div>
        )}

        {/* Header with create button */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: "var(--rpm-text, #0f172a)" }}>
              External API Keys
            </div>
            <div style={{ fontSize: 12, color: "var(--rpm-text-muted, #64748b)", marginTop: 2 }}>
              Generate API keys for ERP systems and external integrations to access your return data.
            </div>
          </div>
          <button
            onClick={() => setShowForm(!showForm)}
            style={{
              padding: "8px 16px", borderRadius: 8, border: "none",
              background: "#3B82F6", color: "white", fontSize: 13, fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {showForm ? "Cancel" : "Generate New Key"}
          </button>
        </div>

        {/* Generate Form */}
        {showForm && (
          <fetcher.Form method="post" style={{
            padding: "20px", marginBottom: 20,
            background: "var(--rpm-surface, white)", borderRadius: 10,
            border: "var(--rpm-border, 1px solid #e5e7eb)",
          }}>
            <input type="hidden" name="_action" value="generate" />
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 13, fontWeight: 600, display: "block", marginBottom: 4 }}>Key Name</label>
              <input
                type="text" name="name" placeholder="e.g. ERP Integration" required
                style={{
                  width: "100%", padding: "8px 12px", borderRadius: 6,
                  border: "1px solid #D1D5DB", fontSize: 13, boxSizing: "border-box",
                }}
              />
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 13, fontWeight: 600, display: "block", marginBottom: 6 }}>Permissions</label>
              {PERMISSIONS_LIST.map((perm) => (
                <label key={perm} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, fontSize: 13 }}>
                  <input type="checkbox" name={`perm_${perm}`} defaultChecked />
                  {PERM_LABELS[perm] || perm}
                </label>
              ))}
            </div>
            <button
              type="submit" disabled={isSubmitting}
              style={{
                padding: "8px 20px", borderRadius: 8, border: "none",
                background: "#059669", color: "white", fontSize: 13, fontWeight: 600,
                cursor: isSubmitting ? "wait" : "pointer",
                opacity: isSubmitting ? 0.6 : 1,
              }}
            >
              {isSubmitting ? "Generating..." : "Generate Key"}
            </button>
          </fetcher.Form>
        )}

        {/* Keys List */}
        {keys.length === 0 ? (
          <div style={{
            padding: "40px 20px", textAlign: "center",
            background: "var(--rpm-surface, white)", borderRadius: 10,
            border: "var(--rpm-border, 1px solid #e5e7eb)",
            color: "var(--rpm-text-muted, #64748b)", fontSize: 13,
          }}>
            No API keys generated yet. Click "Generate New Key" to create one.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            {keys.map((key: any) => {
              let perms: string[] = [];
              try { perms = JSON.parse(key.permissions); } catch { /* */ }
              const isRevoked = !key.isActive || key.revokedAt;

              return (
                <div key={key.id} style={{
                  padding: "16px 20px",
                  background: isRevoked ? "#F9FAFB" : "var(--rpm-surface, white)",
                  borderRadius: 10,
                  border: isRevoked ? "1px solid #E5E7EB" : "var(--rpm-border, 1px solid #e5e7eb)",
                  opacity: isRevoked ? 0.6 : 1,
                }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                    <div>
                      <div style={{ fontWeight: 600, fontSize: 14, color: "var(--rpm-text, #0f172a)" }}>
                        {key.name}
                      </div>
                      <div style={{ fontSize: 12, color: "var(--rpm-text-muted, #64748b)", marginTop: 2, fontFamily: "monospace" }}>
                        {key.keyPrefix}{"•".repeat(36)}
                      </div>
                    </div>
                    <div style={{ display: "flex", gap: 6 }}>
                      {isRevoked ? (
                        <span style={{
                          fontSize: 11, fontWeight: 600, padding: "3px 9px", borderRadius: 5,
                          background: "#FEF2F2", color: "#DC2626", border: "1px solid #FECACA",
                        }}>
                          Revoked
                        </span>
                      ) : (
                        <span style={{
                          fontSize: 11, fontWeight: 600, padding: "3px 9px", borderRadius: 5,
                          background: "#ECFDF5", color: "#065F46", border: "1px solid #A7F3D0",
                        }}>
                          Active
                        </span>
                      )}
                    </div>
                  </div>

                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 8 }}>
                    {perms.map((p: string) => (
                      <span key={p} style={{
                        fontSize: 10, padding: "2px 7px", borderRadius: 4,
                        background: "#EFF6FF", color: "#1E40AF", border: "1px solid #BFDBFE",
                      }}>
                        {p}
                      </span>
                    ))}
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 10 }}>
                    <div style={{ fontSize: 11, color: "var(--rpm-text-muted, #94a3b8)" }}>
                      Created {new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(key.createdAt))}
                      {key.lastUsedAt && ` · Last used ${new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(key.lastUsedAt))}`}
                    </div>
                    {!isRevoked && (
                      <div style={{ display: "flex", gap: 6 }}>
                        <fetcher.Form method="post" style={{ display: "inline" }}>
                          <input type="hidden" name="_action" value="revoke" />
                          <input type="hidden" name="keyId" value={key.id} />
                          <button
                            type="submit"
                            disabled={isSubmitting}
                            style={{
                              padding: "4px 10px", borderRadius: 5, border: "1px solid #FDE68A",
                              background: "#FFFBEB", color: "#92400E", fontSize: 11, fontWeight: 600,
                              cursor: "pointer",
                            }}
                          >
                            Revoke
                          </button>
                        </fetcher.Form>
                      </div>
                    )}
                    {isRevoked && (
                      <fetcher.Form method="post" style={{ display: "inline" }}>
                        <input type="hidden" name="_action" value="delete" />
                        <input type="hidden" name="keyId" value={key.id} />
                        <button
                          type="submit"
                          disabled={isSubmitting}
                          style={{
                            padding: "4px 10px", borderRadius: 5, border: "1px solid #FECACA",
                            background: "#FEF2F2", color: "#DC2626", fontSize: 11, fontWeight: 600,
                            cursor: "pointer",
                          }}
                        >
                          Delete
                        </button>
                      </fetcher.Form>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* API Docs Link */}
        <div style={{
          marginTop: 20, padding: "14px 20px",
          background: "#EFF6FF", borderRadius: 10, border: "1px solid #BFDBFE",
          display: "flex", alignItems: "center", justifyContent: "space-between",
        }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#1E40AF" }}>API Documentation</div>
            <div style={{ fontSize: 12, color: "#3B82F6" }}>View complete endpoint reference and download Postman collection.</div>
          </div>
          <Link to="/app/api-docs" style={{ textDecoration: "none" }}>
            <button style={{
              padding: "6px 14px", borderRadius: 6, border: "1px solid #93C5FD",
              background: "white", color: "#2563EB", fontSize: 12, fontWeight: 600,
              cursor: "pointer",
            }}>
              View Docs
            </button>
          </Link>
        </div>
      </div>
    </s-page>
  );
}
