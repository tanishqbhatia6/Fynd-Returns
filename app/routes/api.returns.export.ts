import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { parseDateRange } from "../lib/dashboard-date-utils";
import { formatReturnRequestId } from "../lib/return-request-id";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  try {
    const { session } = await authenticate.admin(request);
    const url = new URL(request.url);
    const status = url.searchParams.get("status") || "";
    const query = url.searchParams.get("query") || "";
    const range = url.searchParams.get("range") || "";
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const resolutionType = url.searchParams.get("resolutionType") || "";
    const sourceChannel = url.searchParams.get("sourceChannel") || "";
    // Optional `?anonymize=true` — replaces customer name/email/phone/address with
    // a stable hash. Useful when the merchant wants to share the export with an
    // external accountant or analyst without leaking PII (P2 finding from QA audit).
    const anonymize = url.searchParams.get("anonymize") === "true";

    let shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
    if (!shop) {
      shop = await prisma.shop.create({ data: { shopDomain: session.shop } });
    }

    const where: Record<string, unknown> = {
      shopId: shop.id,
    };
    if (range) {
      const { start: rangeStart, end: rangeEnd } = parseDateRange(range, from, to);
      where.createdAt = { gte: rangeStart, lte: rangeEnd };
    } else if (from || to) {
      const createdAt: Record<string, Date> = {};
      if (from) createdAt.gte = new Date(`${from}T00:00:00`);
      if (to) createdAt.lte = new Date(`${to}T23:59:59.999`);
      where.createdAt = createdAt;
    }
    if (status) {
      const list = status
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      where.status = list.length > 1 ? { in: list } : list[0];
    }
    if (resolutionType) where.resolutionType = resolutionType;
    if (sourceChannel) where.sourceChannel = sourceChannel === "web" ? null : sourceChannel;
    if (query.trim()) {
      const q = query.trim();
      where.OR = [
        { shopifyOrderName: { contains: q, mode: "insensitive" } },
        { returnRequestNo: { contains: q, mode: "insensitive" } },
        { fyndOrderId: { contains: q, mode: "insensitive" } },
        { forwardAwb: { contains: q, mode: "insensitive" } },
        { returnAwb: { contains: q, mode: "insensitive" } },
        { fyndReturnNo: { contains: q, mode: "insensitive" } },
        { customerEmailNorm: { contains: q, mode: "insensitive" } },
        { customerPhoneNorm: { contains: q, mode: "insensitive" } },
      ];
    }

    const MAX_EXPORT_ROWS = 10000;
    const count = await prisma.returnCase.count({ where });
    if (count > MAX_EXPORT_ROWS) {
      return new Response(
        `Export limit exceeded. Found ${count} rows (max ${MAX_EXPORT_ROWS}). Please narrow your date range or filters.`,
        { status: 400, headers: { "Content-Type": "text/plain" } },
      );
    }

    const returns = await prisma.returnCase.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: MAX_EXPORT_ROWS,
      include: { items: true, events: { orderBy: { happenedAt: "asc" } } },
    });

    const escape = (v: string | null | undefined) => {
      if (v == null) return "";
      const s = String(v);
      return s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };

    // Anonymization helpers — hash to a short stable token so per-customer
    // grouping in spreadsheets still works, but the underlying value is opaque.
    const cryptoLib = await import("node:crypto");
    const hashToken = (v: string | null | undefined): string => {
      if (!v) return "";
      const h = cryptoLib.createHash("sha256").update(v.trim().toLowerCase()).digest("hex");
      return `anon:${h.slice(0, 12)}`;
    };
    const piiSafe = (v: string | null | undefined): string =>
      anonymize ? escape(hashToken(v)) : escape(v);
    const addressSafe = (v: string | null | undefined): string => (anonymize ? "" : escape(v));

    const formatId = (r: { returnRequestNo?: string | null; id: string }) =>
      r.returnRequestNo || formatReturnRequestId(r.id);

    const headers = [
      "Return Request ID",
      "Order",
      "Status",
      "Resolution Type",
      "Customer Name",
      "Customer Email",
      "Customer Phone",
      "Customer City",
      "Customer Country",
      "Customer Address 1",
      "Customer Address 2",
      "Customer Province",
      "Customer Zip",
      "Customer Landmark",
      "Fynd Return #",
      "Fynd Return ID",
      "Fynd Shipment ID",
      "Return AWB",
      "Forward AWB",
      "Refund Status",
      "Refund Method",
      "Refund Amount",
      "Refund Currency",
      "Refund Date",
      "Approved At",
      "Created At",
      "Updated At",
      "Item SKU",
      "Item Title",
      "Item Qty",
      "Item Price",
      "Item Condition",
      "Item Reason Code",
    ];

    type ReturnCaseWithRelations = (typeof returns)[0];

    const parseRefundJson = (rc: ReturnCaseWithRelations) => {
      try {
        if (!rc.refundJson) return { method: null, amount: null, currency: null, date: null };
        const j = JSON.parse(rc.refundJson) as {
          method?: string;
          amount?: string | number;
          currency?: string;
          createdAt?: string;
        };
        return {
          method: j.method ?? null,
          amount: j.amount != null ? String(j.amount) : null,
          currency: j.currency ?? null,
          date: j.createdAt ?? null,
        };
      } catch {
        return { method: null, amount: null, currency: null, date: null };
      }
    };

    const getEventTimestamp = (rc: ReturnCaseWithRelations, eventType: string): string | null => {
      const ev = rc.events.find((e) => e.eventType === eventType);
      return ev?.happenedAt ? new Date(ev.happenedAt).toISOString() : null;
    };

    const rows: string[][] = [];

    for (const rc of returns) {
      const refund = parseRefundJson(rc);
      const approvedAt = getEventTimestamp(rc, "approved");
      const rcTyped = rc;

      const caseFields = [
        escape(formatId(rcTyped)),
        escape(rc.shopifyOrderName),
        escape(rc.status),
        escape(rc.resolutionType),
        // Customer name / contact get hashed to a stable opaque token in
        // anonymize mode; address parts are blanked entirely.
        piiSafe(rc.customerName),
        piiSafe(rc.customerEmailNorm),
        piiSafe(rc.customerPhoneNorm),
        anonymize ? "" : escape(rc.customerCity),
        // Country is generally fine to leak (low specificity); keep it for analytics.
        escape(rc.customerCountry),
        addressSafe(rcTyped.customerAddress1),
        addressSafe(rcTyped.customerAddress2),
        addressSafe(rcTyped.customerProvince),
        addressSafe(rcTyped.customerZip),
        addressSafe(rcTyped.customerLandmark),
        escape(rc.fyndReturnNo),
        escape(rc.fyndReturnId),
        escape(rcTyped.fyndShipmentId),
        escape(rc.returnAwb),
        escape(rc.forwardAwb),
        escape(rc.refundStatus),
        escape(refund.method),
        escape(refund.amount),
        escape(refund.currency),
        escape(refund.date),
        escape(approvedAt),
        escape(rc.createdAt ? new Date(rc.createdAt).toISOString() : ""),
        escape(rc.updatedAt ? new Date(rc.updatedAt).toISOString() : ""),
      ];

      if (rc.items.length === 0) {
        rows.push([...caseFields, "", "", "", "", "", ""]);
      } else {
        for (const item of rc.items) {
          rows.push([
            ...caseFields,
            escape(item.sku),
            escape(item.title),
            escape(String(item.qty)),
            escape(item.price),
            escape(item.condition),
            escape(item.reasonCode),
          ]);
        }
      }
    }

    // CRLF line terminator is RFC 4180 compliant and Excel-friendly. UTF-8 BOM
    // prefix lets Excel auto-detect encoding for non-ASCII customer data
    // (Japanese, Indian addresses, etc.) — without it Excel mangles them.
    const csv = "\uFEFF" + [headers.join(","), ...rows.map((row) => row.join(","))].join("\r\n");
    const filename = `returns-export-${new Date().toISOString().slice(0, 10)}.csv`;

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (err) {
    console.error("[api.returns.export] Loader error:", err);
    return new Response(
      JSON.stringify({ error: "Failed to export returns. Please try again later." }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
};
