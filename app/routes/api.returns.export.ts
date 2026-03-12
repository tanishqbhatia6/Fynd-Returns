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
    const range = url.searchParams.get("range") || "last_30_days";
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");

    let shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
    if (!shop) {
      shop = await prisma.shop.create({ data: { shopDomain: session.shop } });
    }

    const { start: rangeStart, end: rangeEnd } = parseDateRange(range, from, to);

    const where: Record<string, unknown> = {
      shopId: shop.id,
      createdAt: { gte: rangeStart, lte: rangeEnd },
    };
    if (status) where.status = status;
    if (query.trim()) {
      where.OR = [
        { shopifyOrderName: { contains: query.trim(), mode: "insensitive" } },
        { forwardAwb: { contains: query.trim(), mode: "insensitive" } },
        { returnAwb: { contains: query.trim(), mode: "insensitive" } },
        { fyndReturnNo: { contains: query.trim(), mode: "insensitive" } },
        { customerEmailNorm: { contains: query.trim(), mode: "insensitive" } },
        { customerPhoneNorm: { contains: query.trim(), mode: "insensitive" } },
      ];
    }

    const MAX_EXPORT_ROWS = 10000;
    const count = await prisma.returnCase.count({ where });
    if (count > MAX_EXPORT_ROWS) {
      return new Response(
        `Export limit exceeded. Found ${count} rows (max ${MAX_EXPORT_ROWS}). Please narrow your date range or filters.`,
        { status: 400, headers: { "Content-Type": "text/plain" } }
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

    type ReturnCaseWithRelations = typeof returns[0];

    const parseRefundJson = (rc: ReturnCaseWithRelations) => {
      try {
        if (!rc.refundJson) return { method: null, amount: null, currency: null, date: null };
        const j = JSON.parse(rc.refundJson) as { method?: string; amount?: string | number; currency?: string; createdAt?: string };
        return {
          method: j.method ?? null,
          amount: j.amount != null ? String(j.amount) : null,
          currency: j.currency ?? null,
          date: j.createdAt ?? null,
        };
      } catch { return { method: null, amount: null, currency: null, date: null }; }
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
        escape(rc.customerName),
        escape(rc.customerEmailNorm),
        escape(rc.customerPhoneNorm),
        escape(rc.customerCity),
        escape(rc.customerCountry),
        escape(rcTyped.customerAddress1),
        escape(rcTyped.customerAddress2),
        escape(rcTyped.customerProvince),
        escape(rcTyped.customerZip),
        escape(rcTyped.customerLandmark),
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

    const csv = [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");
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
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
};
