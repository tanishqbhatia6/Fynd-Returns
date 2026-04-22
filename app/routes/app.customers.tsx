import React, { useState } from "react";
import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useSearchParams, useRouteError, isRouteErrorResponse } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { findOrCreateShop } from "../lib/shop.server";
import { formatReturnRequestId } from "../lib/return-request-id";
import { getStatusColor, getStatusBg } from "../lib/status-colors";
import { fetchOrdersForCustomer, type CustomerOrderInfo } from "../lib/shopify-admin.server";

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
  name: string | null;
  phone: string | null;
  city: string | null;
  country: string | null;
  returnCount: number;
  totalRefundAmount: number;
  /** True when at least one refund row in this customer's total was computed from
   *  line-item list prices rather than from an actual Shopify refund record. The
   *  UI flags such totals as "≈" so the merchant doesn't treat them as exact. */
  totalRefundAmountIsEstimate: boolean;
  currency: string;
  totalItemCount: number;
  totalOrderValue: number;
  lifetimeOrderCount: number | null;
  lifetimeSpent: number | null;
  firstReturnDate: string;
  lastReturnDate: string;
  statusBreakdown: Record<string, number>;
  resolutionBreakdown: Record<string, number>;
  returns: ReturnRow[];
};

const CUSTOMERS_PAGE_SIZE = 50;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop);

  const url = new URL(request.url);
  const query = url.searchParams.get("q")?.trim().toLowerCase() ?? "";
  const sortBy = url.searchParams.get("sort") ?? "count";
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10));

  // Rate limit search to deter customer-list enumeration via a compromised admin
  // session (P2 finding from QA audit). Pagination doesn't count if it doesn't
  // change the query — but we throttle the route as a whole for simplicity.
  if (query.length > 0) {
    // Lazy-import so the route loader doesn't unconditionally pull rate-limit deps
    // (kept consistent with portal endpoints).
    const { checkRateLimit } = await import("../lib/rate-limit.server");
    const rl = checkRateLimit(request, "admin.customers.search");
    if (!rl.allowed) {
      throw new Response("Search rate limit exceeded — try again in a minute.", { status: 429 });
    }

    // Audit trail — every customer search emits a structured log entry captured
    // by the OTel collector. Enables incident response: if credentials are
    // compromised and an attacker runs an enumeration loop, the audit trail
    // shows what they queried and when. Not written to DB to avoid a migration
    // just for audit (OTel pipeline + log retention policy is the right place).
    try {
      const { securityLogger } = await import("../lib/observability/logger.server");
      securityLogger.info({
        event: "admin.customer_search",
        shopId: shop.id,
        shopDomain: session.shop,
        adminEmail: (session.onlineAccessInfo?.associated_user?.email as string | undefined) ?? null,
        // Never log the full query if it could be an email/phone — hash for traceability.
        queryHash: query.length > 0
          ? (await import("node:crypto")).createHash("sha256").update(query).digest("hex").slice(0, 16)
          : null,
        queryLength: query.length,
        page,
        sortBy,
      }, "Admin customer search");
    } catch { /* audit logging must never fail the request */ }
  }

  // ── Step 1: Global summary stats via fast aggregates (all customers, not just page) ──
  const [allGroupStats, globalTotalReturns] = await Promise.all([
    prisma.returnCase.groupBy({
      by: ["customerEmailNorm"],
      where: { shopId: shop.id, customerEmailNorm: { not: null } },
      _count: { id: true },
    }),
    prisma.returnCase.count({ where: { shopId: shop.id } }),
  ]);
  const totalCustomers = allGroupStats.length;
  const serialReturners = allGroupStats.filter((g) => g._count.id >= 3).length;

  // Global totalRefunded from DB refundJson (approximate — per-row shows Shopify-enriched amounts)
  const refundedForTotal = await prisma.returnCase.findMany({
    where: { shopId: shop.id, refundStatus: "refunded", refundJson: { not: null } },
    select: { refundJson: true },
    take: 5000,
  });
  let totalRefunded = 0;
  for (const rc of refundedForTotal) {
    try { totalRefunded += parseFloat(JSON.parse(rc.refundJson ?? "{}").amount ?? "0") || 0; } catch { /* skip */ }
  }

  // ── Step 2: Search where (supports query filter) ──
  const searchWhere: Record<string, unknown> = { shopId: shop.id, customerEmailNorm: { not: null } };
  if (query) {
    searchWhere.OR = [
      { customerEmailNorm: { contains: query, mode: "insensitive" } },
      { customerPhoneNorm: { contains: query, mode: "insensitive" } },
      { customerName: { contains: query, mode: "insensitive" } },
      { shopifyOrderName: { contains: query, mode: "insensitive" } },
    ];
  }

  // ── Step 3: Paginated customer groups — sorted server-side ──
  // "amount" sort falls back to count sort (cross-page amount sort requires full data; within-page re-sort happens post-enrichment)
  const groupOrderBy = sortBy === "recent"
    ? { _max: { createdAt: "desc" as const } }
    : { _count: { id: "desc" as const } };

  const [customerGroups, filteredGroupStats] = await Promise.all([
    prisma.returnCase.groupBy({
      by: ["customerEmailNorm"],
      where: searchWhere,
      _count: { id: true },
      _max: { createdAt: true },
      orderBy: groupOrderBy,
      skip: (page - 1) * CUSTOMERS_PAGE_SIZE,
      take: CUSTOMERS_PAGE_SIZE,
    }),
    prisma.returnCase.groupBy({
      by: ["customerEmailNorm"],
      where: searchWhere,
      _count: true,
    }),
  ]);

  const totalFilteredCustomers = filteredGroupStats.length;
  const totalPages = Math.max(1, Math.ceil(totalFilteredCustomers / CUSTOMERS_PAGE_SIZE));
  const emailsForPage = customerGroups.map((g) => g.customerEmailNorm).filter(Boolean) as string[];

  // ── Step 4: Fetch full return data ONLY for this page's customers ──
  const allReturns = emailsForPage.length > 0
    ? await prisma.returnCase.findMany({
        where: { shopId: shop.id, customerEmailNorm: { in: emailsForPage } },
        select: {
          id: true,
          returnRequestNo: true,
          shopifyOrderName: true,
          shopifyOrderId: true,
          customerEmailNorm: true,
          customerPhoneNorm: true,
          customerName: true,
          customerCity: true,
          customerCountry: true,
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
      })
    : [];

  // Group by email
  const grouped = new Map<string, {
    email: string;
    phone: string | null;
    name: string | null;
    city: string | null;
    country: string | null;
    orderIds: Set<string>;
    returns: typeof allReturns;
  }>();

  for (const r of allReturns) {
    const email = (r.customerEmailNorm || "").toLowerCase().trim();
    if (!email) continue;
    let group = grouped.get(email);
    if (!group) {
      group = {
        email,
        phone: r.customerPhoneNorm || null,
        name: r.customerName || null,
        city: r.customerCity || null,
        country: r.customerCountry || null,
        orderIds: new Set(),
        returns: [],
      };
      grouped.set(email, group);
    }
    if (!group.phone && r.customerPhoneNorm) group.phone = r.customerPhoneNorm;
    if (!group.name && r.customerName) group.name = r.customerName;
    if (!group.city && r.customerCity) group.city = r.customerCity;
    if (!group.country && r.customerCountry) group.country = r.customerCountry;
    if (r.shopifyOrderId) group.orderIds.add(r.shopifyOrderId);
    group.returns.push(r);
  }

  // Fetch real refund data + customer info from Shopify for each unique email
  const customerEmails = Array.from(grouped.keys());
  const shopifyDataByEmail = new Map<string, CustomerOrderInfo[]>();

  // Batch fetch — limit to 20 customers at a time to avoid timeout
  const emailBatches: string[][] = [];
  for (let i = 0; i < customerEmails.length; i += 20) {
    emailBatches.push(customerEmails.slice(i, i + 20));
  }

  for (const batch of emailBatches) {
    const results = await Promise.allSettled(
      batch.map((email) => fetchOrdersForCustomer(admin, email, 25))
    );
    for (let i = 0; i < batch.length; i++) {
      const res = results[i];
      if (res.status === "fulfilled" && res.value.length > 0) {
        shopifyDataByEmail.set(batch[i], res.value);
      }
    }
  }

  // Backfill missing customer data from Shopify into DB (fire-and-forget)
  const backfillUpdates: Array<{ id: string; data: Record<string, string | null> }> = [];

  // Build enriched customer summaries
  const customers: CustomerSummary[] = [];

  for (const [email, group] of grouped) {
    const shopifyOrders = shopifyDataByEmail.get(email) ?? [];

    // Build order refund map: orderName -> total refunded from Shopify
    const orderRefundMap = new Map<string, { refunded: number; currency: string; orderTotal: number }>();
    for (const o of shopifyOrders) {
      orderRefundMap.set(o.orderName, {
        refunded: o.totalRefundedAmount,
        currency: o.refundCurrency,
        orderTotal: o.totalOrderAmount,
      });
    }

    // Extract best customer info from Shopify data, then fallback to DB
    const firstOrder = shopifyOrders[0];
    const custName = firstOrder?.customerName || group.name || null;
    const custPhone = firstOrder?.customerPhone || group.phone || null;
    const custCity = firstOrder?.customerCity || group.city || null;
    const custCountry = firstOrder?.customerCountry || group.country || null;
    const lifetimeOrderCount = firstOrder?.lifetimeOrderCount ?? null;
    const lifetimeSpent = firstOrder?.lifetimeSpent ?? null;

    // Calculate total order value and refund amounts
    let totalOrderValue = 0;
    let totalRefundAmount = 0;
    // Aggregate version of the per-row amountIsEstimate flag.
    let totalRefundAmountIsEstimate = false;
    let currency = firstOrder?.refundCurrency || "";
    const statusBreakdown: Record<string, number> = {};
    const resolutionBreakdown: Record<string, number> = {};
    let totalItemCount = 0;
    let firstReturnDate = "";
    let lastReturnDate = "";
    const returnRows: ReturnRow[] = [];

    for (const r of group.returns) {
      // Get refund amount: prefer Shopify actual refund, fallback to DB refundJson
      const orderName = r.shopifyOrderName;
      const shopifyRefund = orderRefundMap.get(orderName);
      let refundAmount = 0;
      let refundCurrency = "";
      // Track whether the amount came from an authoritative source (Shopify refund
      // record or stored refundJson) or was estimated from item prices. Estimates
      // can drift from actual Shopify refunds (discounts, taxes, partial refunds);
      // we accumulate them separately so the per-customer total can flag
      // estimated rows in the UI (P1 finding from QA audit).
      let amountIsEstimate = false;

      if (shopifyRefund && shopifyRefund.refunded > 0) {
        refundAmount = shopifyRefund.refunded;
        refundCurrency = shopifyRefund.currency;
        totalOrderValue += shopifyRefund.orderTotal;
      } else {
        // Fallback to DB refundJson — these values were recorded at refund time.
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
        // Last-resort estimate: sum line-item list prices for refunded rows that
        // have no recorded amount. This is a best-effort and may differ from the
        // actual Shopify refund (line-item discounts / taxes / partial refunds
        // not captured here). Mark as provisional so the UI can label it.
        const isRefunded = ["completed", "refunded"].includes((r.status || "").toLowerCase())
          || (r.refundStatus || "").toLowerCase() === "refunded";
        if (refundAmount === 0 && isRefunded) {
          for (const item of r.items) {
            if (item.price) {
              refundAmount += (parseFloat(item.price) || 0) * item.qty;
            }
          }
          if (refundAmount > 0) amountIsEstimate = true;
        }
      }

      const itemCount = r.items.reduce((sum, it) => sum + it.qty, 0) || 0;
      const itemTitles = r.items.map((it) => it.title).filter(Boolean) as string[];

      totalRefundAmount += refundAmount;
      if (amountIsEstimate) totalRefundAmountIsEstimate = true;
      totalItemCount += itemCount;
      if (!currency && refundCurrency) currency = refundCurrency;

      const d = r.createdAt.toISOString();
      if (!firstReturnDate || d < firstReturnDate) firstReturnDate = d;
      if (!lastReturnDate || d > lastReturnDate) lastReturnDate = d;

      const normStatus = r.status.toLowerCase();
      statusBreakdown[normStatus] = (statusBreakdown[normStatus] || 0) + 1;
      if (r.resolutionType) {
        resolutionBreakdown[r.resolutionType] = (resolutionBreakdown[r.resolutionType] || 0) + 1;
      }

      returnRows.push({
        id: r.id,
        returnRequestNo: r.returnRequestNo,
        orderName: r.shopifyOrderName,
        status: r.status,
        resolutionType: r.resolutionType,
        refundAmount,
        refundCurrency,
        itemCount,
        itemTitles,
        createdAt: d,
        isGreenReturn: r.isGreenReturn,
      });
    }

    // Queue backfill for return cases missing customer data
    if (custPhone || custName || custCity || custCountry) {
      for (const r of group.returns) {
        const updates: Record<string, string | null> = {};
        if (!r.customerPhoneNorm && custPhone) updates.customerPhoneNorm = custPhone;
        if (!r.customerName && custName) updates.customerName = custName;
        if (!r.customerCity && custCity) updates.customerCity = custCity;
        if (!r.customerCountry && custCountry) updates.customerCountry = custCountry;
        if (Object.keys(updates).length > 0) {
          backfillUpdates.push({ id: r.id, data: updates });
        }
      }
    }

    customers.push({
      email,
      name: custName,
      phone: custPhone,
      city: custCity,
      country: custCountry,
      returnCount: group.returns.length,
      totalRefundAmount,
      totalRefundAmountIsEstimate,
      currency,
      totalItemCount,
      totalOrderValue,
      lifetimeOrderCount,
      lifetimeSpent,
      firstReturnDate,
      lastReturnDate,
      statusBreakdown,
      resolutionBreakdown,
      returns: returnRows,
    });
  }

  // Fire-and-forget: backfill missing customer data into DB.
  //
  // Logs failures (was previously a silent .catch(() => {}) at the outer level
  // that swallowed every error). Now per-row rejections are summarised to the
  // app logger so an admin watching telemetry can spot a chronic backfill
  // failure (e.g. a row that consistently violates a constraint).
  if (backfillUpdates.length > 0) {
    Promise.allSettled(
      backfillUpdates.slice(0, 100).map(({ id, data }) =>
        prisma.returnCase.update({ where: { id }, data })
      )
    ).then(async (results) => {
      const failures = results.filter((r) => r.status === "rejected");
      if (failures.length > 0) {
        try {
          const { appLogger } = await import("../lib/observability/logger.server");
          appLogger.warn(
            {
              module: "customers.backfill",
              shopId: shop.id,
              attempted: results.length,
              failed: failures.length,
              firstError: failures[0]?.status === "rejected"
                ? String((failures[0] as PromiseRejectedResult).reason).slice(0, 200)
                : null,
            },
            "Customer-data backfill had partial failures",
          );
        } catch { /* logging must never throw */ }
      }
    }).catch(() => { /* outer catch — defensive only */ });
  }

  if (sortBy === "amount") {
    customers.sort((a, b) => b.totalRefundAmount - a.totalRefundAmount);
  } else if (sortBy === "recent") {
    customers.sort((a, b) => new Date(b.lastReturnDate).getTime() - new Date(a.lastReturnDate).getTime());
  } else {
    customers.sort((a, b) => b.returnCount - a.returnCount);
  }

  return {
    customers,
    query,
    sortBy,
    totalCustomers,
    totalReturns: globalTotalReturns,
    totalRefunded,
    serialReturners,
    page,
    totalPages,
    totalFilteredCustomers,
    shopLocale: shop.settings?.shopLocale ?? "en",
    shopCurrency: customers[0]?.currency || shop.settings?.shopCurrency || "USD",
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
    return new Intl.DateTimeFormat(locale || "en", { dateStyle: "medium", timeStyle: "short" }).format(new Date(d));
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
    page, totalPages, totalFilteredCustomers,
    shopLocale, shopCurrency, shopTimezone,
  } = useLoaderData<typeof loader>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [expandedEmail, setExpandedEmail] = useState<string | null>(null);

  const goToPage = (p: number) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("page", String(p));
      return next;
    });
  };

  const handleSearch = (val: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      if (val.trim()) next.set("q", val.trim());
      else next.delete("q");
      next.delete("page"); // reset to page 1 on new search
      return next;
    });
  };

  const handleSort = (s: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("sort", s);
      next.delete("page"); // reset to page 1 on sort change
      return next;
    });
  };

  return (
    <s-page fullWidth heading="Customers">
      <div className="app-content layout-wide">
        {/* ── Summary Stats ── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 20 }}>
          {[
            { label: "Total Customers", value: String(totalCustomers), color: "#334155", bg: "#f8fafc", border: "#e2e8f0" },
            { label: "Total Returns", value: String(totalReturns), color: "#3b82f6", bg: "#eff6ff", border: "#bfdbfe" },
            { label: "Total Refunded", value: fmtMoney(totalRefunded, shopCurrency, shopLocale), color: "#7c3aed", bg: "#f5f3ff", border: "#ddd6fe" },
            { label: "Serial Returners", value: String(serialReturners), color: "#dc2626", bg: "#fef2f2", border: "#fecaca" },
          ].map((s) => (
            <div key={s.label} style={{ padding: "14px 16px", background: s.bg, borderRadius: 10, border: `1px solid ${s.border}`, textAlign: "center" }}>
              <div style={{ fontSize: s.label === "Total Refunded" ? 16 : 22, fontWeight: 800, color: s.color, lineHeight: 1.2, marginBottom: 4, fontVariantNumeric: "tabular-nums" }}>
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
              placeholder="Search by name, email, phone, or order..."
              defaultValue={query}
              aria-label="Search customers"
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
              {query
                ? `${totalFilteredCustomers} customer${totalFilteredCustomers !== 1 ? "s" : ""} matching "${query}" — page ${page} of ${totalPages}`
                : `Showing ${((page - 1) * CUSTOMERS_PAGE_SIZE) + 1}–${Math.min(page * CUSTOMERS_PAGE_SIZE, totalCustomers)} of ${totalCustomers} customers`}
            </div>

            <div style={{ background: "#fff", borderRadius: 12, border: "1px solid #e5e7eb", overflow: "hidden" }}>
              {/* Table Header */}
              <div style={{ display: "grid", gridTemplateColumns: "2fr 1.3fr 1fr 0.6fr 1fr 0.9fr 0.9fr", padding: "10px 20px", background: "#f9fafb", borderBottom: "1px solid #e5e7eb" }}>
                {["Customer", "Phone", "Location", "Returns", "Total Refunded", "First Return", "Last Return"].map((h) => (
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
                        gridTemplateColumns: "2fr 1.3fr 1fr 0.6fr 1fr 0.9fr 0.9fr",
                        padding: "14px 20px",
                        cursor: "pointer",
                        alignItems: "center",
                        transition: "background 0.1s",
                        background: isExpanded ? "#fafbff" : "transparent",
                      }}
                      onMouseEnter={(e) => { if (!isExpanded) (e.currentTarget as HTMLDivElement).style.background = "#fafbfc"; }}
                      onMouseLeave={(e) => { if (!isExpanded) (e.currentTarget as HTMLDivElement).style.background = "transparent"; }}
                    >
                      {/* Customer Name + Email */}
                      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#9ca3af" strokeWidth="2" style={{ flexShrink: 0, transform: isExpanded ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 0.15s" }}>
                          <polyline points="9 18 15 12 9 6"/>
                        </svg>
                        <div style={{ minWidth: 0, overflow: "hidden" }}>
                          {cust.name && (
                            <div style={{ fontSize: 13, fontWeight: 700, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {cust.name}
                            </div>
                          )}
                          <div style={{ fontSize: cust.name ? 11 : 13, fontWeight: cust.name ? 500 : 600, color: cust.name ? "#6b7280" : "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {cust.email}
                          </div>
                        </div>
                        {isSerial && (
                          <span style={{ fontSize: 9, fontWeight: 700, padding: "2px 7px", borderRadius: 999, background: "#FEE2E2", color: "#DC2626", textTransform: "uppercase", letterSpacing: "0.03em", flexShrink: 0 }}>
                            Serial
                          </span>
                        )}
                      </div>

                      {/* Phone */}
                      <div style={{ fontSize: 13, color: cust.phone ? "#374151" : "#d1d5db", fontVariantNumeric: "tabular-nums" }}>
                        {cust.phone || "Not provided"}
                      </div>

                      {/* Location */}
                      <div style={{ fontSize: 12, color: cust.city || cust.country ? "#374151" : "#d1d5db", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {cust.city && cust.country ? `${cust.city}, ${cust.country}` : cust.country || cust.city || "—"}
                      </div>

                      {/* Returns count */}
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#111827", fontVariantNumeric: "tabular-nums" }}>
                        {cust.returnCount}
                      </div>

                      {/* Total Refunded — `~` prefix when at least one row in the
                          total was estimated from line-item list prices instead of
                          a real Shopify refund record (see app.customers.tsx:289). */}
                      <div
                        style={{ fontSize: 13, fontWeight: 600, color: cust.totalRefundAmount > 0 ? "#111827" : "#9ca3af", fontVariantNumeric: "tabular-nums" }}
                        title={cust.totalRefundAmountIsEstimate ? "At least one refund amount is estimated from line-item prices and may differ from the actual Shopify refund." : undefined}
                      >
                        {cust.totalRefundAmountIsEstimate ? "~" : ""}{fmtMoney(cust.totalRefundAmount, cust.currency || shopCurrency, shopLocale)}
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
                        {/* Customer Profile Card */}
                        <div style={{ display: "flex", gap: 20, flexWrap: "wrap", marginTop: 16, marginBottom: 16 }}>
                          {/* Left: Customer Info */}
                          <div style={{ flex: "1 1 280px", padding: "14px 18px", background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb" }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 10 }}>
                              Customer Profile
                            </div>
                            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 16px", fontSize: 12 }}>
                              <div>
                                <span style={{ color: "#9ca3af", fontWeight: 500 }}>Name</span>
                                <div style={{ fontWeight: 600, color: "#111827", marginTop: 1 }}>{cust.name || "—"}</div>
                              </div>
                              <div>
                                <span style={{ color: "#9ca3af", fontWeight: 500 }}>Email</span>
                                <div style={{ fontWeight: 600, color: "#111827", marginTop: 1, overflow: "hidden", textOverflow: "ellipsis" }}>{cust.email}</div>
                              </div>
                              <div>
                                <span style={{ color: "#9ca3af", fontWeight: 500 }}>Phone</span>
                                <div style={{ fontWeight: 600, color: cust.phone ? "#111827" : "#d1d5db", marginTop: 1 }}>{cust.phone || "Not provided"}</div>
                              </div>
                              <div>
                                <span style={{ color: "#9ca3af", fontWeight: 500 }}>Location</span>
                                <div style={{ fontWeight: 600, color: "#111827", marginTop: 1 }}>
                                  {cust.city && cust.country ? `${cust.city}, ${cust.country}` : cust.country || cust.city || "—"}
                                </div>
                              </div>
                              {cust.lifetimeOrderCount != null && (
                                <div>
                                  <span style={{ color: "#9ca3af", fontWeight: 500 }}>Lifetime Orders</span>
                                  <div style={{ fontWeight: 600, color: "#111827", marginTop: 1 }}>{cust.lifetimeOrderCount}</div>
                                </div>
                              )}
                              {cust.lifetimeSpent != null && (
                                <div>
                                  <span style={{ color: "#9ca3af", fontWeight: 500 }}>Lifetime Spent</span>
                                  <div style={{ fontWeight: 600, color: "#111827", marginTop: 1 }}>{fmtMoney(cust.lifetimeSpent, cust.currency || shopCurrency, shopLocale)}</div>
                                </div>
                              )}
                            </div>
                          </div>

                          {/* Right: Return Stats */}
                          <div style={{ flex: "1 1 280px", padding: "14px 18px", background: "#fff", borderRadius: 10, border: "1px solid #e5e7eb" }}>
                            <div style={{ fontSize: 11, fontWeight: 700, color: "#6b7280", textTransform: "uppercase", letterSpacing: "0.04em", marginBottom: 10 }}>
                              Return Analytics
                            </div>
                            <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                              <MiniStat label="Returns" value={String(cust.returnCount)} color="#3b82f6" />
                              <MiniStat label="Items" value={String(cust.totalItemCount)} color="#6b7280" />
                              <MiniStat label="Refunded" value={fmtMoney(cust.totalRefundAmount, cust.currency || shopCurrency, shopLocale)} color="#7c3aed" />
                              {cust.totalOrderValue > 0 && (
                                <MiniStat label="Order Value" value={fmtMoney(cust.totalOrderValue, cust.currency || shopCurrency, shopLocale)} color="#059669" />
                              )}
                              {cust.totalOrderValue > 0 && cust.totalRefundAmount > 0 && (
                                <MiniStat
                                  label="Return Rate"
                                  value={`${Math.min(100, Math.round((cust.totalRefundAmount / cust.totalOrderValue) * 100))}%`}
                                  color={cust.totalRefundAmount / cust.totalOrderValue > 0.5 ? "#dc2626" : "#f59e0b"}
                                />
                              )}
                              {Object.entries(cust.resolutionBreakdown).map(([res, count]) => (
                                <MiniStat key={res} label={RESOLUTION_LABELS[res] || res} value={String(count)} color={(RESOLUTION_STYLES[res] || { color: "#6b7280" }).color} />
                              ))}
                            </div>
                          </div>
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
                                  {r.resolutionType && r.resolutionType !== "refund" && (
                                    <span style={{
                                      fontSize: 9, fontWeight: 700, padding: "1px 6px", borderRadius: 4, textTransform: "uppercase",
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

            {/* ── Pagination ── */}
            {totalPages > 1 && (
              <div className="returns-pagination" style={{ marginTop: 16 }}>
                <button
                  className="app-pagination-btn"
                  disabled={page <= 1}
                  onClick={() => goToPage(page - 1)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="15 18 9 12 15 6"/></svg>
                </button>
                {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                  let p: number;
                  if (totalPages <= 7) p = i + 1;
                  else if (page <= 4) p = i + 1;
                  else if (page >= totalPages - 3) p = totalPages - 6 + i;
                  else p = page - 3 + i;
                  return (
                    <button
                      key={p}
                      className={`app-pagination-btn ${p === page ? "active" : ""}`}
                      onClick={() => goToPage(p)}
                    >
                      {p}
                    </button>
                  );
                })}
                <button
                  className="app-pagination-btn"
                  disabled={page >= totalPages}
                  onClick={() => goToPage(page + 1)}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="9 18 15 12 9 6"/></svg>
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </s-page>
  );
}

function MiniStat({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div style={{ padding: "8px 14px", background: "#f9fafb", borderRadius: 8, border: "1px solid #e5e7eb", minWidth: 70 }}>
      <div style={{ fontSize: 15, fontWeight: 800, color, lineHeight: 1.2, fontVariantNumeric: "tabular-nums" }}>{value}</div>
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
    <s-page fullWidth heading="Customers">
      <div className="app-content layout-wide">
        <div className="app-alert app-alert-error" style={{ marginBottom: 20 }}>
          <p style={{ fontWeight: 600, fontSize: 14 }}>{msg}</p>
          <Link to="/app/customers" style={{ fontSize: 13, fontWeight: 600, color: "#005bd3", textDecoration: "none" }}>Try again</Link>
        </div>
      </div>
    </s-page>
  );
}
