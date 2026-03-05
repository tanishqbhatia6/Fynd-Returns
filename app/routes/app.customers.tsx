import React, { useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useSearchParams, useRouteError, isRouteErrorResponse } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { findOrCreateShop } from "../lib/shop.server";
import { formatReturnRequestId } from "../lib/return-request-id";
import { getStatusColor, getStatusBg } from "../lib/status-colors";

type ReturnRow = {
  id: string;
  returnRequestNo: string | null;
  orderName: string;
  status: string;
  resolutionType: string;
  refundAmount: number;
  refundCurrency: string;
  itemCount: number;
  itemTitles: string[];
  createdAt: string;
  isGreenReturn: boolean;
};

type CustomerSummary = {
  email: string;
  phone: string | null;
  returnCount: number;
  totalRefundAmount: number;
  currency: string;
  totalItemCount: number;
  firstReturnDate: string;
  lastReturnDate: string;
  statusBreakdown: Record<string, number>;
  resolutionBreakdown: Record<string, number>;
  returns: ReturnRow[];
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop);

  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
  const sortBy = url.searchParams.get("sort") ?? "count";

  const where: Record<string, unknown> = { shopId: shop.id };
  if (query) {
    where.OR = [
      { customerEmailNorm: { contains: query, mode: "insensitive" } },
      { customerPhoneNorm: { contains: query, mode: "insensitive" } },
      { shopifyOrderName: { contains: query, mode: "insensitive" } },
    ];
  }

  const allReturns = await prisma.returnCase.findMany({
    where,
    select: {
      id: true,
      returnRequestNo: true,
      shopifyOrderName: true,
      customerEmailNorm: true,
      customerPhoneNorm: true,
      status: true,
      refundJson: true,
      refundStatus: true,
      resolutionType: true,
      isGreenReturn: true,
      bonusCreditAmount: true,
      discountCodeValue: true,
      createdAt: true,
      items: {
        select: { title: true, qty: true, price: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const grouped = new Map<string, CustomerSummary>();

  for (const r of allReturns) {
    const email = (r.customerEmailNorm || "").toLowerCase().trim();
    if (!email) continue;

    let refundAmount = 0;
    let refundCurrency = "";
    if (r.refundJson) {
      try {
        const refund = JSON.parse(r.refundJson) as { amount?: string; currency?: string };
        refundAmount = parseFloat(refund.amount ?? "0") || 0;
        refundCurrency = refund.currency ?? "";
      } catch { /* skip */ }
    }
    if (refundAmount === 0 && r.discountCodeValue) {
      refundAmount = parseFloat(r.discountCodeValue) || 0;
    }
    if (refundAmount === 0 && r.bonusCreditAmount) {
      refundAmount = parseFloat(r.bonusCreditAmount) || 0;
    }

    const itemCount = r.items.reduce((sum, it) => sum + it.qty, 0) || 0;
    const itemTitles = r.items.map((it) => it.title).filter(Boolean) as string[];

    let existing = grouped.get(email);
    if (!existing) {
      existing = {
        email,
        phone: r.customerPhoneNorm || null,
        returnCount: 0,
        totalRefundAmount: 0,
        currency: "",
        totalItemCount: 0,
        firstReturnDate: r.createdAt.toISOString(),
        lastReturnDate: r.createdAt.toISOString(),
        statusBreakdown: {},
        resolutionBreakdown: {},
        returns: [],
      };
      grouped.set(email, existing);
    }

    existing.returnCount++;
    existing.totalItemCount += itemCount;
    if (!existing.phone && r.customerPhoneNorm) existing.phone = r.customerPhoneNorm;

    const d = r.createdAt.toISOString();
    if (d < existing.firstReturnDate) existing.firstReturnDate = d;
    if (d > existing.lastReturnDate) existing.lastReturnDate = d;

    existing.totalRefundAmount += refundAmount;
    if (refundCurrency && !existing.currency) existing.currency = refundCurrency;

    const normStatus = r.status.toLowerCase();
    existing.statusBreakdown[normStatus] = (existing.statusBreakdown[normStatus] || 0) + 1;
    if (r.resolutionType) {
      existing.resolutionBreakdown[r.resolutionType] = (existing.resolutionBreakdown[r.resolutionType] || 0) + 1;
    }

    existing.returns.push({
      id: r.id,
      returnRequestNo: r.returnRequestNo,
      orderName: r.shopifyOrderName,
      status: r.status,
      resolutionType: r.resolutionType,
      refundAmount,
      refundCurrency,
      itemCount,
      itemTitles,
      createdAt: r.createdAt.toISOString(),
      isGreenReturn: r.isGreenReturn,
    });
  }

  let customers = Array.from(grouped.values());

  if (sortBy === "amount") {
    customers.sort((a, b) => b.totalRefundAmount - a.totalRefundAmount);
  } else if (sortBy === "recent") {
    customers.sort((a, b) => new Date(b.lastReturnDate).getTime() - new Date(a.lastReturnDate).getTime());
  } else {
    customers.sort((a, b) => b.returnCount - a.returnCount);
  }

  const totalCustomers = customers.length;
  const totalReturns = customers.reduce((s, c) => s + c.returnCount, 0);
  const totalRefunded = customers.reduce((s, c) => s + c.totalRefundAmount, 0);
  const serialReturners = customers.filter((c) => c.returnCount >= 3).length;

  return {
    customers,
    query,
    sortBy,
    totalCustomers,
    totalReturns,
    totalRefunded,
    serialReturners,
    shopLocale: shop.settings?.shopLocale ?? "en",
    shopCurrency: shop.settings?.shopCurrency ?? "USD",
    shopTimezone: shop.settings?.shopTimezone ?? "UTC",
  };
};

function fmtMoney(amount: number, currency?: string | null, locale?: string | null): string {
  if (amount === 0) return fmtMoneyZero(currency, locale);
  try {
    return new Intl.NumberFormat(locale || "en", {
      style: "currency",
      currency: currency || "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${currency || "USD"} ${amount.toFixed(2)}`;
  }
}

function fmtMoneyZero(currency?: string | null, locale?: string | null): string {
  try {
    return new Intl.NumberFormat(locale || "en", {
      style: "currency",
      currency: currency || "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(0);
  } catch {
    return `${currency || "USD"} 0.00`;
  }
}

function fmtDate(d: string | Date, locale?: string | null, tz?: string | null): string {
  try {
    return new Intl.DateTimeFormat(locale || "en", { dateStyle: "medium", timeZone: tz || "UTC" }).format(new Date(d));
  } catch {
    return String(d).slice(0, 10);
  }
}

const RESOLUTION_LABELS: Record<string, string> = {
  refund: "Refund",
  exchange: "Exchange",
  store_credit: "Store Credit",
  replacement: "Replacement",
};

const RESOLUTION_STYLES: Record<string, { bg: string; color: string }> = {
  refund: { bg: "#F5F3FF", color: "#6B21A8" },
  exchange: { bg: "#DCFCE7", color: "#166534" },
  store_credit: { bg: "#FEF3C7", color: "#92400E" },
  replacement: { bg: "#FFF7ED", color: "#C2410C" },
};

export default function CustomersPage() {
  const {
    customers, query, sortBy,
    totalCustomers, totalReturns, totalRefunded, serialReturners,
    shopLocale, shopCurrency, shopTimezone,
  } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [expandedEmail, setExpandedEmail] = useState<string | null>(null);

  const handleSearch = (val: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (val.trim()) next.set("q", val.trim());
      else next.delete("q");
      return next;
    });
  };

  const handleSort = (s: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("sort", s);
      return next;
    });
  };

  return (
    <s-page heading="Customers">
      <div className="app-content" style={{ maxWidth: 1200, margin: "0 auto" }}>
        {/* ── Summary Stats ── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 20 }}>
          {[
            { label: "Total Customers", value: totalCustomers, color: "#334155", bg: "#f8fafc", border: "#e2e8f0" },
            { label: "Total Returns", value: totalReturns, color: "#3b82f6", bg: "#eff6ff", border: "#bfdbfe" },
            { label: "Total Refunded", value: fmtMoney(totalRefunded, shopCurrency, shopLocale), color: "#7c3aed", bg: "#f5f3ff", border: "#ddd6fe", isText: true },
            { label: "Serial Returners", value: serialReturners, color: "#dc2626", bg: "#fef2f2", border: "#fecaca" },
          ].map((s) => (
            <div key={s.label} style={{ padding: "14px 16px", background: s.bg, borderRadius: 10, border: `1px solid ${s.border}`, textAlign: "center" }}>
              <div style={{ fontSize: (s as { isText?: boolean }).isText ? 16 : 22, fontWeight: 800, color: s.color, lineHeight: 1.2, marginBottom: 4, fontVariantNumeric: "tabular-nums" }}>
                {s.value}
              </div>
              <div style={{ fontSize: 10, fontWeight: 700, color: s.color, opacity: 0.7, textTransform: "uppercase", letterSpacing: "0.05em" }}>
                {s.label}
              </div>
            </div>
          ))}
        </div>

        {/* ── Search & Sort Toolbar ── */}
        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap", padding: "14px 20px", background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", marginBottom: 16 }}>
          <div style={{ flex: "1 1 240px", minWidth: 180, position: "relative" }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2" style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}>
              <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
            </svg>
            <input
              type="text"
              placeholder="Search by email, phone, or order..."
              defaultValue={query}
              className="app-input"
              style={{ width: "100%", fontSize: 13, paddingLeft: 36 }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSearch((e.target as HTMLInputElement).value);
              }}
            />
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {([
              { key: "count", label: "Most Returns" },
              { key: "amount", label: "Highest Refund" },
              { key: "recent", label: "Most Recent" },
            ] as const).map((s) => (
              <button
                key={s.key}
                type="button"
                onClick={() => handleSort(s.key)}
                style={{
                  padding: "7px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer",
                  border: sortBy === s.key ? "1px solid #4f46e5" : "1px solid #e5e7eb",
                  background: sortBy === s.key ? "#eef2ff" : "#fff",
                  color: sortBy === s.key ? "#4f46e5" : "#6b7280",
                  transition: "all 0.15s",
                }}
              >
                {s.label}
              </button>
            ))}
          </div>
          {query && (
            <button
              type="button"
              onClick={() => handleSearch("")}
              style={{ padding: "7px 14px", borderRadius: 7, fontSize: 12, fontWeight: 600, cursor: "pointer", border: "1px solid #e5e7eb", background: "#fff", color: "#6b7280" }}
            >
              Clear
            </button>
          )}
        </div>

        {/* ── Results ── */}
        {customers.length === 0 ? (
          <div style={{ padding: "64px 24px", textAlign: "center", background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb" }}>
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#d1d5db" strokeWidth="1.5" style={{ marginBottom: 16 }}>
              <path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2"/><circle cx="12" cy="7" r="4"/>
            </svg>
            <p style={{ fontSize: 16, fontWeight: 700, color: "#111827", marginBottom: 6 }}>
              {query ? "No customers found" : "No customer data yet"}
            </p>
            <p style={{ fontSize: 13, color: "#6b7280", maxWidth: 360, margin: "0 auto" }}>
              {query ? `No customers match "${query}". Try adjusting your search.` : "Customer data will appear here after returns are submitted."}
            </p>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8, padding: "0 4px" }}>
              {customers.length} customer{customers.length !== 1 ? "s" : ""}{query ? ` matching "${query}"` : ""}
            </div>

            <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", overflow: "hidden" }}>
              {/* Table Header */}
              <div style={{ display: "grid", gridTemplateColumns: "2.4fr 1.2fr 0.7fr 1.2fr 1fr 1fr", padding: "10px 20px", background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
                {["Email", "Phone", "Returns", "Total Refunded", "First Return", "Last Return"].map((h) => (
                  <div key={h} style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em" }}>
                    {h}
                  </div>
                ))}
              </div>

              {/* Rows */}
              {customers.map((cust, idx) => {
                const isExpanded = expandedEmail === cust.email;
                const isSerial = cust.returnCount >= 3;
                const isLast = idx === customers.length - 1;

                return (
                  <div key={cust.email} style={{ borderBottom: isLast ? "none" : "1px solid #f3f4f6" }}>
                    {/* Summary Row */}
                    <div
                      onClick={() => setExpandedEmail(isExpanded ? null : cust.email)}
                      style={{
                        display: "grid",
                        gridTemplateColumns: "2.4fr 1.2fr 0.7fr 1.2fr 1fr 1fr",
                        padding: "14px 20px",
                        cursor: "pointer",
                        alignItems: "center",
                        transition: "background 0.1s",
                        background: isExpanded ? "#fafbff" : "transparent",
                      }}
                      onMouseEnter={(e) => { if (!isExpanded) (e.currentTarget as HTMLDivElement).style.background = "#fafbfc"; }}
                      onMouseLeave={(e) => { if (!isExpanded) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
                    >
                      {/* Email */}
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2" style={{ flexShrink: 0, transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}>
                          <polyline points="9 18 15 12 9 6"/>
                        </svg>
                        <span style={{ fontSize: 13, fontWeight: 600, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {cust.email}
                        </span>
                        {isSerial && (
                          <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 999, background: "#FEE2E2", color: "#DC2626", textTransform: "uppercase", letterSpacing: "0.03em", flexShrink: 0 }}>
                            Serial
                          </span>
                        )}
                      </div>

                      {/* Phone */}
                      <div style={{ fontSize: 13, color: cust.phone ? "#374151" : "#d1d5db" }}>
                        {cust.phone || "Not provided"}
                      </div>

                      {/* Returns count */}
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", fontVariantNumeric: "tabular-nums" }}>
                        {cust.returnCount}
                      </div>

                      {/* Total Refunded */}
                      <div style={{ fontSize: 13, fontWeight: 600, color: cust.totalRefundAmount > 0 ? "#111827" : "#9ca3af", fontVariantNumeric: "tabular-nums" }}>
                        {fmtMoney(cust.totalRefundAmount, cust.currency || shopCurrency, shopLocale)}
                      </div>

                      {/* First Return */}
                      <div style={{ fontSize: 12, color: "#6b7280", fontVariantNumeric: "tabular-nums" }}>
                        {fmtDate(cust.firstReturnDate, shopLocale, shopTimezone)}
                      </div>

                      {/* Last Return */}
                      <div style={{ fontSize: 12, color: "#6b7280", fontVariantNumeric: "tabular-nums" }}>
                        {fmtDate(cust.lastReturnDate, shopLocale, shopTimezone)}
                      </div>
                    </div>

                    {/* Expanded Detail */}
                    {isExpanded && (
                      <div style={{ padding: "0 20px 20px", background: "#fafbff", borderTop: "1px solid #eef2ff" }}>
                        {/* Customer Quick Stats */}
                        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", marginTop: 16, marginBottom: 16 }}>
                          <MiniStat label="Total Items Returned" value={String(cust.totalItemCount)} />
                          <MiniStat label="Avg Items / Return" value={cust.returnCount > 0 ? (cust.totalItemCount / cust.returnCount).toFixed(1) : "0"} />
                          {Object.entries(cust.resolutionBreakdown).map(([res, count]) => (
                            <MiniStat key={res} label={RESOLUTION_LABELS[res] || res} value={String(count)} />
                          ))}
                        </div>

                        {/* Return History */}
                        <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 8 }}>
                          Return History
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                          {cust.returns.map((r) => (
                            <Link
                              key={r.id}
                              to={`/app/returns/${r.id}`}
                              style={{ textDecoration: "none", color: "inherit" }}
                            >
                              <div
                                style={{
                                  display: "grid",
                                  gridTemplateColumns: "1fr 1.2fr 1fr 1fr 0.8fr",
                                  gap: 8,
                                  alignItems: "center",
                                  padding: "10px 14px",
                                  background: "#fff",
                                  borderRadius: 8,
                                  border: "1px solid #e5e7eb",
                                  transition: "border-color 0.15s, box-shadow 0.15s",
                                }}
                                onMouseEnter={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = "#c7d2fe"; (e.currentTarget as HTMLDivElement).style.boxShadow = "0 1px 3px rgba(79,70,229,0.08)"; }}
                                onMouseLeave={(e) => { (e.currentTarget as HTMLDivElement).style.borderColor = "#e5e7eb"; (e.currentTarget as HTMLDivElement).style.boxShadow = "none"; }}
                              >
                                {/* Return ID + Order */}
                                <div>
                                  <div style={{ fontSize: 12, fontWeight: 700, fontFamily: "var(--rpm-font-mono, monospace)", color: "#4f46e5" }}>
                                    {r.returnRequestNo || formatReturnRequestId(r.id)}
                                  </div>
                                  <div style={{ fontSize: 11, color: "#6b7280", marginTop: 2 }}>
                                    Order {r.orderName || "—"}
                                  </div>
                                </div>

                                {/* Items */}
                                <div>
                                  <div style={{ fontSize: 12, color: "#374151" }}>
                                    {r.itemCount} item{r.itemCount !== 1 ? "s" : ""}
                                    {r.isGreenReturn && (
                                      <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 4, background: "#DCFCE7", color: "#166534" }}>GREEN</span>
                                    )}
                                  </div>
                                  {r.itemTitles.length > 0 && (
                                    <div style={{ fontSize: 10, color: "#9ca3af", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 200 }}>
                                      {r.itemTitles.slice(0, 2).join(", ")}{r.itemTitles.length > 2 ? ` +${r.itemTitles.length - 2}` : ""}
                                    </div>
                                  )}
                                </div>

                                {/* Status + Resolution */}
                                <div style={{ display: "flex", flexDirection: "column", gap: 3, alignItems: "flex-start" }}>
                                  <span style={{
                                    display: "inline-flex", alignItems: "center", gap: 4,
                                    padding: "2px 8px", borderRadius: 5, fontSize: 10, fontWeight: 700,
                                    background: getStatusBg(r.status), color: getStatusColor(r.status),
                                    textTransform: "capitalize",
                                  }}>
                                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: getStatusColor(r.status) }} />
                                    {r.status}
                                  </span>
                                  {r.resolutionType !== "refund" && (
                                    <span style={{
                                      fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 4, textTransform: "uppercase",
                                      ...(RESOLUTION_STYLES[r.resolutionType] || { bg: "#f3f4f6", color: "#374151" }),
                                      background: (RESOLUTION_STYLES[r.resolutionType] || { bg: "#f3f4f6" }).bg,
                                      color: (RESOLUTION_STYLES[r.resolutionType] || { color: "#374151" }).color,
                                    }}>
                                      {RESOLUTION_LABELS[r.resolutionType] || r.resolutionType}
                                    </span>
                                  )}
                                </div>

                                {/* Refund Amount */}
                                <div style={{ fontSize: 12, fontWeight: 600, color: r.refundAmount > 0 ? "#111827" : "#9ca3af", fontVariantNumeric: "tabular-nums" }}>
                                  {fmtMoney(r.refundAmount, r.refundCurrency || shopCurrency, shopLocale)}
                                </div>

                                {/* Date */}
                                <div style={{ fontSize: 11, color: "#6b7280", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                                  {fmtDate(r.createdAt, shopLocale, shopTimezone)}
                                </div>
                              </div>
                            </Link>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>
    </s-page>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: "8px 14px", background: "#fff", borderRadius: 8, border: "1px solid #e5e7eb", minWidth: 80 }}>
      <div style={{ fontSize: 15, fontWeight: 800, color: "#111827", lineHeight: 1.2, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div style={{ fontSize: 10, fontWeight: 600, color: "#9ca3af", textTransform: "uppercase", letterSpacing: "0.03em", marginTop: 2 }}>{label}</div>
    </div>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const msg = isRouteErrorResponse(error)
    ? error.data || `Error ${error.status}`
    : error instanceof Error ? error.message : "An unexpected error occurred.";
  return (
    <s-page heading="Customers">
      <div className="app-content">
        <div className="app-alert app-alert-error" style={{ marginBottom: 20 }}>
          <p style={{ fontWeight: 600, fontSize: 14 }}>{msg}</p>
          <Link to="/app/customers" style={{ fontSize: 13, fontWeight: 600, color: "#005bd3", textDecoration: "none" }}>Try again</Link>
        </div>
      </div>
    </s-page>
  );
}
