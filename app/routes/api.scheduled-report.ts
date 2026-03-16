/**
 * Scheduled Report Email Endpoint
 *
 * Triggered by external cron to send periodic report emails.
 * GET /api/scheduled-report — processes all shops with scheduled reports enabled.
 */
import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import nodemailer from "nodemailer";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  // Simple auth: only allow from cron with secret header or localhost
  const authHeader = request.headers.get("x-cron-secret");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== cronSecret) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const now = new Date();
  const dayOfWeek = now.getDay() === 0 ? 7 : now.getDay(); // 1=Mon, 7=Sun
  const dayOfMonth = now.getDate();

  // Find all shops with scheduled reports enabled
  const settings = await prisma.shopSettings.findMany({
    where: { scheduledReportEnabled: true },
    include: { shop: true },
  });

  const results: { shop: string; sent: boolean; error?: string }[] = [];

  for (const s of settings) {
    try {
      // Check frequency
      if (s.scheduledReportFrequency === "daily") {
        // Always send
      } else if (s.scheduledReportFrequency === "weekly") {
        if (dayOfWeek !== (s.scheduledReportDay || 1)) continue;
      } else if (s.scheduledReportFrequency === "monthly") {
        if (dayOfMonth !== (s.scheduledReportDay || 1)) continue;
      } else {
        continue;
      }

      const recipients = (s.scheduledReportEmails || "")
        .split(",")
        .map((e: string) => e.trim())
        .filter(Boolean);
      if (recipients.length === 0 && s.adminNotifyEmail) {
        recipients.push(s.adminNotifyEmail);
      }
      if (recipients.length === 0) {
        results.push({ shop: s.shop.shopDomain, sent: false, error: "No recipients" });
        continue;
      }

      // Compute report period
      const periodEnd = new Date(now);
      const periodStart = new Date(now);
      if (s.scheduledReportFrequency === "daily") {
        periodStart.setDate(periodStart.getDate() - 1);
      } else if (s.scheduledReportFrequency === "weekly") {
        periodStart.setDate(periodStart.getDate() - 7);
      } else {
        periodStart.setMonth(periodStart.getMonth() - 1);
      }

      const where = { shopId: s.shopId, createdAt: { gte: periodStart, lte: periodEnd } };

      const [totalReturns, statusAgg, resAgg, refundedCases] = await Promise.all([
        prisma.returnCase.count({ where }),
        prisma.returnCase.groupBy({ by: ["status"], where, _count: true }),
        prisma.returnCase.groupBy({ by: ["resolutionType"], where, _count: true }),
        prisma.returnCase.findMany({
          where: { ...where, refundJson: { not: null } },
          select: { refundJson: true, resolutionType: true },
        }),
      ]);

      const statusMap = statusAgg.reduce((a, x) => ({ ...a, [x.status]: x._count }), {} as Record<string, number>);
      const resMap = resAgg.reduce((a, x) => ({ ...a, [x.resolutionType]: x._count }), {} as Record<string, number>);
      const approvedCount = (statusMap.approved ?? 0) + (statusMap.completed ?? 0);
      const approvalRate = totalReturns > 0 ? Math.round((approvedCount / totalReturns) * 100) : 0;

      let totalRefundAmt = 0;
      let revenueRetained = 0;
      for (const rc of refundedCases) {
        try {
          const parsed = JSON.parse(rc.refundJson ?? "{}");
          const amt = parseFloat(parsed.amount ?? "0");
          if (Number.isFinite(amt) && amt > 0) {
            if (rc.resolutionType === "exchange" || rc.resolutionType === "store_credit") {
              revenueRetained += amt;
            } else {
              totalRefundAmt += amt;
            }
          }
        } catch { /* skip */ }
      }

      const resolvedCount = (resMap.refund ?? 0) + (resMap.exchange ?? 0) + (resMap.store_credit ?? 0) + (resMap.replacement ?? 0);
      const exchangeConv = resolvedCount > 0 ? Math.round(((resMap.exchange ?? 0) / resolvedCount) * 100) : 0;

      const currency = s.shopCurrency || "USD";
      const locale = s.shopLocale || "en";
      const fmt = (v: number) => new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(v);

      const periodLabel = s.scheduledReportFrequency === "daily" ? "Yesterday"
        : s.scheduledReportFrequency === "weekly" ? "Last 7 days" : "Last month";

      const html = `
<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1e293b;max-width:600px;margin:0 auto;padding:24px">
  <h2 style="margin:0 0 4px;font-size:20px">Returns Report — ${periodLabel}</h2>
  <p style="color:#64748b;font-size:13px;margin:0 0 24px">${s.shop.shopDomain} · ${periodStart.toLocaleDateString()} – ${periodEnd.toLocaleDateString()}</p>
  <table style="width:100%;border-collapse:collapse;margin-bottom:24px">
    <tr>
      <td style="padding:16px;background:#f8fafc;border-radius:8px;text-align:center;width:25%">
        <div style="font-size:28px;font-weight:700;color:#3b82f6">${totalReturns}</div>
        <div style="font-size:12px;color:#64748b;margin-top:4px">Total Returns</div>
      </td>
      <td style="width:8px"></td>
      <td style="padding:16px;background:#f8fafc;border-radius:8px;text-align:center;width:25%">
        <div style="font-size:28px;font-weight:700;color:#10b981">${approvalRate}%</div>
        <div style="font-size:12px;color:#64748b;margin-top:4px">Approval Rate</div>
      </td>
      <td style="width:8px"></td>
      <td style="padding:16px;background:#f8fafc;border-radius:8px;text-align:center;width:25%">
        <div style="font-size:28px;font-weight:700;color:#14b8a6">${exchangeConv}%</div>
        <div style="font-size:12px;color:#64748b;margin-top:4px">Exchange Rate</div>
      </td>
      <td style="width:8px"></td>
      <td style="padding:16px;background:#f8fafc;border-radius:8px;text-align:center;width:25%">
        <div style="font-size:28px;font-weight:700;color:#059669">${fmt(revenueRetained)}</div>
        <div style="font-size:12px;color:#64748b;margin-top:4px">Revenue Retained</div>
      </td>
    </tr>
  </table>
  <h3 style="font-size:14px;margin:0 0 8px">Status Breakdown</h3>
  <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:24px">
    <tr style="border-bottom:2px solid #e2e8f0">
      <th style="text-align:left;padding:8px;font-size:11px;color:#64748b;text-transform:uppercase">Status</th>
      <th style="text-align:right;padding:8px;font-size:11px;color:#64748b;text-transform:uppercase">Count</th>
    </tr>
    ${Object.entries(statusMap).sort(([,a],[,b]) => b - a).map(([status, count]) => `
    <tr style="border-bottom:1px solid #f1f5f9">
      <td style="padding:8px;text-transform:capitalize">${status}</td>
      <td style="padding:8px;text-align:right;font-weight:700">${count}</td>
    </tr>`).join("")}
  </table>
  <h3 style="font-size:14px;margin:0 0 8px">Resolution Breakdown</h3>
  <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:24px">
    ${Object.entries(resMap).sort(([,a],[,b]) => b - a).map(([res, count]) => `
    <tr style="border-bottom:1px solid #f1f5f9">
      <td style="padding:8px;text-transform:capitalize">${res.replace(/_/g, " ")}</td>
      <td style="padding:8px;text-align:right;font-weight:700">${count}</td>
    </tr>`).join("")}
  </table>
  <h3 style="font-size:14px;margin:0 0 8px">Revenue</h3>
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <tr style="border-bottom:1px solid #f1f5f9">
      <td style="padding:8px">Total Refunds Issued</td>
      <td style="padding:8px;text-align:right;font-weight:700;color:#dc2626">${fmt(totalRefundAmt)}</td>
    </tr>
    <tr>
      <td style="padding:8px">Revenue Retained (Exchange/Credit)</td>
      <td style="padding:8px;text-align:right;font-weight:700;color:#059669">${fmt(revenueRetained)}</td>
    </tr>
  </table>
  <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0">
  <p style="font-size:11px;color:#94a3b8;text-align:center">
    Sent by ReturnProMax · ${s.scheduledReportFrequency} report · <a href="https://${s.shop.shopDomain}/admin/apps/returns/app/settings" style="color:#3b82f6">Manage settings</a>
  </p>
</body></html>`;

      // Send email using shop's SMTP settings
      if (!s.smtpHost || !s.smtpUser) {
        results.push({ shop: s.shop.shopDomain, sent: false, error: "SMTP not configured" });
        continue;
      }

      const transporter = nodemailer.createTransport({
        host: s.smtpHost,
        port: s.smtpPort ?? 587,
        secure: s.smtpSecure ?? false,
        auth: { user: s.smtpUser, pass: s.smtpPass ?? "" },
      });

      await transporter.sendMail({
        from: s.smtpFromEmail ? `${s.smtpFromName || "ReturnProMax"} <${s.smtpFromEmail}>` : s.smtpUser,
        to: recipients.join(", "),
        subject: `Returns Report — ${periodLabel} (${s.shop.shopDomain})`,
        html,
      });

      results.push({ shop: s.shop.shopDomain, sent: true });
    } catch (err) {
      results.push({ shop: s.shop.shopDomain, sent: false, error: String(err) });
    }
  }

  return Response.json({ processed: results.length, results });
};
