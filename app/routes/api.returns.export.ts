import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { parseDateRange } from "../lib/dashboard-date-utils";

export const loader = async ({ request }: LoaderFunctionArgs) => {
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

  const returns = await prisma.returnCase.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 5000,
  });

  const escape = (v: string | null | undefined) => {
    if (v == null) return "";
    const s = String(v);
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };

  const headers = [
    "Return Request ID",
    "Order",
    "Return #",
    "Forward AWB",
    "Return AWB",
    "Status",
    "Customer Email",
    "Refund Status",
    "Created",
  ];
  const formatReturnRequestId = (id: string) => {
    if (!id || id.length < 8) return id;
    return `RPM-${id.slice(-8).toUpperCase().replace(/[^A-Z0-9]/g, "X")}`;
  };
  const rows = returns.map((r) => [
    escape((r as { returnRequestNo?: string | null }).returnRequestNo ?? formatReturnRequestId(r.id)),
    escape(r.shopifyOrderName),
    escape(r.fyndReturnNo),
    escape(r.forwardAwb),
    escape(r.returnAwb),
    escape(r.status),
    escape(r.customerEmailNorm),
    escape(r.refundStatus),
    escape(r.createdAt ? new Date(r.createdAt).toISOString() : ""),
  ]);

  const csv = [headers.join(","), ...rows.map((row) => row.join(","))].join("\n");
  const filename = `returns-export-${new Date().toISOString().slice(0, 10)}.csv`;

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
};
