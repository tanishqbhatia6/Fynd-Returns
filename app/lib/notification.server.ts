import nodemailer from "nodemailer";
import prisma from "../db.server";
import { getPortalLabels, t } from "./portal-i18n";
import { formatMoney, isRtlLocale } from "./i18n.server";
import { notifLogger } from "./observability/logger.server";
import { withSpan, addBusinessEvent } from "./observability/tracing.server";

/* ── Types ── */
type SmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  fromEmail: string;
  fromName: string;
};

type NotifToggles = {
  notificationNewReturn: boolean;
  notificationApproved: boolean;
  notificationRejected: boolean;
  notificationRefunded: boolean;
  notificationCancelled: boolean;
};

type SendResult = { success: boolean; error?: string };

/* ── SMTP Transport ── */
function createTransport(cfg: SmtpConfig) {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
}

type CustomEmailTemplate = { subject: string; bodyHtml: string };
type EmailTemplatesMap = Record<string, CustomEmailTemplate>;

type ShopI18n = { locale: string; currency: string; timezone: string };

async function getSmtpConfig(shopDomain: string): Promise<{
  smtp: SmtpConfig | null;
  toggles: NotifToggles;
  adminEmail: string | null;
  emailTemplates: EmailTemplatesMap;
  i18n: ShopI18n;
}> {
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    include: { settings: true },
  });
  const s = shop?.settings;

  let emailTemplates: EmailTemplatesMap = {};
  if (s?.emailTemplatesJson) {
    try { emailTemplates = JSON.parse(s.emailTemplatesJson); } catch { /* invalid JSON */ }
  }

  const i18n: ShopI18n = {
    locale: s?.portalLanguage || s?.shopLocale || "en",
    currency: s?.shopCurrency || "USD",
    timezone: s?.shopTimezone || "UTC",
  };

  if (!s?.smtpHost || !s?.smtpUser || !s?.smtpPass) {
    return {
      smtp: null,
      toggles: {
        notificationNewReturn: s?.notificationNewReturn ?? true,
        notificationApproved: s?.notificationApproved ?? true,
        notificationRejected: s?.notificationRejected ?? true,
        notificationRefunded: s?.notificationRefunded ?? true,
        notificationCancelled: (s as Record<string, unknown> | null)?.notificationCancelled as boolean ?? true,
      },
      adminEmail: s?.adminNotifyEmail ?? null,
      emailTemplates,
      i18n,
    };
  }
  return {
    smtp: {
      host: s.smtpHost,
      port: s.smtpPort ?? 587,
      secure: s.smtpSecure ?? false,
      user: s.smtpUser,
      pass: s.smtpPass,
      fromEmail: s.smtpFromEmail || s.smtpUser,
      fromName: s.smtpFromName || "Fynd Returns",
    },
    toggles: {
      notificationNewReturn: s.notificationNewReturn,
      notificationApproved: s.notificationApproved,
      notificationRejected: s.notificationRejected,
      notificationRefunded: s.notificationRefunded ?? true,
      notificationCancelled: (s as Record<string, unknown>).notificationCancelled as boolean ?? true,
    },
    adminEmail: s.adminNotifyEmail ?? null,
    emailTemplates,
    i18n,
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function replaceTemplateVars(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => escapeHtml(vars[key] ?? ""));
}

async function sendEmail(smtp: SmtpConfig, to: string, subject: string, html: string): Promise<SendResult> {
  try {
    const transport = createTransport(smtp);
    await transport.sendMail({
      from: `"${smtp.fromName}" <${smtp.fromEmail}>`,
      to,
      subject,
      html,
    });
    return { success: true };
  } catch (err) {
    notifLogger.error({ err, recipient: to, subject }, "Email send failed");
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ── HTML Template Builder ── */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function emailLayout(title: string, accentColor: string, body: string, shopName?: string, locale?: string, labels?: Record<string, string>): string {
  const lang = locale || "en";
  const dir = isRtlLocale(lang) ? ' dir="rtl"' : "";
  const poweredBy = labels?.["email.footer.poweredBy"] ?? "Powered by Fynd Returns";
  return `<!DOCTYPE html>
<html lang="${esc(lang)}"${dir}>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:32px 16px">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,0.08)">
  <tr><td style="height:4px;background:${accentColor}"></td></tr>
  <tr><td style="padding:32px 36px 28px">
    ${body}
  </td></tr>
  <tr><td style="padding:0 36px 28px">
    <div style="border-top:1px solid #e5e7eb;padding-top:16px;font-size:12px;color:#94a3b8;line-height:1.6">
      ${shopName ? `<p style="margin:0">${esc(shopName)}</p>` : ""}
      <p style="margin:4px 0 0">${esc(poweredBy)}</p>
    </div>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/* ── Email Templates ── */

function newReturnEmail(p: { orderName: string; returnId: string; customerEmail?: string; itemCount: number }, labels: Record<string, string>, locale: string): { subject: string; html: string } {
  const subject = t("email.newReturn.subject", labels, { id: p.returnId, order: p.orderName });
  const heading = t("email.newReturn.heading", labels);
  const bodyText = t("email.newReturn.body", labels);
  const reqIdLabel = t("email.newReturn.requestId", labels);
  const orderLabel = t("portal.order.orderDetails", labels) || "Order";
  const customerLabel = t("email.newReturn.customer", labels);
  const itemsLabel = t("portal.order.items", labels) || "Items";
  const cta = t("email.newReturn.cta", labels);
  const body = `
    <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#0f172a">${esc(heading)}</h1>
    <p style="margin:0 0 20px;font-size:15px;color:#475569;line-height:1.7">${esc(bodyText)}</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;margin:0 0 20px">
      <tr><td style="padding:18px 22px">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:4px 0;font-size:14px;color:#92400e"><strong>${esc(reqIdLabel)}:</strong></td><td style="padding:4px 0;font-size:14px;color:#92400e;text-align:right;font-family:monospace">${esc(p.returnId)}</td></tr>
          <tr><td style="padding:4px 0;font-size:14px;color:#92400e"><strong>${esc(orderLabel)}:</strong></td><td style="padding:4px 0;font-size:14px;color:#92400e;text-align:right">${esc(p.orderName)}</td></tr>
          ${p.customerEmail ? `<tr><td style="padding:4px 0;font-size:14px;color:#92400e"><strong>${esc(customerLabel)}:</strong></td><td style="padding:4px 0;font-size:14px;color:#92400e;text-align:right">${esc(p.customerEmail)}</td></tr>` : ""}
          <tr><td style="padding:4px 0;font-size:14px;color:#92400e"><strong>${esc(itemsLabel)}:</strong></td><td style="padding:4px 0;font-size:14px;color:#92400e;text-align:right">${p.itemCount}</td></tr>
        </table>
      </td></tr>
    </table>
    <p style="margin:0;font-size:14px;color:#64748b">${esc(cta)}</p>`;
  return { subject, html: emailLayout(heading, "#D97706", body, undefined, locale, labels) };
}

function approvedEmail(p: { orderName: string; notes?: string; shopName?: string }, labels: Record<string, string>, locale: string): { subject: string; html: string } {
  const subject = t("email.approved.subject", labels, { order: p.orderName });
  const heading = t("email.approved.heading", labels);
  const bodyText = t("email.approved.body", labels, { id: "", order: p.orderName });
  const storeMsg = t("email.approved.storeMessage", labels);
  const nextSteps = t("email.approved.nextSteps", labels);
  const body = `
    <div style="text-align:center;margin:0 0 20px">
      <div style="display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;background:#ECFDF5">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      </div>
    </div>
    <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#059669;text-align:center">${esc(heading)}</h1>
    <p style="margin:0 0 20px;font-size:15px;color:#475569;line-height:1.7;text-align:center">${esc(bodyText)}</p>
    ${p.notes ? `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px 20px;margin:0 0 20px"><p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#0f172a">${esc(storeMsg)}:</p><p style="margin:0;font-size:14px;color:#475569;line-height:1.6">${esc(p.notes)}</p></div>` : ""}
    <p style="margin:0;font-size:14px;color:#64748b;text-align:center">${esc(nextSteps)}</p>`;
  return { subject, html: emailLayout(heading, "#059669", body, p.shopName, locale, labels) };
}

function rejectedEmail(p: { orderName: string; reason: string; shopName?: string }, labels: Record<string, string>, locale: string): { subject: string; html: string } {
  const subject = t("email.rejected.subject", labels, { order: p.orderName });
  const heading = t("email.rejected.heading", labels);
  const bodyText = t("email.rejected.body", labels, { id: "", order: p.orderName });
  const reasonLabel = t("email.rejected.reason", labels);
  const contact = t("email.rejected.contact", labels);
  const body = `
    <div style="text-align:center;margin:0 0 20px">
      <div style="display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;background:#FEF2F2">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#DC2626" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
      </div>
    </div>
    <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#DC2626;text-align:center">${esc(heading)}</h1>
    <p style="margin:0 0 20px;font-size:15px;color:#475569;line-height:1.7;text-align:center">${esc(bodyText)}</p>
    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:16px 20px;margin:0 0 20px">
      <p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#991b1b">${esc(reasonLabel)}:</p>
      <p style="margin:0;font-size:14px;color:#7f1d1d;line-height:1.6">${esc(p.reason)}</p>
    </div>
    <p style="margin:0;font-size:14px;color:#64748b;text-align:center">${esc(contact)}</p>`;
  return { subject, html: emailLayout(heading, "#DC2626", body, p.shopName, locale, labels) };
}

function refundedEmail(p: { orderName: string; amount?: string; currency?: string; shopName?: string }, labels: Record<string, string>, locale: string): { subject: string; html: string } {
  const subject = t("email.refunded.subject", labels, { order: p.orderName });
  const heading = t("email.refunded.heading", labels);
  const bodyText = t("email.refunded.body", labels, { order: p.orderName });
  const note = t("email.refunded.note", labels);
  const amountStr = p.amount ? formatMoney(p.amount, p.currency, locale) : null;
  const body = `
    <div style="text-align:center;margin:0 0 20px">
      <div style="display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;background:#F5F3FF">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#7C3AED" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
      </div>
    </div>
    <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#7C3AED;text-align:center">${esc(heading)}</h1>
    <p style="margin:0 0 20px;font-size:15px;color:#475569;line-height:1.7;text-align:center">${esc(bodyText)}</p>
    ${amountStr ? `<div style="text-align:center;margin:0 0 20px"><span style="display:inline-block;background:#F5F3FF;border:1px solid #DDD6FE;border-radius:10px;padding:12px 24px;font-size:24px;font-weight:700;color:#7C3AED">${esc(amountStr)}</span></div>` : ""}
    <p style="margin:0;font-size:14px;color:#64748b;line-height:1.7;text-align:center">${esc(note)}</p>`;
  return { subject, html: emailLayout(heading, "#7C3AED", body, p.shopName, locale, labels) };
}

function otpEmail(otp: string, labels: Record<string, string>, locale: string): { subject: string; html: string } {
  const subject = t("email.otp.subject", labels);
  const heading = t("email.otp.heading", labels);
  const bodyText = t("email.otp.body", labels);
  const expiry = t("email.otp.expiry", labels);
  const body = `
    <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#0f172a;text-align:center">${esc(heading)}</h1>
    <p style="margin:0 0 20px;font-size:15px;color:#475569;text-align:center">${esc(bodyText)}</p>
    <div style="text-align:center;margin:0 0 20px">
      <span style="display:inline-block;font-size:36px;font-weight:800;letter-spacing:10px;color:#0f172a;background:#f1f5f9;border:2px solid #e2e8f0;border-radius:12px;padding:16px 32px;font-family:monospace">${esc(otp)}</span>
    </div>
    <p style="margin:0;font-size:13px;color:#94a3b8;text-align:center">${esc(expiry)}</p>`;
  return { subject, html: emailLayout(heading, "#3B82F6", body, undefined, locale, labels) };
}

/* ── Notification Logging ── */
async function logNotification(params: {
  shopDomain: string;
  returnCaseId?: string | null;
  channel: string;
  recipient: string;
  eventType: string;
  subject?: string | null;
  result: SendResult;
}): Promise<void> {
  try {
    const shop = await prisma.shop.findUnique({ where: { shopDomain: params.shopDomain }, select: { id: true } });
    if (!shop) return;
    await prisma.notificationLog.create({
      data: {
        shopId: shop.id,
        returnCaseId: params.returnCaseId ?? undefined,
        channel: params.channel,
        recipient: params.recipient,
        eventType: params.eventType,
        subject: params.subject ?? undefined,
        status: params.result.success ? "sent" : "failed",
        error: params.result.error ?? undefined,
      },
    });
  } catch (err) {
    notifLogger.warn({ err, shopDomain: params.shopDomain, channel: params.channel, eventType: params.eventType }, "Failed to log notification");
  }
}

/* ── Public API ── */

export async function sendNewReturnNotification(params: {
  shopDomain: string;
  to?: string;
  orderName: string;
  customerEmail?: string;
  itemCount: number;
  returnRequestId: string;
  shopName?: string;
}): Promise<SendResult> {
  const { smtp, toggles, adminEmail, emailTemplates, i18n } = await getSmtpConfig(params.shopDomain);
  if (!toggles.notificationNewReturn) return { success: true };
  if (!smtp) { notifLogger.warn({ shopDomain: params.shopDomain, notificationType: "new_return" }, "SMTP not configured — skipping new return email"); return { success: true }; }

  const recipient = params.to || adminEmail;
  if (!recipient) return { success: false, error: "No admin email configured" };

  const custom = emailTemplates.new_return;
  if (custom?.subject && custom?.bodyHtml) {
    const vars: Record<string, string> = {
      orderName: params.orderName,
      customerEmail: params.customerEmail ?? "",
      shopName: params.shopName ?? "",
      returnId: params.returnRequestId,
      status: "new",
      refundAmount: "",
      rejectionReason: "",
    };
    return withSpan("notification.email.send", { "notification.type": "new_return", "notification.recipient_type": "admin" }, async (span) => {
      const result = await sendEmail(smtp, recipient, replaceTemplateVars(custom.subject, vars), replaceTemplateVars(custom.bodyHtml, vars));
      addBusinessEvent("notification.email.sent", { "notification.type": "new_return", "notification.success": result.success });
      return result;
    });
  }

  const labels = getPortalLabels(i18n.locale);
  const { subject, html } = newReturnEmail({
    orderName: params.orderName,
    returnId: params.returnRequestId,
    customerEmail: params.customerEmail,
    itemCount: params.itemCount,
  }, labels, i18n.locale);
  const result = await withSpan("notification.email.send", { "notification.type": "new_return", "notification.recipient_type": "admin" }, async (span) => {
    const r = await sendEmail(smtp, recipient, subject, html);
    addBusinessEvent("notification.email.sent", { "notification.type": "new_return", "notification.success": r.success });
    return r;
  });
  logNotification({ shopDomain: params.shopDomain, channel: "email", recipient, eventType: "new_return", subject, result }).catch(() => {});
  return result;
}

export async function sendApprovalNotification(params: {
  shopDomain: string;
  to: string;
  orderName: string;
  shopName?: string;
  notes?: string;
  returnId?: string;
  customerPhone?: string | null;
}): Promise<SendResult> {
  const { smtp, toggles, emailTemplates, i18n } = await getSmtpConfig(params.shopDomain);
  if (!toggles.notificationApproved) return { success: true };
  if (!smtp) return { success: true };
  if (!params.to) return { success: false, error: "No recipient" };

  const custom = emailTemplates.approved;
  let emailResult: SendResult;
  if (custom?.subject && custom?.bodyHtml) {
    const vars: Record<string, string> = {
      orderName: params.orderName,
      customerEmail: params.to,
      shopName: params.shopName ?? "",
      returnId: params.returnId ?? "",
      status: "approved",
      refundAmount: "",
      rejectionReason: "",
    };
    emailResult = await withSpan("notification.email.send", { "notification.type": "approved", "notification.recipient_type": "customer" }, async (span) => {
      const r = await sendEmail(smtp, params.to, replaceTemplateVars(custom.subject, vars), replaceTemplateVars(custom.bodyHtml, vars));
      addBusinessEvent("notification.email.sent", { "notification.type": "approved", "notification.success": r.success });
      return r;
    });
  } else {
    const labels = getPortalLabels(i18n.locale);
    const { subject, html } = approvedEmail({ orderName: params.orderName, notes: params.notes, shopName: params.shopName }, labels, i18n.locale);
    emailResult = await withSpan("notification.email.send", { "notification.type": "approved", "notification.recipient_type": "customer" }, async (span) => {
      const r = await sendEmail(smtp, params.to, subject, html);
      addBusinessEvent("notification.email.sent", { "notification.type": "approved", "notification.success": r.success });
      return r;
    });
  }
  logNotification({ shopDomain: params.shopDomain, channel: "email", recipient: params.to, eventType: "approved", subject: "Return Approved", result: emailResult }).catch(() => {});
  // WhatsApp follow-up
  if (params.customerPhone) {
    const waConfig = await getWhatsAppConfig(params.shopDomain);
    if (waConfig) {
      const msg = `Your return for order ${params.orderName} has been approved. ${params.notes ? `Note: ${params.notes}` : "We'll arrange pickup soon."}`;
      const waResult = await withSpan("notification.whatsapp.send", { "notification.type": "approved", "notification.recipient_type": "customer", "whatsapp.provider": waConfig.provider }, async (span) => {
        const r = await sendWhatsAppNotification(waConfig, params.customerPhone!, msg);
        addBusinessEvent("notification.whatsapp.sent", { "notification.type": "approved", "notification.success": r.success });
        return r;
      });
      logNotification({ shopDomain: params.shopDomain, channel: "whatsapp", recipient: params.customerPhone, eventType: "approved", result: waResult }).catch(() => {});
    }
  }
  return emailResult;
}

export async function sendRejectionNotification(params: {
  shopDomain: string;
  to: string;
  orderName: string;
  rejectionReason: string;
  shopName?: string;
  returnId?: string;
  customerPhone?: string | null;
}): Promise<SendResult> {
  const { smtp, toggles, emailTemplates, i18n } = await getSmtpConfig(params.shopDomain);
  if (!toggles.notificationRejected) return { success: true };
  if (!smtp) return { success: true };
  if (!params.to) return { success: false, error: "No recipient" };

  const custom = emailTemplates.rejected;
  let emailResult: SendResult;
  if (custom?.subject && custom?.bodyHtml) {
    const vars: Record<string, string> = {
      orderName: params.orderName,
      customerEmail: params.to,
      shopName: params.shopName ?? "",
      returnId: params.returnId ?? "",
      status: "rejected",
      refundAmount: "",
      rejectionReason: params.rejectionReason,
    };
    emailResult = await withSpan("notification.email.send", { "notification.type": "rejected", "notification.recipient_type": "customer" }, async (span) => {
      const r = await sendEmail(smtp, params.to, replaceTemplateVars(custom.subject, vars), replaceTemplateVars(custom.bodyHtml, vars));
      addBusinessEvent("notification.email.sent", { "notification.type": "rejected", "notification.success": r.success });
      return r;
    });
  } else {
    const labels = getPortalLabels(i18n.locale);
    const { subject, html } = rejectedEmail({ orderName: params.orderName, reason: params.rejectionReason, shopName: params.shopName }, labels, i18n.locale);
    emailResult = await withSpan("notification.email.send", { "notification.type": "rejected", "notification.recipient_type": "customer" }, async (span) => {
      const r = await sendEmail(smtp, params.to, subject, html);
      addBusinessEvent("notification.email.sent", { "notification.type": "rejected", "notification.success": r.success });
      return r;
    });
  }
  logNotification({ shopDomain: params.shopDomain, channel: "email", recipient: params.to, eventType: "rejected", subject: "Return Rejected", result: emailResult }).catch(() => {});
  if (params.customerPhone) {
    const waConfig = await getWhatsAppConfig(params.shopDomain);
    if (waConfig) {
      const msg = `Your return for order ${params.orderName} was not approved. Reason: ${params.rejectionReason || "See portal for details."}`;
      const waResult = await withSpan("notification.whatsapp.send", { "notification.type": "rejected", "notification.recipient_type": "customer", "whatsapp.provider": waConfig.provider }, async (span) => {
        const r = await sendWhatsAppNotification(waConfig, params.customerPhone!, msg);
        addBusinessEvent("notification.whatsapp.sent", { "notification.type": "rejected", "notification.success": r.success });
        return r;
      });
      logNotification({ shopDomain: params.shopDomain, channel: "whatsapp", recipient: params.customerPhone, eventType: "rejected", result: waResult }).catch(() => {});
    }
  }
  return emailResult;
}

export async function sendRefundNotification(params: {
  shopDomain: string;
  to: string;
  orderName: string;
  amount?: string;
  currency?: string;
  shopName?: string;
  returnId?: string;
  customerPhone?: string | null;
}): Promise<SendResult> {
  const { smtp, toggles, emailTemplates, i18n } = await getSmtpConfig(params.shopDomain);
  if (!toggles.notificationRefunded) return { success: true };
  if (!smtp) return { success: true };
  if (!params.to) return { success: false, error: "No recipient" };

  const custom = emailTemplates.refunded;
  let emailResult: SendResult;
  if (custom?.subject && custom?.bodyHtml) {
    const refundAmount = params.amount ? formatMoney(params.amount, params.currency || i18n.currency, i18n.locale) : "";
    const vars: Record<string, string> = {
      orderName: params.orderName,
      customerEmail: params.to,
      shopName: params.shopName ?? "",
      returnId: params.returnId ?? "",
      status: "refunded",
      refundAmount,
      rejectionReason: "",
    };
    emailResult = await withSpan("notification.email.send", { "notification.type": "refunded", "notification.recipient_type": "customer" }, async (span) => {
      const r = await sendEmail(smtp, params.to, replaceTemplateVars(custom.subject, vars), replaceTemplateVars(custom.bodyHtml, vars));
      addBusinessEvent("notification.email.sent", { "notification.type": "refunded", "notification.success": r.success });
      return r;
    });
  } else {
    const labels = getPortalLabels(i18n.locale);
    const { subject, html } = refundedEmail({ orderName: params.orderName, amount: params.amount, currency: params.currency || i18n.currency, shopName: params.shopName }, labels, i18n.locale);
    emailResult = await withSpan("notification.email.send", { "notification.type": "refunded", "notification.recipient_type": "customer" }, async (span) => {
      const r = await sendEmail(smtp, params.to, subject, html);
      addBusinessEvent("notification.email.sent", { "notification.type": "refunded", "notification.success": r.success });
      return r;
    });
  }
  logNotification({ shopDomain: params.shopDomain, channel: "email", recipient: params.to, eventType: "refunded", subject: "Refund Processed", result: emailResult }).catch(() => {});
  if (params.customerPhone) {
    const waConfig = await getWhatsAppConfig(params.shopDomain);
    if (waConfig) {
      const amountStr = params.amount ? ` of ${params.amount} ${params.currency ?? ""}`.trim() : "";
      const msg = `Your refund${amountStr} for order ${params.orderName} has been processed.`;
      const waResult = await withSpan("notification.whatsapp.send", { "notification.type": "refunded", "notification.recipient_type": "customer", "whatsapp.provider": waConfig.provider }, async (span) => {
        const r = await sendWhatsAppNotification(waConfig, params.customerPhone!, msg);
        addBusinessEvent("notification.whatsapp.sent", { "notification.type": "refunded", "notification.success": r.success });
        return r;
      });
      logNotification({ shopDomain: params.shopDomain, channel: "whatsapp", recipient: params.customerPhone, eventType: "refunded", result: waResult }).catch(() => {});
    }
  }
  return emailResult;
}

export async function sendOtpEmail(params: {
  shopDomain: string;
  to: string;
  otp: string;
}): Promise<SendResult> {
  const { smtp, i18n } = await getSmtpConfig(params.shopDomain);
  if (!smtp) return { success: true };
  if (!params.to) return { success: false, error: "No recipient" };

  const labels = getPortalLabels(i18n.locale);
  const { subject, html } = otpEmail(params.otp, labels, i18n.locale);
  const result = await withSpan("notification.email.send", { "notification.type": "otp", "notification.recipient_type": "customer" }, async (span) => {
    const r = await sendEmail(smtp, params.to, subject, html);
    addBusinessEvent("notification.email.sent", { "notification.type": "otp", "notification.success": r.success });
    return r;
  });
  logNotification({ shopDomain: params.shopDomain, channel: "email", recipient: params.to, eventType: "otp", subject, result }).catch(() => {});
  return result;
}

export async function sendCustomerNoteNotification(params: {
  shopDomain: string;
  to: string;
  orderName: string;
  note: string;
  shopName?: string;
  returnId?: string;
}): Promise<SendResult> {
  const { smtp, i18n } = await getSmtpConfig(params.shopDomain);
  if (!smtp) return { success: true };
  if (!params.to) return { success: false, error: "No recipient" };

  const subject = `Update on your return for order ${params.orderName}`;
  const shopDisplay = params.shopName ? `<strong>${params.shopName}</strong>` : "The store";
  const html = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;color:#374151;">
      <h2 style="font-size:18px;font-weight:700;margin-bottom:8px;">Message from ${shopDisplay}</h2>
      <p style="color:#6B7280;font-size:14px;margin-bottom:16px;">Regarding your return for order <strong>${params.orderName}</strong></p>
      <div style="background:#dbeafe;border-left:3px solid #2563eb;padding:14px 16px;border-radius:8px;font-size:14px;line-height:1.6;color:#1e40af;white-space:pre-wrap;">${params.note}</div>
      <p style="font-size:12px;color:#9CA3AF;margin-top:24px;">You can track your return status in our returns portal.</p>
    </div>
  `;
  const result = await withSpan("notification.email.send", { "notification.type": "custom_note", "notification.recipient_type": "customer" }, async (span) => {
    const r = await sendEmail(smtp, params.to, subject, html);
    addBusinessEvent("notification.email.sent", { "notification.type": "custom_note", "notification.success": r.success });
    return r;
  });
  logNotification({ shopDomain: params.shopDomain, channel: "email", recipient: params.to, eventType: "custom_note", subject, result }).catch(() => {});
  return result;
}

export async function testSmtpConnection(config: {
  host: string; port: number; secure: boolean; user: string; pass: string;
}): Promise<SendResult> {
  try {
    const transport = nodemailer.createTransport({
      host: config.host, port: config.port, secure: config.secure,
      auth: { user: config.user, pass: config.pass },
      connectionTimeout: 10_000,
    });
    await transport.verify();
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── WhatsApp Notifications ───────────────────────────────────────────────────

export interface WhatsAppConfig {
  provider: string;   // "meta_cloud" | "twilio" | "wati" | "interakt"
  apiKey: string;
  phoneNumberId?: string | null;  // Meta Cloud: phone number ID
  fromNumber?: string | null;     // E.164 e.g. "+911234567890"
}

export async function getWhatsAppConfig(shopDomain: string): Promise<WhatsAppConfig | null> {
  const shop = await prisma.shop.findUnique({ where: { shopDomain }, include: { settings: true } });
  const s = shop?.settings as (typeof shop extends null ? never : NonNullable<typeof shop>["settings"] & {
    whatsappEnabled?: boolean;
    whatsappProvider?: string | null;
    whatsappApiKey?: string | null;
    whatsappPhoneNumberId?: string | null;
    whatsappFromNumber?: string | null;
  }) | null;
  if (!s?.whatsappEnabled || !s?.whatsappApiKey || !s?.whatsappProvider) return null;
  return {
    provider: s.whatsappProvider,
    apiKey: s.whatsappApiKey,
    phoneNumberId: s.whatsappPhoneNumberId ?? null,
    fromNumber: s.whatsappFromNumber ?? null,
  };
}

export async function sendWhatsAppNotification(
  config: WhatsAppConfig,
  to: string,
  message: string
): Promise<SendResult> {
  if (!to || !message) return { success: false, error: "Missing recipient or message" };
  const phone = to.startsWith("+") ? to : `+${to}`;
  try {
    if (config.provider === "meta_cloud" && config.phoneNumberId) {
      const url = `https://graph.facebook.com/v18.0/${config.phoneNumberId}/messages`;
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.apiKey}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: phone,
          type: "text",
          text: { body: message },
        }),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        return { success: false, error: `Meta Cloud WhatsApp API error ${res.status}: ${errText}` };
      }
      return { success: true };
    }
    // Other providers (twilio/wati/interakt) — log and skip for now
    notifLogger.info({ provider: config.provider, recipient: phone, messagePreview: message.slice(0, 80) }, "WhatsApp provider not yet implemented, skipping send");
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Cancellation Notifications ──────────────────────────────────────────────

function cancelledEmail(p: { orderName: string; shopName?: string }, labels: Record<string, string>, locale: string): { subject: string; html: string } {
  const subject = t("email.cancelled.subject", labels, { order: p.orderName });
  const heading = t("email.cancelled.heading", labels);
  const bodyText = t("email.cancelled.body", labels, { order: p.orderName });
  const contact = t("email.cancelled.contact", labels);
  const body = `
    <div style="text-align:center;margin:0 0 20px">
      <div style="display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;background:#F1F5F9">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#64748B" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
      </div>
    </div>
    <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#475569;text-align:center">${esc(heading)}</h1>
    <p style="margin:0 0 20px;font-size:15px;color:#475569;line-height:1.7;text-align:center">${esc(bodyText)}</p>
    <p style="margin:0;font-size:14px;color:#64748b;text-align:center">${esc(contact)}</p>`;
  return { subject, html: emailLayout(heading, "#64748B", body, p.shopName, locale, labels) };
}

function cancellationDeclinedEmail(p: { orderName: string; shopName?: string }, labels: Record<string, string>, locale: string): { subject: string; html: string } {
  const subject = t("email.cancellationDeclined.subject", labels, { order: p.orderName });
  const heading = t("email.cancellationDeclined.heading", labels);
  const bodyText = t("email.cancellationDeclined.body", labels, { order: p.orderName });
  const contact = t("email.cancellationDeclined.contact", labels);
  const body = `
    <div style="text-align:center;margin:0 0 20px">
      <div style="display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;background:#FEF9C3">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#CA8A04" stroke-width="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      </div>
    </div>
    <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#CA8A04;text-align:center">${esc(heading)}</h1>
    <p style="margin:0 0 20px;font-size:15px;color:#475569;line-height:1.7;text-align:center">${esc(bodyText)}</p>
    <p style="margin:0;font-size:14px;color:#64748b;text-align:center">${esc(contact)}</p>`;
  return { subject, html: emailLayout(heading, "#CA8A04", body, p.shopName, locale, labels) };
}

export async function sendCancellationNotification(params: {
  shopDomain: string;
  to: string;
  orderName: string;
  shopName?: string;
  returnId?: string;
  customerPhone?: string | null;
}): Promise<SendResult> {
  const { smtp, toggles, emailTemplates, i18n } = await getSmtpConfig(params.shopDomain);
  if (!toggles.notificationCancelled) return { success: true };
  if (!smtp) return { success: true };
  if (!params.to) return { success: false, error: "No recipient" };

  const custom = emailTemplates.cancelled;
  let emailResult: SendResult;
  if (custom?.subject && custom?.bodyHtml) {
    const vars: Record<string, string> = {
      orderName: params.orderName,
      customerEmail: params.to,
      shopName: params.shopName ?? "",
      returnId: params.returnId ?? "",
      status: "cancelled",
      refundAmount: "",
      rejectionReason: "",
    };
    emailResult = await withSpan("notification.email.send", { "notification.type": "cancelled", "notification.recipient_type": "customer" }, async (span) => {
      const r = await sendEmail(smtp, params.to, replaceTemplateVars(custom.subject, vars), replaceTemplateVars(custom.bodyHtml, vars));
      addBusinessEvent("notification.email.sent", { "notification.type": "cancelled", "notification.success": r.success });
      return r;
    });
  } else {
    const labels = getPortalLabels(i18n.locale);
    const { subject, html } = cancelledEmail({ orderName: params.orderName, shopName: params.shopName }, labels, i18n.locale);
    emailResult = await withSpan("notification.email.send", { "notification.type": "cancelled", "notification.recipient_type": "customer" }, async (span) => {
      const r = await sendEmail(smtp, params.to, subject, html);
      addBusinessEvent("notification.email.sent", { "notification.type": "cancelled", "notification.success": r.success });
      return r;
    });
  }
  logNotification({ shopDomain: params.shopDomain, channel: "email", recipient: params.to, eventType: "cancelled", subject: "Return Cancelled", result: emailResult }).catch(() => {});
  if (params.customerPhone) {
    const waConfig = await getWhatsAppConfig(params.shopDomain);
    if (waConfig) {
      const msg = `Your return for order ${params.orderName} has been cancelled.`;
      const waResult = await withSpan("notification.whatsapp.send", { "notification.type": "cancelled", "notification.recipient_type": "customer", "whatsapp.provider": waConfig.provider }, async (span) => {
        const r = await sendWhatsAppNotification(waConfig, params.customerPhone!, msg);
        addBusinessEvent("notification.whatsapp.sent", { "notification.type": "cancelled", "notification.success": r.success });
        return r;
      });
      logNotification({ shopDomain: params.shopDomain, channel: "whatsapp", recipient: params.customerPhone, eventType: "cancelled", result: waResult }).catch(() => {});
    }
  }
  return emailResult;
}

export async function sendCancellationDeclinedNotification(params: {
  shopDomain: string;
  to: string;
  orderName: string;
  shopName?: string;
  returnId?: string;
  customerPhone?: string | null;
}): Promise<SendResult> {
  const { smtp, toggles, emailTemplates, i18n } = await getSmtpConfig(params.shopDomain);
  if (!toggles.notificationCancelled) return { success: true };
  if (!smtp) return { success: true };
  if (!params.to) return { success: false, error: "No recipient" };

  const custom = emailTemplates.cancellation_declined;
  let emailResult: SendResult;
  if (custom?.subject && custom?.bodyHtml) {
    const vars: Record<string, string> = {
      orderName: params.orderName,
      customerEmail: params.to,
      shopName: params.shopName ?? "",
      returnId: params.returnId ?? "",
      status: "cancellation_declined",
      refundAmount: "",
      rejectionReason: "",
    };
    emailResult = await withSpan("notification.email.send", { "notification.type": "cancellation_declined", "notification.recipient_type": "customer" }, async (span) => {
      const r = await sendEmail(smtp, params.to, replaceTemplateVars(custom.subject, vars), replaceTemplateVars(custom.bodyHtml, vars));
      addBusinessEvent("notification.email.sent", { "notification.type": "cancellation_declined", "notification.success": r.success });
      return r;
    });
  } else {
    const labels = getPortalLabels(i18n.locale);
    const { subject, html } = cancellationDeclinedEmail({ orderName: params.orderName, shopName: params.shopName }, labels, i18n.locale);
    emailResult = await withSpan("notification.email.send", { "notification.type": "cancellation_declined", "notification.recipient_type": "customer" }, async (span) => {
      const r = await sendEmail(smtp, params.to, subject, html);
      addBusinessEvent("notification.email.sent", { "notification.type": "cancellation_declined", "notification.success": r.success });
      return r;
    });
  }
  logNotification({ shopDomain: params.shopDomain, channel: "email", recipient: params.to, eventType: "cancellation_declined", subject: "Cancellation Request Declined", result: emailResult }).catch(() => {});
  if (params.customerPhone) {
    const waConfig = await getWhatsAppConfig(params.shopDomain);
    if (waConfig) {
      const msg = `Your cancellation request for the return on order ${params.orderName} was not approved. Please proceed with the return process.`;
      const waResult = await withSpan("notification.whatsapp.send", { "notification.type": "cancellation_declined", "notification.recipient_type": "customer", "whatsapp.provider": waConfig.provider }, async (span) => {
        const r = await sendWhatsAppNotification(waConfig, params.customerPhone!, msg);
        addBusinessEvent("notification.whatsapp.sent", { "notification.type": "cancellation_declined", "notification.success": r.success });
        return r;
      });
      logNotification({ shopDomain: params.shopDomain, channel: "whatsapp", recipient: params.customerPhone, eventType: "cancellation_declined", result: waResult }).catch(() => {});
    }
  }
  return emailResult;
}
