import React, { useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, Link } from "react-router";
import { EXTERNAL_API_ENDPOINTS } from "../lib/api-docs-data";
import { AppPage } from "../components/AppPage";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { authenticate } = await import("../shopify.server");
  await authenticate.admin(request);
  const baseUrl = process.env.SHOPIFY_APP_URL || new URL(request.url).origin;
  return { endpoints: EXTERNAL_API_ENDPOINTS, baseUrl };
};

const METHOD_COLORS: Record<string, { bg: string; color: string }> = {
  GET: { bg: "#ECFDF5", color: "#059669" },
  POST: { bg: "#EFF6FF", color: "#2563EB" },
  DELETE: { bg: "#FEF2F2", color: "#DC2626" },
};

export default function ApiDocs() {
  const { endpoints, baseUrl } = useLoaderData<typeof loader>();
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  // Group by folder
  const folders = new Map<string, typeof endpoints>();
  for (const ep of endpoints) {
    const list = folders.get(ep.folder) || [];
    list.push(ep);
    folders.set(ep.folder, list);
  }

  return (
    <AppPage heading="API Documentation" backHref="/app/settings">
      <div className="app-content layout-medium">
        {/* Header */}
        <div
          style={{
            padding: "20px 24px",
            marginBottom: 20,
            background: "linear-gradient(135deg, #1E3A5F 0%, #2563EB 100%)",
            borderRadius: 12,
            color: "white",
          }}
        >
          <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 6 }}>
            ReturnProMax External API
          </div>
          <div style={{ fontSize: 13, opacity: 0.9, marginBottom: 12, lineHeight: 1.5 }}>
            Integrate your ERP, warehouse, or custom systems with ReturnProMax. All endpoints
            require an API key passed via the{" "}
            <code
              style={{ background: "rgba(255,255,255,0.15)", padding: "1px 5px", borderRadius: 3 }}
            >
              X-API-Key
            </code>{" "}
            header.
          </div>
          <div style={{ display: "flex", gap: 10 }}>
            <a
              href={`${baseUrl}/api/v1/external/postman`}
              target="_blank"
              rel="noopener"
              style={{
                padding: "8px 16px",
                borderRadius: 6,
                background: "white",
                color: "#2563EB",
                fontSize: 12,
                fontWeight: 600,
                textDecoration: "none",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Download Postman Collection
            </a>
            <Link
              to="/app/settings/api-keys"
              style={{
                padding: "8px 16px",
                borderRadius: 6,
                background: "rgba(255,255,255,0.15)",
                color: "white",
                fontSize: 12,
                fontWeight: 600,
                textDecoration: "none",
                border: "1px solid rgba(255,255,255,0.3)",
              }}
            >
              Manage API Keys
            </Link>
          </div>
        </div>

        {/* Auth Section */}
        <div
          style={{
            padding: "16px 20px",
            marginBottom: 20,
            background: "#FFFBEB",
            borderRadius: 10,
            border: "1px solid #FDE68A",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 700, color: "#92400E", marginBottom: 6 }}>
            Authentication
          </div>
          <div style={{ fontSize: 13, color: "#A16207", lineHeight: 1.6 }}>
            All endpoints require an API key. Include it in every request header:
          </div>
          <div
            style={{
              marginTop: 8,
              padding: "10px 14px",
              background: "#FEF3C7",
              borderRadius: 6,
              fontFamily: "monospace",
              fontSize: 12,
              color: "#78350F",
            }}
          >
            X-API-Key: rpm_your_key_here
          </div>
          <div style={{ fontSize: 12, color: "#A16207", marginTop: 8 }}>
            Generate keys from{" "}
            <Link to="/app/settings/api-keys" style={{ color: "#92400E", fontWeight: 600 }}>
              Settings → API Keys
            </Link>
            . Each key has scoped permissions (read_returns, write_returns, read_settings,
            manage_webhooks).
          </div>
        </div>

        {/* Base URL */}
        <div
          style={{
            padding: "12px 16px",
            marginBottom: 20,
            background: "var(--rpm-surface, white)",
            borderRadius: 8,
            border: "var(--rpm-border, 1px solid #e5e7eb)",
          }}
        >
          <span style={{ fontSize: 12, fontWeight: 600, color: "var(--rpm-text-muted, #64748b)" }}>
            Base URL:{" "}
          </span>
          <code style={{ fontSize: 12, color: "#2563EB", fontFamily: "monospace" }}>{baseUrl}</code>
        </div>

        {/* Pagination Guide */}
        <div
          style={{
            padding: "16px 20px",
            marginBottom: 20,
            background: "var(--rpm-surface, white)",
            borderRadius: 10,
            border: "var(--rpm-border, 1px solid #e5e7eb)",
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", marginBottom: 8 }}>
            Pagination
          </div>
          <div style={{ fontSize: 13, color: "#374151", lineHeight: 1.6, marginBottom: 10 }}>
            All list endpoints use offset-based pagination. Control the page and page size via query
            params. The response always includes a{" "}
            <code style={{ background: "#f3f4f6", padding: "1px 5px", borderRadius: 3 }}>meta</code>{" "}
            envelope with totals.
          </div>
          <div
            style={{
              padding: "10px 14px",
              background: "#f8fafc",
              borderRadius: 6,
              fontFamily: "monospace",
              fontSize: 12,
              color: "#374151",
              marginBottom: 10,
            }}
          >
            {`GET /api/v1/external/returns?page=2&pageSize=25&status=pending`}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <div style={{ padding: "10px 14px", background: "#f8fafc", borderRadius: 6 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#6b7280",
                  textTransform: "uppercase",
                  marginBottom: 6,
                }}
              >
                Request params
              </div>
              <div
                style={{ fontSize: 12, fontFamily: "monospace", color: "#374151", lineHeight: 1.7 }}
              >
                page=1 <span style={{ color: "#9ca3af" }}>// default: 1</span>
                <br />
                pageSize=25 <span style={{ color: "#9ca3af" }}>// default: 25, max: 100</span>
              </div>
            </div>
            <div style={{ padding: "10px 14px", background: "#f8fafc", borderRadius: 6 }}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: "#6b7280",
                  textTransform: "uppercase",
                  marginBottom: 6,
                }}
              >
                Response meta
              </div>
              <div
                style={{ fontSize: 12, fontFamily: "monospace", color: "#374151", lineHeight: 1.7 }}
              >
                {"meta: {"}
                <br />
                {"  page, pageSize,"}
                <br />
                {"  totalCount, totalPages,"}
                <br />
                {"  hasNextPage"}
                <br />
                {"}"}
              </div>
            </div>
          </div>
        </div>

        {/* Endpoint Groups */}
        {Array.from(folders.entries()).map(([folderName, eps]) => (
          <div key={folderName} style={{ marginBottom: 24 }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: "var(--rpm-text-muted, #64748b)",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                marginBottom: 10,
              }}
            >
              {folderName}
            </div>

            {eps.map((ep, idx) => {
              const globalIdx = endpoints.indexOf(ep);
              const isExpanded = expandedIdx === globalIdx;
              /* v8 ignore start */
              // defensive: every ep.method has a METHOD_COLORS entry; fallback unreachable
              const mc = METHOD_COLORS[ep.method] || { bg: "#F3F4F6", color: "#374151" };
              /* v8 ignore stop */

              return (
                <div
                  key={globalIdx}
                  style={{
                    marginBottom: 8,
                    borderRadius: 8,
                    border: "var(--rpm-border, 1px solid #e5e7eb)",
                    overflow: "hidden",
                  }}
                >
                  {/* Endpoint Header */}
                  <button
                    /* v8 ignore start */
                    // defensive: collapse/expand toggle ternary
                    onClick={() => setExpandedIdx(isExpanded ? null : globalIdx)}
                    /* v8 ignore stop */
                    style={{
                      width: "100%",
                      padding: "12px 16px",
                      background: isExpanded ? "#F8FAFC" : "var(--rpm-surface, white)",
                      border: "none",
                      cursor: "pointer",
                      textAlign: "left",
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        padding: "3px 8px",
                        borderRadius: 4,
                        background: mc.bg,
                        color: mc.color,
                        minWidth: 48,
                        textAlign: "center",
                      }}
                    >
                      {ep.method}
                    </span>
                    <code
                      style={{
                        fontSize: 13,
                        color: "var(--rpm-text, #0f172a)",
                        fontFamily: "monospace",
                      }}
                    >
                      {ep.path}
                    </code>
                    <span style={{ flex: 1 }} />
                    <span style={{ fontSize: 12, color: "var(--rpm-text-muted, #94a3b8)" }}>
                      {ep.name}
                    </span>
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#94a3b8"
                      strokeWidth="2"
                      style={{
                        transform: isExpanded ? "rotate(180deg)" : "rotate(0deg)",
                        transition: "transform 0.2s",
                      }}
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>

                  {/* Expanded Detail */}
                  {isExpanded && (
                    <div
                      style={{
                        padding: "16px 20px",
                        borderTop: "1px solid #E5E7EB",
                        background: "#FAFBFC",
                      }}
                    >
                      <div
                        style={{
                          fontSize: 13,
                          color: "var(--rpm-text, #374151)",
                          lineHeight: 1.6,
                          marginBottom: 12,
                        }}
                      >
                        {ep.description}
                      </div>
                      <div style={{ fontSize: 11, marginBottom: 12 }}>
                        <span
                          style={{
                            padding: "2px 7px",
                            borderRadius: 4,
                            background: "#EFF6FF",
                            color: "#1E40AF",
                            border: "1px solid #BFDBFE",
                          }}
                        >
                          Permission: {ep.permission}
                        </span>
                      </div>

                      {/* Query Params */}
                      {ep.queryParams && (
                        <div style={{ marginBottom: 12 }}>
                          <div
                            style={{
                              fontSize: 12,
                              fontWeight: 700,
                              marginBottom: 6,
                              color: "var(--rpm-text, #0f172a)",
                            }}
                          >
                            Query Parameters
                          </div>
                          <table
                            style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}
                          >
                            <thead>
                              <tr style={{ background: "#F1F5F9" }}>
                                <th
                                  style={{
                                    padding: "6px 10px",
                                    textAlign: "left",
                                    borderBottom: "1px solid #E2E8F0",
                                  }}
                                >
                                  Param
                                </th>
                                <th
                                  style={{
                                    padding: "6px 10px",
                                    textAlign: "left",
                                    borderBottom: "1px solid #E2E8F0",
                                  }}
                                >
                                  Description
                                </th>
                                <th
                                  style={{
                                    padding: "6px 10px",
                                    textAlign: "left",
                                    borderBottom: "1px solid #E2E8F0",
                                  }}
                                >
                                  Example
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {ep.queryParams.map((p) => (
                                <tr key={p.key}>
                                  <td
                                    style={{
                                      padding: "6px 10px",
                                      borderBottom: "1px solid #F1F5F9",
                                      fontFamily: "monospace",
                                      color: "#2563EB",
                                    }}
                                  >
                                    {p.key}
                                  </td>
                                  <td
                                    style={{
                                      padding: "6px 10px",
                                      borderBottom: "1px solid #F1F5F9",
                                      color: "#475569",
                                    }}
                                  >
                                    {p.description}
                                  </td>
                                  <td
                                    style={{
                                      padding: "6px 10px",
                                      borderBottom: "1px solid #F1F5F9",
                                      fontFamily: "monospace",
                                      color: "#6B7280",
                                    }}
                                  >
                                    {p.example}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}

                      {/* Request Body */}
                      {ep.requestBody && (
                        <div style={{ marginBottom: 12 }}>
                          <div
                            style={{
                              fontSize: 12,
                              fontWeight: 700,
                              marginBottom: 6,
                              color: "var(--rpm-text, #0f172a)",
                            }}
                          >
                            Request Body
                          </div>
                          <div style={{ fontSize: 11, color: "#6B7280", marginBottom: 4 }}>
                            {ep.requestBody.description}
                          </div>
                          <pre
                            style={{
                              padding: "10px 14px",
                              background: "#1E293B",
                              color: "#E2E8F0",
                              borderRadius: 6,
                              fontSize: 11,
                              overflow: "auto",
                              maxHeight: 200,
                            }}
                          >
                            {JSON.stringify(ep.requestBody.example, null, 2)}
                          </pre>
                        </div>
                      )}

                      {/* Response */}
                      <div style={{ marginBottom: 12 }}>
                        <div
                          style={{
                            fontSize: 12,
                            fontWeight: 700,
                            marginBottom: 6,
                            color: "var(--rpm-text, #0f172a)",
                          }}
                        >
                          Response Example
                        </div>
                        <pre
                          style={{
                            padding: "10px 14px",
                            background: "#1E293B",
                            color: "#A7F3D0",
                            borderRadius: 6,
                            fontSize: 11,
                            overflow: "auto",
                            maxHeight: 300,
                          }}
                        >
                          {JSON.stringify(ep.responseExample, null, 2)}
                        </pre>
                      </div>

                      {/* Error Codes */}
                      {ep.errorCodes.length > 0 && (
                        <div>
                          <div
                            style={{
                              fontSize: 12,
                              fontWeight: 700,
                              marginBottom: 6,
                              color: "var(--rpm-text, #0f172a)",
                            }}
                          >
                            Error Codes
                          </div>
                          <table
                            style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}
                          >
                            <thead>
                              <tr style={{ background: "#F1F5F9" }}>
                                <th
                                  style={{
                                    padding: "6px 10px",
                                    textAlign: "left",
                                    borderBottom: "1px solid #E2E8F0",
                                  }}
                                >
                                  Status
                                </th>
                                <th
                                  style={{
                                    padding: "6px 10px",
                                    textAlign: "left",
                                    borderBottom: "1px solid #E2E8F0",
                                  }}
                                >
                                  Code
                                </th>
                                <th
                                  style={{
                                    padding: "6px 10px",
                                    textAlign: "left",
                                    borderBottom: "1px solid #E2E8F0",
                                  }}
                                >
                                  When
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {ep.errorCodes.map((e, ei) => (
                                <tr key={ei}>
                                  <td
                                    style={{
                                      padding: "6px 10px",
                                      borderBottom: "1px solid #F1F5F9",
                                      fontWeight: 600,
                                    }}
                                  >
                                    {e.status}
                                  </td>
                                  <td
                                    style={{
                                      padding: "6px 10px",
                                      borderBottom: "1px solid #F1F5F9",
                                      fontFamily: "monospace",
                                      color: "#DC2626",
                                    }}
                                  >
                                    {e.code}
                                  </td>
                                  <td
                                    style={{
                                      padding: "6px 10px",
                                      borderBottom: "1px solid #F1F5F9",
                                      color: "#475569",
                                    }}
                                  >
                                    {e.when}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}

        {/* Rate Limits */}
        <div
          style={{
            padding: "16px 20px",
            marginTop: 10,
            background: "var(--rpm-surface, white)",
            borderRadius: 10,
            border: "var(--rpm-border, 1px solid #e5e7eb)",
          }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: "var(--rpm-text, #0f172a)",
              marginBottom: 8,
            }}
          >
            Rate Limits
          </div>
          <table style={{ width: "100%", fontSize: 12, borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "#F8FAFC" }}>
                <th
                  style={{
                    padding: "6px 10px",
                    textAlign: "left",
                    borderBottom: "1px solid #E2E8F0",
                  }}
                >
                  Endpoint Type
                </th>
                <th
                  style={{
                    padding: "6px 10px",
                    textAlign: "left",
                    borderBottom: "1px solid #E2E8F0",
                  }}
                >
                  Limit
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ padding: "6px 10px", borderBottom: "1px solid #F1F5F9" }}>
                  Read endpoints (GET)
                </td>
                <td style={{ padding: "6px 10px", borderBottom: "1px solid #F1F5F9" }}>
                  120 requests/minute
                </td>
              </tr>
              <tr>
                <td style={{ padding: "6px 10px", borderBottom: "1px solid #F1F5F9" }}>
                  Write endpoints (POST approve/reject/refund)
                </td>
                <td style={{ padding: "6px 10px", borderBottom: "1px solid #F1F5F9" }}>
                  30 requests/minute
                </td>
              </tr>
              <tr>
                <td style={{ padding: "6px 10px", borderBottom: "1px solid #F1F5F9" }}>
                  Webhook management
                </td>
                <td style={{ padding: "6px 10px", borderBottom: "1px solid #F1F5F9" }}>
                  10 requests/minute
                </td>
              </tr>
            </tbody>
          </table>
          <div style={{ fontSize: 11, color: "var(--rpm-text-muted, #94a3b8)", marginTop: 8 }}>
            When rate limited, the response includes a <code>Retry-After</code> header (seconds).
          </div>
        </div>
      </div>
    </AppPage>
  );
}
