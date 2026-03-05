import nodemailer from "nodemailer";
import prisma from "../db.server";

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

async function getSmtpConfig(shopDomain: string): Promise<{ smtp: SmtpConfig | null; toggles: NotifToggles; adminEmail: string | null }> {
  const shop = await prisma.shop.findUnique({
    where: { shopDomain },
    include: { settings: true },
  });
  const s = shop?.settings;
  if (!s?.smtpHost || !s?.smtpUser || !s?.smtpPass) {
    return {
      smtp: null,
      toggles: {
        notificationNewReturn: s?.notificationNewReturn ?? true,
        notificationApproved: s?.notificationApproved ?? true,
        notificationRejected: s?.notificationRejected ?? true,
        notificationRefunded: s?.notificationRefunded ?? true,
      },
      adminEmail: s?.adminNotifyEmail ?? null,
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
      fromName: s.smtpFromName || "Return Pro Max",
    },
    toggles: {
      notificationNewReturn: s.notificationNewReturn,
      notificationApproved: s.notificationApproved,
      notificationRejected: s.notificationRejected,
      notificationRefunded: s.notificationRefunded ?? true,
    },
    adminEmail: s.adminNotifyEmail ?? null,
  };
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
    console.error("[Email] Send failed:", err);
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/* ── HTML Template Builder ── */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function emailLayout(title: string, accentColor: string, body: string, shopName?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
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
      <p style="margin:4px 0 0">Powered by Return Pro Max</p>
    </div>
  </td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

/* ── Email Templates ── */

function newReturnEmail(p: { orderName: string; returnId: string; customerEmail?: string; itemCount: number }): { subject: string; html: string } {
  const subject = `New return request ${p.returnId} for ${p.orderName}`;
  const body = `
    <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#0f172a">New Return Request</h1>
    <p style="margin:0 0 20px;font-size:15px;color:#475569;line-height:1.7">A customer has submitted a return request that requires your attention.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;margin:0 0 20px">
      <tr><td style="padding:18px 22px">
        <table width="100%" cellpadding="0" cellspacing="0">
          <tr><td style="padding:4px 0;font-size:14px;color:#92400e"><strong>Request ID:</strong></td><td style="padding:4px 0;font-size:14px;color:#92400e;text-align:right;font-family:monospace">${esc(p.returnId)}</td></tr>
          <tr><td style="padding:4px 0;font-size:14px;color:#92400e"><strong>Order:</strong></td><td style="padding:4px 0;font-size:14px;color:#92400e;text-align:right">${esc(p.orderName)}</td></tr>
          ${p.customerEmail ? `<tr><td style="padding:4px 0;font-size:14px;color:#92400e"><strong>Customer:</strong></td><td style="padding:4px 0;font-size:14px;color:#92400e;text-align:right">${esc(p.customerEmail)}</td></tr>` : ""}
          <tr><td style="padding:4px 0;font-size:14px;color:#92400e"><strong>Items:</strong></td><td style="padding:4px 0;font-size:14px;color:#92400e;text-align:right">${p.itemCount} item(s)</td></tr>
        </table>
      </td></tr>
    </table>
    <p style="margin:0;font-size:14px;color:#64748b">Log in to Return Pro Max to review this request.</p>`;
  return { subject, html: emailLayout("New Return Request", "#D97706", body) };
}

function approvedEmail(p: { orderName: string; notes?: string; shopName?: string }): { subject: string; html: string } {
  const subject = `Your return for ${p.orderName} has been approved`;
  const body = `
    <div style="text-align:center;margin:0 0 20px">
      <div style="display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;background:#ECFDF5">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      </div>
    </div>
    <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#059669;text-align:center">Return Approved</h1>
    <p style="margin:0 0 20px;font-size:15px;color:#475569;line-height:1.7;text-align:center">Your return request for order <strong>${esc(p.orderName)}</strong> has been approved and is being processed.</p>
    ${p.notes ? `<div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;padding:16px 20px;margin:0 0 20px"><p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#0f172a">Message from the store:</p><p style="margin:0;font-size:14px;color:#475569;line-height:1.6">${esc(p.notes)}</p></div>` : ""}
    <p style="margin:0;font-size:14px;color:#64748b;text-align:center">We'll notify you with further updates.</p>`;
  return { subject, html: emailLayout("Return Approved", "#059669", body, p.shopName) };
}

function rejectedEmail(p: { orderName: string; reason: string; shopName?: string }): { subject: string; html: string } {
  const subject = `Your return for ${p.orderName} has been declined`;
  const body = `
    <div style="text-align:center;margin:0 0 20px">
      <div style="display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;background:#FEF2F2">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#DC2626" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
      </div>
    </div>
    <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#DC2626;text-align:center">Return Declined</h1>
    <p style="margin:0 0 20px;font-size:15px;color:#475569;line-height:1.7;text-align:center">Your return request for order <strong>${esc(p.orderName)}</strong> has been declined.</p>
    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:16px 20px;margin:0 0 20px">
      <p style="margin:0 0 6px;font-size:13px;font-weight:600;color:#991b1b">Reason:</p>
      <p style="margin:0;font-size:14px;color:#7f1d1d;line-height:1.6">${esc(p.reason)}</p>
    </div>
    <p style="margin:0;font-size:14px;color:#64748b;text-align:center">If you have questions, please contact the store.</p>`;
  return { subject, html: emailLayout("Return Declined", "#DC2626", body, p.shopName) };
}

function refundedEmail(p: { orderName: string; amount?: string; currency?: string; shopName?: string }): { subject: string; html: string } {
  const subject = `Your refund for ${p.orderName} has been processed`;
  const amountStr = p.amount && p.currency ? `${p.currency} ${p.amount}` : null;
  const body = `
    <div style="text-align:center;margin:0 0 20px">
      <div style="display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;background:#F5F3FF">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#7C3AED" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
      </div>
    </div>
    <h1 style="margin:0 0 12px;font-size:22px;font-weight:700;color:#7C3AED;text-align:center">Refund Processed</h1>
    <p style="margin:0 0 20px;font-size:15px;color:#475569;line-height:1.7;text-align:center">We've processed the refund for your return on order <strong>${esc(p.orderName)}</strong>.</p>
    ${amountStr ? `<div style="text-align:center;margin:0 0 20px"><span style="display:inline-block;background:#F5F3FF;border:1px solid #DDD6FE;border-radius:10px;padding:12px 24px;font-size:24px;font-weight:700;color:#7C3AED">${esc(amountStr)}</span></div>` : ""}
    <p style="margin:0;font-size:14px;color:#64748b;line-height:1.7;text-align:center">It may take a few business days for the funds to appear on your original payment method depending on your bank.</p>`;
  return { subject, html: emailLayout("Refund Processed", "#7C3AED", body, p.shopName) };
}

function otpEmail(otp: string): { subject: string; html: string } {
  const subject = "Your verification code";
  const body = `
    <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#0f172a;text-align:center">Verification Code</h1>
    <p style="margin:0 0 20px;font-size:15px;color:#475569;text-align:center">Enter this code to verify your identity:</p>
    <div style="text-align:center;margin:0 0 20px">
      <span style="display:inline-block;font-size:36px;font-weight:800;letter-spacing:10px;color:#0f172a;background:#f1f5f9;border:2px solid #e2e8f0;border-radius:12px;padding:16px 32px;font-family:monospace">${esc(otp)}</span>
    </div>
    <p style="margin:0;font-size:13px;color:#94a3b8;text-align:center">This code expires in 10 minutes. Do not share it with anyone.</p>`;
  return { subject, html: emailLayout("Verification Code", "#3B82F6", body) };
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
  const { smtp, toggles, adminEmail } = await getSmtpConfig(params.shopDomain);
  if (!toggles.notificationNewReturn) return { success: true };
  if (!smtp) { console.warn("[Email] SMTP not configured — skipping new return email"); return { success: true }; }

  const recipient = params.to || adminEmail;
  if (!recipient) return { success: false, error: "No admin email configured" };

  const { subject, html } = newReturnEmail({
    orderName: params.orderName,
    returnId: params.returnRequestId,
    customerEmail: params.customerEmail,
    itemCount: params.itemCount,
  });
  return sendEmail(smtp, recipient, subject, html);
}

export async function sendApprovalNotification(params: {
  shopDomain: string;
  to: string;
  orderName: string;
  shopName?: string;
  notes?: string;
}): Promise<SendResult> {
  const { smtp, toggles } = await getSmtpConfig(params.shopDomain);
  if (!toggles.notificationApproved) return { success: true };
  if (!smtp) return { success: true };
  if (!params.to) return { success: false, error: "No recipient" };

  const { subject, html } = approvedEmail({ orderName: params.orderName, notes: params.notes, shopName: params.shopName });
  return sendEmail(smtp, params.to, subject, html);
}

export async function sendRejectionNotification(params: {
  shopDomain: string;
  to: string;
  orderName: string;
  rejectionReason: string;
  shopName?: string;
}): Promise<SendResult> {
  const { smtp, toggles } = await getSmtpConfig(params.shopDomain);
  if (!toggles.notificationRejected) return { success: true };
  if (!smtp) return { success: true };
  if (!params.to) return { success: false, error: "No recipient" };

  const { subject, html } = rejectedEmail({ orderName: params.orderName, reason: params.rejectionReason, shopName: params.shopName });
  return sendEmail(smtp, params.to, subject, html);
}

export async function sendRefundNotification(params: {
  shopDomain: string;
  to: string;
  orderName: string;
  amount?: string;
  currency?: string;
  shopName?: string;
}): Promise<SendResult> {
  const { smtp, toggles } = await getSmtpConfig(params.shopDomain);
  if (!toggles.notificationRefunded) return { success: true };
  if (!smtp) return { success: true };
  if (!params.to) return { success: false, error: "No recipient" };

  const { subject, html } = refundedEmail({ orderName: params.orderName, amount: params.amount, currency: params.currency, shopName: params.shopName });
  return sendEmail(smtp, params.to, subject, html);
}

export async function sendOtpEmail(params: {
  shopDomain: string;
  to: string;
  otp: string;
}): Promise<SendResult> {
  const { smtp } = await getSmtpConfig(params.shopDomain);
  if (!smtp) return { success: true };
  if (!params.to) return { success: false, error: "No recipient" };

  const { subject, html } = otpEmail(params.otp);
  return sendEmail(smtp, params.to, subject, html);
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
