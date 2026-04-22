import React, { useState, useCallback } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { findOrCreateShop } from "../lib/shop.server";
import { testSmtpConnection } from "../lib/notification.server";
import { encryptIfNeeded, decryptIfEncrypted, looksEncrypted } from "../lib/encryption.server";

// Sentinel returned to the client in place of the actual SMTP password. The form
// preserves this value when saving "as-is" (no change). Any other non-empty value is
// treated as a new password and re-encrypted on write. The actual password value is
// NEVER sent to the browser — previously it was, which exposed it in DevTools and
// over-the-wire (P0 finding).
const SMTP_PASS_PLACEHOLDER = "__UNCHANGED__";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await findOrCreateShop(session.shop);
  const s = shop.settings;

  let emailTemplatesJson: Record<string, { subject: string; bodyHtml: string }> = {};
  if ((s as { emailTemplatesJson?: string | null } | null)?.emailTemplatesJson) {
    try { emailTemplatesJson = JSON.parse((s as { emailTemplatesJson: string }).emailTemplatesJson); } catch { /* ignore */ }
  }

  const sWa = s as typeof s & { whatsappEnabled?: boolean; whatsappProvider?: string | null; whatsappApiKey?: string | null; whatsappPhoneNumberId?: string | null; whatsappFromNumber?: string | null; portalOtpEmailEnabled?: boolean; portalOtpSmsEnabled?: boolean } | null;

  // Notification log: recent 50 entries
  const notificationLogs = await prisma.notificationLog.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return {
    notificationNewReturn: s?.notificationNewReturn ?? true,
    notificationApproved: s?.notificationApproved ?? true,
    notificationRejected: s?.notificationRejected ?? true,
    notificationRefunded: s?.notificationRefunded ?? true,
    smtpHost: s?.smtpHost ?? "",
    smtpPort: s?.smtpPort ?? 587,
    smtpUser: s?.smtpUser ?? "",
    // Never send the real password to the client. If a password is configured we
    // return a sentinel so the form can render "•••••••" and preserve the existing
    // value on save. The user can overwrite by typing a new value.
    smtpPass: s?.smtpPass ? SMTP_PASS_PLACEHOLDER : "",
    smtpFromEmail: s?.smtpFromEmail ?? "",
    smtpFromName: s?.smtpFromName ?? "",
    smtpSecure: s?.smtpSecure ?? false,
    adminNotifyEmail: s?.adminNotifyEmail ?? "",
    adminSoundEnabled: s?.adminSoundEnabled ?? true,
    smtpConfigured: !!(s?.smtpHost && s?.smtpUser && s?.smtpPass),
    emailTemplatesJson,
    whatsappEnabled: sWa?.whatsappEnabled ?? false,
    whatsappProvider: sWa?.whatsappProvider ?? "meta_cloud",
    // Mask: never echo the real API key back to the browser. Same pattern as smtpPass.
    whatsappApiKey: sWa?.whatsappApiKey ? SMTP_PASS_PLACEHOLDER : "",
    whatsappPhoneNumberId: sWa?.whatsappPhoneNumberId ?? "",
    whatsappFromNumber: sWa?.whatsappFromNumber ?? "",
    portalOtpEmailEnabled: sWa?.portalOtpEmailEnabled ?? false,
    portalOtpSmsEnabled: sWa?.portalOtpSmsEnabled ?? false,
    notificationLogs,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const fd = await request.formData();
  const intent = fd.get("intent");

  const shop = await findOrCreateShop(session.shop);

  if (intent === "test_smtp") {
    const host = String(fd.get("smtpHost") || "").trim();
    const port = parseInt(String(fd.get("smtpPort") || "587"), 10);
    const user = String(fd.get("smtpUser") || "").trim();
    let pass = String(fd.get("smtpPass") || "").trim();
    const secure = fd.get("smtpSecure") === "on";

    // If the form submitted the placeholder, use the stored (decrypted) password
    // so the test runs against the real configured value. The plaintext only lives
    // in memory for the duration of this request.
    if (pass === SMTP_PASS_PLACEHOLDER) {
      const stored = shop.settings?.smtpPass ?? null;
      pass = decryptIfEncrypted(stored) ?? "";
    }

    if (!host || !user || !pass) {
      return { testResult: { success: false, error: "Host, username, and password are required" } };
    }
    const result = await testSmtpConnection({ host, port, secure, user, pass });
    return { testResult: result };
  }

  if (intent === "save_email_templates") {
    const raw = String(fd.get("emailTemplatesJson") || "{}");
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(raw); } catch { return { error: "Invalid template JSON" }; }
    try {
      await prisma.shopSettings.upsert({
        where: { shopId: shop.id },
        create: { shopId: shop.id, emailTemplatesJson: JSON.stringify(parsed) },
        update: { emailTemplatesJson: JSON.stringify(parsed) },
      });
      return { templatesSaved: true };
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : "Failed to save templates." };
    }
  }

  // Resolve smtpPass: if the form submitted the placeholder, KEEP the existing
  // (already-encrypted) value. Otherwise encrypt the new plaintext on the way in.
  const submittedPass = String(fd.get("smtpPass") || "").trim();
  const resolvedPass: string | null = submittedPass === ""
    ? null
    : submittedPass === SMTP_PASS_PLACEHOLDER
      ? (shop.settings?.smtpPass ?? null) // keep existing (already encrypted)
      : encryptIfNeeded(submittedPass);

  const data = {
    notificationNewReturn: fd.get("notificationNewReturn") === "on",
    notificationApproved: fd.get("notificationApproved") === "on",
    notificationRejected: fd.get("notificationRejected") === "on",
    notificationRefunded: fd.get("notificationRefunded") === "on",
    smtpHost: String(fd.get("smtpHost") || "").trim() || null,
    smtpPort: parseInt(String(fd.get("smtpPort") || "587"), 10),
    smtpUser: String(fd.get("smtpUser") || "").trim() || null,
    smtpPass: resolvedPass,
    smtpFromEmail: String(fd.get("smtpFromEmail") || "").trim() || null,
    smtpFromName: String(fd.get("smtpFromName") || "").trim() || null,
    smtpSecure: fd.get("smtpSecure") === "on",
    adminNotifyEmail: String(fd.get("adminNotifyEmail") || "").trim() || null,
    adminSoundEnabled: fd.get("adminSoundEnabled") === "on",
    whatsappEnabled: fd.get("whatsappEnabled") === "on",
    whatsappProvider: String(fd.get("whatsappProvider") || "meta_cloud").trim() || null,
    // Same write-only-then-encrypt strategy as smtpPass — see resolvedPass above.
    whatsappApiKey: (() => {
      const submitted = String(fd.get("whatsappApiKey") || "").trim();
      if (submitted === "") return null;
      if (submitted === SMTP_PASS_PLACEHOLDER) {
        const sw = shop.settings as { whatsappApiKey?: string | null } | null;
        return sw?.whatsappApiKey ?? null;
      }
      return encryptIfNeeded(submitted);
    })(),
    whatsappPhoneNumberId: String(fd.get("whatsappPhoneNumberId") || "").trim() || null,
    whatsappFromNumber: String(fd.get("whatsappFromNumber") || "").trim() || null,
    portalOtpEmailEnabled: fd.get("portalOtpEmailEnabled") === "on",
    portalOtpSmsEnabled: fd.get("portalOtpSmsEnabled") === "on",
  };

  try {
    await prisma.shopSettings.upsert({
      where: { shopId: shop.id },
      create: { shopId: shop.id, ...data },
      update: data,
    });
    return { success: true };
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : "Failed to save notification settings." };
  }
};

/* ── Toggle Component ── */
function Toggle({ name, checked, onChange, label, description, icon, accentColor }: {
  name: string; checked: boolean; onChange: (v: boolean) => void;
  label: string; description: string; icon: React.ReactNode; accentColor?: string;
}) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 14, padding: "14px 18px",
      background: checked ? "var(--rpm-surface-subtle)" : "var(--rpm-surface)",
      border: `1px solid ${checked ? (accentColor || "var(--rpm-accent)") + "33" : "var(--rpm-border-color)"}`,
      borderRadius: "var(--rpm-radius)", transition: "var(--rpm-transition)",
    }}>
      <div style={{
        flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
        width: 38, height: 38, borderRadius: "var(--rpm-radius-sm)",
        background: checked ? (accentColor || "var(--rpm-accent)") + "14" : "var(--rpm-surface-elevated)",
        color: checked ? (accentColor || "var(--rpm-accent)") : "var(--rpm-text-muted)",
        transition: "var(--rpm-transition)",
      }}>{icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: 14, color: "var(--rpm-text)", marginBottom: 2 }}>{label}</div>
        <div style={{ fontSize: 12, color: "var(--rpm-text-muted)", lineHeight: 1.5 }}>{description}</div>
      </div>
      <label style={{ position: "relative", display: "inline-block", width: 44, height: 24, flexShrink: 0, cursor: "pointer" }}>
        <input type="checkbox" name={name} checked={checked} onChange={e => onChange(e.target.checked)}
          style={{ position: "absolute", opacity: 0, width: 0, height: 0 }} />
        <span style={{
          position: "absolute", inset: 0, borderRadius: 12, transition: "var(--rpm-transition)",
          background: checked ? (accentColor || "var(--rpm-accent)") : "#cbd5e1",
        }}>
          <span style={{
            position: "absolute", top: 2, left: checked ? 22 : 2, width: 20, height: 20,
            borderRadius: "50%", background: "#fff", transition: "var(--rpm-transition)",
            boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
          }} />
        </span>
      </label>
    </div>
  );
}

/* ── Section Header ── */
function SectionHeader({ icon, title, subtitle, badge }: {
  icon: React.ReactNode; title: string; subtitle: string; badge?: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 18 }}>
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0,
        width: 40, height: 40, borderRadius: "var(--rpm-radius)", background: "var(--rpm-accent-subtle)", color: "var(--rpm-accent)",
      }}>{icon}</div>
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <h2 style={{ margin: 0, fontSize: 17, fontWeight: 700, color: "var(--rpm-text)" }}>{title}</h2>
          {badge}
        </div>
        <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--rpm-text-muted)", lineHeight: 1.5 }}>{subtitle}</p>
      </div>
    </div>
  );
}

/* ── Input Field ── */
function Field({ label, name, value, onChange, type = "text", placeholder, required, half, helpText }: {
  label: string; name: string; value: string; onChange: (v: string) => void;
  type?: string; placeholder?: string; required?: boolean; half?: boolean; helpText?: string;
}) {
  return (
    <div style={{ flex: half ? "1 1 45%" : "1 1 100%", minWidth: half ? 180 : undefined }}>
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--rpm-text-secondary)", marginBottom: 6 }}>
        {label}{required && <span style={{ color: "var(--rpm-danger)" }}>*</span>}
      </label>
      <input
        type={type} name={name} value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} required={required}
        style={{
          width: "100%", padding: "9px 12px", fontSize: 14, borderRadius: "var(--rpm-radius-sm)",
          border: "var(--rpm-border)", background: "var(--rpm-surface)", color: "var(--rpm-text)",
          outline: "none", transition: "var(--rpm-transition)", boxSizing: "border-box",
          fontFamily: type === "password" ? "var(--rpm-font-mono)" : "var(--rpm-font)",
        }}
      />
      {helpText && <p style={{ margin: "4px 0 0", fontSize: 11, color: "var(--rpm-text-subtle)" }}>{helpText}</p>}
    </div>
  );
}

/* ── Main Page ── */
export default function Notifications() {
  const data = useLoaderData<typeof loader>();
  const saveFetcher = useFetcher<{ success?: boolean }>();
  const testFetcher = useFetcher<{ testResult?: { success: boolean; error?: string } }>();

  const [smtpHost, setSmtpHost] = useState(data.smtpHost);
  const [smtpPort, setSmtpPort] = useState(String(data.smtpPort));
  const [smtpUser, setSmtpUser] = useState(data.smtpUser);
  const [smtpPass, setSmtpPass] = useState(data.smtpPass);
  const [smtpFromEmail, setSmtpFromEmail] = useState(data.smtpFromEmail);
  const [smtpFromName, setSmtpFromName] = useState(data.smtpFromName);
  const [smtpSecure, setSmtpSecure] = useState(data.smtpSecure);
  const [adminEmail, setAdminEmail] = useState(data.adminNotifyEmail);
  const [adminSound, setAdminSound] = useState(data.adminSoundEnabled);

  const [newReturn, setNewReturn] = useState(data.notificationNewReturn);
  const [approved, setApproved] = useState(data.notificationApproved);
  const [rejected, setRejected] = useState(data.notificationRejected);
  const [refunded, setRefunded] = useState(data.notificationRefunded);

  const [waEnabled, setWaEnabled] = useState(data.whatsappEnabled);
  const [waProvider, setWaProvider] = useState(data.whatsappProvider);
  const [waApiKey, setWaApiKey] = useState(data.whatsappApiKey);
  const [waPhoneNumberId, setWaPhoneNumberId] = useState(data.whatsappPhoneNumberId);
  const [waFromNumber, setWaFromNumber] = useState(data.whatsappFromNumber);

  const [otpEmailEnabled, setOtpEmailEnabled] = useState(data.portalOtpEmailEnabled);
  const [otpSmsEnabled, setOtpSmsEnabled] = useState(data.portalOtpSmsEnabled);

  const [previewTemplate, setPreviewTemplate] = useState<string | null>(null);

  const templateFetcher = useFetcher<{ templatesSaved?: boolean; error?: string }>();
  type TemplateData = { subject: string; bodyHtml: string };
  const [emailTemplates, setEmailTemplates] = useState<Record<string, TemplateData>>(data.emailTemplatesJson ?? {});
  const [editingTemplate, setEditingTemplate] = useState<string | null>(null);
  const [templateSubject, setTemplateSubject] = useState("");
  const [templateBody, setTemplateBody] = useState("");
  const [showTemplatePreview, setShowTemplatePreview] = useState(false);
  const templateBodyRef = React.useRef<HTMLTextAreaElement>(null);

  const TEMPLATE_EVENTS: { key: string; label: string; color: string; defaultSubject: string; defaultBody: string }[] = [
    { key: "new_return", label: "New Return", color: "#D97706", defaultSubject: "New return request {{returnId}} for {{orderName}}", defaultBody: "<h2>New Return Request</h2><p>A return request <strong>{{returnId}}</strong> has been submitted for order <strong>{{orderName}}</strong> by {{customerEmail}}.</p><p>Please review this return in your admin panel.</p>" },
    { key: "approved", label: "Approved", color: "#059669", defaultSubject: "Your return for {{orderName}} has been approved", defaultBody: "<h2>Return Approved</h2><p>Your return request for order <strong>{{orderName}}</strong> has been approved and is being processed.</p><p>We will notify you with further updates.</p>" },
    { key: "rejected", label: "Rejected", color: "#DC2626", defaultSubject: "Your return for {{orderName}} has been declined", defaultBody: "<h2>Return Declined</h2><p>Your return request for order <strong>{{orderName}}</strong> has been declined.</p><p><strong>Reason:</strong> {{rejectionReason}}</p><p>If you have questions, please contact the store.</p>" },
    { key: "refunded", label: "Refunded", color: "#7C3AED", defaultSubject: "Your refund for {{orderName}} has been processed", defaultBody: "<h2>Refund Processed</h2><p>Your refund of <strong>{{refundAmount}}</strong> for order <strong>{{orderName}}</strong> has been processed.</p><p>It may take a few business days for the funds to appear.</p>" },
  ];

  const TEMPLATE_VARS = [
    { key: "orderName", label: "Order Name" },
    { key: "customerEmail", label: "Customer Email" },
    { key: "shopName", label: "Shop Name" },
    { key: "returnId", label: "Return ID" },
    { key: "status", label: "Status" },
    { key: "refundAmount", label: "Refund Amount" },
  ];

  const startEditing = useCallback((key: string) => {
    const event = TEMPLATE_EVENTS.find((e) => e.key === key);
    const existing = emailTemplates[key];
    setEditingTemplate(key);
    setTemplateSubject(existing?.subject ?? event?.defaultSubject ?? "");
    setTemplateBody(existing?.bodyHtml ?? event?.defaultBody ?? "");
    setShowTemplatePreview(false);
  }, [emailTemplates]);

  const insertVariable = useCallback((varKey: string) => {
    const tag = `{{${varKey}}}`;
    const textarea = templateBodyRef.current;
    if (textarea) {
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const val = templateBody;
      setTemplateBody(val.substring(0, start) + tag + val.substring(end));
      setTimeout(() => {
        textarea.focus();
        textarea.selectionStart = textarea.selectionEnd = start + tag.length;
      }, 0);
    } else {
      setTemplateBody((prev) => prev + tag);
    }
  }, [templateBody]);

  const saveTemplate = useCallback((key: string) => {
    const updated = { ...emailTemplates, [key]: { subject: templateSubject, bodyHtml: templateBody } };
    setEmailTemplates(updated);
    const fd = new FormData();
    fd.set("intent", "save_email_templates");
    fd.set("emailTemplatesJson", JSON.stringify(updated));
    templateFetcher.submit(fd, { method: "post" });
    setEditingTemplate(null);
  }, [emailTemplates, templateSubject, templateBody, templateFetcher]);

  const resetTemplate = useCallback((key: string) => {
    const updated = { ...emailTemplates };
    delete updated[key];
    setEmailTemplates(updated);
    const event = TEMPLATE_EVENTS.find((e) => e.key === key);
    setTemplateSubject(event?.defaultSubject ?? "");
    setTemplateBody(event?.defaultBody ?? "");
    const fd = new FormData();
    fd.set("intent", "save_email_templates");
    fd.set("emailTemplatesJson", JSON.stringify(updated));
    templateFetcher.submit(fd, { method: "post" });
  }, [emailTemplates, templateFetcher]);

  const saved = saveFetcher.data?.success === true;
  const templatesSaved = templateFetcher.data && "templatesSaved" in templateFetcher.data;
  const testResult = testFetcher.data?.testResult;
  const smtpFilled = !!(smtpHost && smtpUser && smtpPass);

  const handleTestSmtp = useCallback(() => {
    const fd = new FormData();
    fd.set("intent", "test_smtp");
    fd.set("smtpHost", smtpHost);
    fd.set("smtpPort", smtpPort);
    fd.set("smtpUser", smtpUser);
    fd.set("smtpPass", smtpPass);
    if (smtpSecure) fd.set("smtpSecure", "on");
    testFetcher.submit(fd, { method: "post" });
  }, [smtpHost, smtpPort, smtpUser, smtpPass, smtpSecure, testFetcher]);

  const playTestSound = useCallback(() => {
    try {
      const ctx = new AudioContext();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.1);
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.2);
      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.4);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.4);
    } catch { /* AudioContext unavailable */ }
  }, []);

  const previewTemplates: Record<string, { label: string; color: string; preview: string }> = {
    approved: {
      label: "Return Approved",
      color: "#059669",
      preview: `<div style="text-align:center;padding:24px">
        <div style="display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:50%;background:#ECFDF5;margin:0 0 16px">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="2.5"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
        </div>
        <h2 style="margin:0 0 8px;color:#059669;font-size:20px">Return Approved</h2>
        <p style="color:#475569;font-size:14px">Your return request for order <strong>#1234</strong> has been approved.</p>
      </div>`,
    },
    rejected: {
      label: "Return Rejected",
      color: "#DC2626",
      preview: `<div style="text-align:center;padding:24px">
        <div style="display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:50%;background:#FEF2F2;margin:0 0 16px">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#DC2626" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
        </div>
        <h2 style="margin:0 0 8px;color:#DC2626;font-size:20px">Return Declined</h2>
        <p style="color:#475569;font-size:14px">Your return for order <strong>#1234</strong> has been declined.</p>
        <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px;margin:12px 0;text-align:left">
          <strong style="font-size:12px;color:#991b1b">Reason:</strong>
          <p style="margin:4px 0 0;font-size:13px;color:#7f1d1d">Product not in original condition</p>
        </div>
      </div>`,
    },
    refunded: {
      label: "Refund Processed",
      color: "#7C3AED",
      preview: `<div style="text-align:center;padding:24px">
        <div style="display:inline-flex;align-items:center;justify-content:center;width:48px;height:48px;border-radius:50%;background:#F5F3FF;margin:0 0 16px">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#7C3AED" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>
        </div>
        <h2 style="margin:0 0 8px;color:#7C3AED;font-size:20px">Refund Processed</h2>
        <p style="color:#475569;font-size:14px">Your refund for order <strong>#1234</strong> has been processed.</p>
        <div style="display:inline-block;background:#F5F3FF;border:1px solid #DDD6FE;border-radius:8px;padding:8px 20px;margin:12px 0;font-size:22px;font-weight:700;color:#7C3AED">INR 1,299.00</div>
      </div>`,
    },
    newReturn: {
      label: "New Return (Admin)",
      color: "#D97706",
      preview: `<div style="padding:24px">
        <h2 style="margin:0 0 12px;color:#0f172a;font-size:20px">New Return Request</h2>
        <p style="color:#475569;font-size:14px;margin:0 0 16px">A customer has submitted a return that requires your attention.</p>
        <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:14px 18px">
          <div style="display:flex;justify-content:space-between;padding:3px 0;font-size:13px;color:#92400e"><span><strong>Request ID:</strong></span><span style="font-family:monospace">RET-00042</span></div>
          <div style="display:flex;justify-content:space-between;padding:3px 0;font-size:13px;color:#92400e"><span><strong>Order:</strong></span><span>#1234</span></div>
          <div style="display:flex;justify-content:space-between;padding:3px 0;font-size:13px;color:#92400e"><span><strong>Items:</strong></span><span>2 item(s)</span></div>
        </div>
      </div>`,
    },
  };

  return (
    <s-page fullWidth heading="Notifications">
      <div className="app-content layout-medium">
        {saved && (
          <div className="app-alert app-alert-success" style={{ marginBottom: 20 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
            <span>Notification settings saved successfully.</span>
          </div>
        )}
        {saveFetcher.data && saveFetcher.data.success === false && (
          <div className="app-alert app-alert-error" style={{ marginBottom: 20 }}>
            {(saveFetcher.data as { error?: string }).error || "Failed to save notification settings."}
          </div>
        )}

        <saveFetcher.Form method="post">
          <input type="hidden" name="intent" value="save" />

          {/* ────── SMTP Configuration ────── */}
          <div style={{
            background: "var(--rpm-surface)", border: "var(--rpm-border)", borderRadius: "var(--rpm-radius-lg)",
            padding: "24px 28px", marginBottom: 20,
          }}>
            <SectionHeader
              icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>}
              title="Email Server (SMTP)"
              subtitle="Configure your SMTP server to send email notifications directly from your domain."
              badge={smtpFilled ? (
                <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 12, background: data.smtpConfigured ? "#ECFDF5" : "#FEF3C7", color: data.smtpConfigured ? "#059669" : "#D97706" }}>
                  {data.smtpConfigured ? "Connected" : "Unsaved"}
                </span>
              ) : undefined}
            />

            <div style={{
              background: "var(--rpm-surface-subtle)", border: "1px solid var(--rpm-border-color)",
              borderRadius: "var(--rpm-radius)", padding: "14px 16px", marginBottom: 20, fontSize: 13, color: "var(--rpm-text-muted)", lineHeight: 1.6,
            }}>
              <strong style={{ color: "var(--rpm-text-secondary)" }}>Common SMTP providers:</strong> Gmail (smtp.gmail.com:587), Outlook (smtp-mail.outlook.com:587), SendGrid (smtp.sendgrid.net:587), AWS SES, or any custom SMTP server.
              For Gmail, use an App Password instead of your regular password.
            </div>

            <div style={{ display: "flex", flexWrap: "wrap", gap: 14 }}>
              <Field label="SMTP Host" name="smtpHost" value={smtpHost} onChange={setSmtpHost} placeholder="smtp.gmail.com" required half />
              <Field label="Port" name="smtpPort" value={smtpPort} onChange={setSmtpPort} type="number" placeholder="587" half />
              <Field label="Username / Email" name="smtpUser" value={smtpUser} onChange={setSmtpUser} placeholder="your@email.com" required half />
              <Field label="Password / App Password" name="smtpPass" value={smtpPass} onChange={setSmtpPass} type="password" placeholder="App password or SMTP key" required half />
              <Field label="From Email" name="smtpFromEmail" value={smtpFromEmail} onChange={setSmtpFromEmail} placeholder="returns@yourstore.com" half helpText="Defaults to username if empty" />
              <Field label="From Name" name="smtpFromName" value={smtpFromName} onChange={setSmtpFromName} placeholder="Your Store Returns" half helpText='Shows as "From Name" in emails' />
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 16 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 13, color: "var(--rpm-text-secondary)" }}>
                <input type="checkbox" name="smtpSecure" checked={smtpSecure} onChange={e => setSmtpSecure(e.target.checked)}
                  style={{ width: 16, height: 16, borderRadius: 4, accentColor: "var(--rpm-accent)" }} />
                Use SSL/TLS (port 465)
              </label>

              <div style={{ flex: 1 }} />

              <button type="button" onClick={handleTestSmtp} disabled={!smtpFilled || testFetcher.state !== "idle"}
                style={{
                  padding: "8px 16px", fontSize: 13, fontWeight: 600, borderRadius: "var(--rpm-radius-sm)",
                  border: "var(--rpm-border-strong)", background: "var(--rpm-surface)", color: "var(--rpm-text-secondary)",
                  cursor: smtpFilled ? "pointer" : "not-allowed", opacity: smtpFilled ? 1 : 0.5,
                  display: "flex", alignItems: "center", gap: 6, transition: "var(--rpm-transition)",
                }}>
                {testFetcher.state !== "idle" ? (
                  <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: "spin 1s linear infinite" }}><path d="M21 12a9 9 0 11-6.219-8.56"/></svg> Testing...</>
                ) : (
                  <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 2L11 13"/><path d="M22 2l-7 20-4-9-9-4 20-7z"/></svg> Test connection</>
                )}
              </button>
            </div>

            {testResult && (
              <div style={{
                marginTop: 12, padding: "10px 14px", borderRadius: "var(--rpm-radius-sm)", fontSize: 13, fontWeight: 500,
                background: testResult.success ? "#ECFDF5" : "#FEF2F2",
                color: testResult.success ? "#065F46" : "#991B1B",
                border: `1px solid ${testResult.success ? "#A7F3D0" : "#FECACA"}`,
              }}>
                {testResult.success ? "SMTP connection successful — emails are ready to send." : `Connection failed: ${testResult.error}`}
              </div>
            )}
          </div>

          {/* ────── Notification Events ────── */}
          <div style={{
            background: "var(--rpm-surface)", border: "var(--rpm-border)", borderRadius: "var(--rpm-radius-lg)",
            padding: "24px 28px", marginBottom: 20,
          }}>
            <SectionHeader
              icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/></svg>}
              title="Email Notifications"
              subtitle="Choose which events trigger email notifications. Emails are sent via your SMTP server."
            />

            <div style={{ display: "grid", gap: 10 }}>
              <Toggle name="notificationNewReturn" checked={newReturn} onChange={setNewReturn} accentColor="#D97706"
                icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>}
                label="New return request"
                description="Notify admin when a customer submits a new return request through the portal."
              />
              <Toggle name="notificationApproved" checked={approved} onChange={setApproved} accentColor="#059669"
                icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>}
                label="Return approved"
                description="Notify the customer when their return has been approved and is being processed."
              />
              <Toggle name="notificationRejected" checked={rejected} onChange={setRejected} accentColor="#DC2626"
                icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>}
                label="Return rejected"
                description="Notify the customer when their return has been declined, including the reason."
              />
              <Toggle name="notificationRefunded" checked={refunded} onChange={setRefunded} accentColor="#7C3AED"
                icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 000 7h5a3.5 3.5 0 010 7H6"/></svg>}
                label="Refund processed"
                description="Notify the customer when their refund has been processed and funds are on the way."
              />
            </div>
          </div>

          {/* ────── Admin & Sound ────── */}
          <div style={{
            background: "var(--rpm-surface)", border: "var(--rpm-border)", borderRadius: "var(--rpm-radius-lg)",
            padding: "24px 28px", marginBottom: 20,
          }}>
            <SectionHeader
              icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M19.07 4.93a10 10 0 010 14.14"/><path d="M15.54 8.46a5 5 0 010 7.07"/></svg>}
              title="Admin Alerts"
              subtitle="Configure how you receive notifications as an admin."
            />

            <div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginBottom: 18 }}>
              <Field
                label="Admin notification email"
                name="adminNotifyEmail"
                value={adminEmail}
                onChange={setAdminEmail}
                placeholder="admin@yourstore.com"
                helpText="Receives new return request alerts. Leave empty to use the Shopify store owner email."
              />
            </div>

            <div style={{
              display: "flex", alignItems: "center", gap: 14, padding: "14px 18px",
              background: adminSound ? "#FFF7ED" : "var(--rpm-surface)",
              border: `1px solid ${adminSound ? "#FDBA7433" : "var(--rpm-border-color)"}`,
              borderRadius: "var(--rpm-radius)", transition: "var(--rpm-transition)",
            }}>
              <div style={{
                flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center",
                width: 38, height: 38, borderRadius: "var(--rpm-radius-sm)",
                background: adminSound ? "#FDBA7420" : "var(--rpm-surface-elevated)",
                color: adminSound ? "#EA580C" : "var(--rpm-text-muted)",
              }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 01-3.46 0"/>
                  {adminSound && <line x1="12" y1="2" x2="12" y2="4"/>}
                </svg>
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14, color: "var(--rpm-text)", marginBottom: 2 }}>Sound alerts</div>
                <div style={{ fontSize: 12, color: "var(--rpm-text-muted)", lineHeight: 1.5 }}>Play a notification sound when new returns arrive in the admin panel.</div>
              </div>
              <button type="button" onClick={playTestSound}
                style={{
                  padding: "6px 12px", fontSize: 12, fontWeight: 600, borderRadius: "var(--rpm-radius-sm)",
                  border: "var(--rpm-border)", background: "var(--rpm-surface)", color: "var(--rpm-text-muted)",
                  cursor: "pointer", marginRight: 10, transition: "var(--rpm-transition)",
                }}>
                Preview
              </button>
              <label style={{ position: "relative", display: "inline-block", width: 44, height: 24, flexShrink: 0, cursor: "pointer" }}>
                <input type="checkbox" name="adminSoundEnabled" checked={adminSound} onChange={e => setAdminSound(e.target.checked)}
                  style={{ position: "absolute", opacity: 0, width: 0, height: 0 }} />
                <span style={{
                  position: "absolute", inset: 0, borderRadius: 12, transition: "var(--rpm-transition)",
                  background: adminSound ? "#EA580C" : "#cbd5e1",
                }}>
                  <span style={{
                    position: "absolute", top: 2, left: adminSound ? 22 : 2, width: 20, height: 20,
                    borderRadius: "50%", background: "#fff", transition: "var(--rpm-transition)",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
                  }} />
                </span>
              </label>
            </div>
          </div>

          {/* ────── Email Template Preview ────── */}
          <div style={{
            background: "var(--rpm-surface)", border: "var(--rpm-border)", borderRadius: "var(--rpm-radius-lg)",
            padding: "24px 28px", marginBottom: 24,
          }}>
            <SectionHeader
              icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/></svg>}
              title="Default Email Previews"
              subtitle="Preview the built-in email templates that are sent for each notification event."
            />

            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
              {Object.entries(previewTemplates).map(([key, t]) => (
                <button key={key} type="button" onClick={() => setPreviewTemplate(previewTemplate === key ? null : key)}
                  style={{
                    padding: "7px 14px", fontSize: 12, fontWeight: 600, borderRadius: "var(--rpm-radius-full)",
                    border: previewTemplate === key ? `2px solid ${t.color}` : "var(--rpm-border)",
                    background: previewTemplate === key ? t.color + "10" : "var(--rpm-surface)",
                    color: previewTemplate === key ? t.color : "var(--rpm-text-muted)",
                    cursor: "pointer", transition: "var(--rpm-transition)",
                  }}>
                  {t.label}
                </button>
              ))}
            </div>

            {previewTemplate && previewTemplates[previewTemplate] && (
              <div style={{
                border: `2px solid ${previewTemplates[previewTemplate].color}22`,
                borderRadius: "var(--rpm-radius)", overflow: "hidden",
                background: "#f4f6f8",
              }}>
                <div style={{ padding: "8px 14px", background: previewTemplates[previewTemplate].color + "10", borderBottom: `1px solid ${previewTemplates[previewTemplate].color}22`, display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: previewTemplates[previewTemplate].color }} />
                  <span style={{ fontSize: 12, fontWeight: 600, color: previewTemplates[previewTemplate].color }}>{previewTemplates[previewTemplate].label}</span>
                  <span style={{ fontSize: 11, color: "var(--rpm-text-muted)", marginLeft: "auto" }}>Preview</span>
                </div>
                <div style={{ background: "#ffffff", margin: 16, borderRadius: "var(--rpm-radius-sm)", boxShadow: "var(--rpm-shadow-sm)", overflow: "hidden" }}>
                  <div style={{ height: 3, background: previewTemplates[previewTemplate].color }} />
                  <div dangerouslySetInnerHTML={{ __html: previewTemplates[previewTemplate].preview }} />
                  <div style={{ padding: "12px 24px", borderTop: "1px solid #e5e7eb", fontSize: 11, color: "#94a3b8" }}>
                    Powered by Fynd Returns
                  </div>
                </div>
              </div>
            )}

            {!previewTemplate && (
              <div style={{ textAlign: "center", padding: "24px 0", color: "var(--rpm-text-subtle)", fontSize: 13 }}>
                Click a template above to preview
              </div>
            )}
          </div>

          {/* ────── Customizable Email Templates ────── */}
          <div style={{
            background: "var(--rpm-surface)", border: "var(--rpm-border)", borderRadius: "var(--rpm-radius-lg)",
            padding: "24px 28px", marginBottom: 24,
          }}>
            <SectionHeader
              icon={<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>}
              title="Email Templates"
              subtitle="Customize the subject and body HTML for each notification event. Custom templates override the built-in defaults."
            />

            {templatesSaved && (
              <div className="app-alert app-alert-success" style={{ marginBottom: 16 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#059669" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                <span>Email templates saved.</span>
              </div>
            )}

            <div style={{ display: "grid", gap: 12 }}>
              {TEMPLATE_EVENTS.map((evt) => {
                const hasCustom = !!emailTemplates[evt.key];
                const isEditing = editingTemplate === evt.key;

                return (
                  <div key={evt.key} style={{
                    border: isEditing ? `2px solid ${evt.color}44` : "var(--rpm-border)",
                    borderRadius: "var(--rpm-radius)", overflow: "hidden",
                    transition: "var(--rpm-transition)",
                  }}>
                    <div style={{
                      display: "flex", alignItems: "center", gap: 12, padding: "14px 18px",
                      background: isEditing ? evt.color + "08" : "var(--rpm-surface-subtle)",
                    }}>
                      <div style={{
                        width: 10, height: 10, borderRadius: "50%", background: evt.color, flexShrink: 0,
                      }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <span style={{ fontWeight: 600, fontSize: 14, color: "var(--rpm-text)" }}>{evt.label}</span>
                        {hasCustom && (
                          <span style={{
                            marginLeft: 8, fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 8,
                            background: evt.color + "18", color: evt.color, textTransform: "uppercase",
                          }}>Customized</span>
                        )}
                      </div>
                      {!isEditing && (
                        <button type="button" onClick={() => startEditing(evt.key)}
                          style={{
                            padding: "6px 14px", fontSize: 12, fontWeight: 600, borderRadius: "var(--rpm-radius-sm)",
                            border: "var(--rpm-border)", background: "var(--rpm-surface)", color: "var(--rpm-text-secondary)",
                            cursor: "pointer", transition: "var(--rpm-transition)",
                          }}>
                          Customize
                        </button>
                      )}
                    </div>

                    {isEditing && (
                      <div style={{ padding: "16px 18px", background: "var(--rpm-surface)" }}>
                        <div style={{ marginBottom: 14 }}>
                          <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--rpm-text-secondary)", marginBottom: 5 }}>Subject line</label>
                          <input
                            type="text" value={templateSubject} onChange={(e) => setTemplateSubject(e.target.value)}
                            placeholder={evt.defaultSubject}
                            style={{
                              width: "100%", padding: "9px 12px", fontSize: 14, borderRadius: "var(--rpm-radius-sm)",
                              border: "var(--rpm-border)", background: "var(--rpm-surface)", color: "var(--rpm-text)",
                              outline: "none", boxSizing: "border-box",
                            }}
                          />
                        </div>

                        <div style={{ marginBottom: 10 }}>
                          <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--rpm-text-secondary)", marginBottom: 5 }}>
                            Body HTML
                          </label>
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                            <span style={{ fontSize: 11, color: "var(--rpm-text-muted)", lineHeight: "28px" }}>Insert variable:</span>
                            {TEMPLATE_VARS.map((v) => (
                              <button key={v.key} type="button" onClick={() => insertVariable(v.key)}
                                style={{
                                  padding: "4px 10px", fontSize: 11, fontWeight: 600, borderRadius: 14,
                                  border: "1px solid var(--rpm-border-color)", background: "var(--rpm-surface-elevated)",
                                  color: evt.color, cursor: "pointer", transition: "var(--rpm-transition)",
                                  display: "inline-flex", alignItems: "center", gap: 4,
                                }}>
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                                {`{{${v.key}}}`}
                              </button>
                            ))}
                          </div>
                          {!showTemplatePreview ? (
                            <textarea
                              ref={templateBodyRef}
                              value={templateBody} onChange={(e) => setTemplateBody(e.target.value)}
                              placeholder={evt.defaultBody}
                              rows={10}
                              style={{
                                width: "100%", padding: "10px 12px", fontSize: 13, borderRadius: "var(--rpm-radius-sm)",
                                border: "var(--rpm-border)", background: "var(--rpm-surface)", color: "var(--rpm-text)",
                                outline: "none", boxSizing: "border-box", fontFamily: "var(--rpm-font-mono)",
                                resize: "vertical", lineHeight: 1.6,
                              }}
                            />
                          ) : (
                            <iframe
                              sandbox=""
                              srcDoc={templateBody}
                              title="Template preview"
                              style={{
                                width: "100%", minHeight: 160, border: "var(--rpm-border)", borderRadius: "var(--rpm-radius-sm)",
                                background: "#fff",
                              }}
                            />
                          )}
                        </div>

                        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <button type="button" onClick={() => setShowTemplatePreview(!showTemplatePreview)}
                            style={{
                              padding: "6px 14px", fontSize: 12, fontWeight: 600, borderRadius: "var(--rpm-radius-sm)",
                              border: "var(--rpm-border)", background: "var(--rpm-surface-elevated)", color: "var(--rpm-text-secondary)",
                              cursor: "pointer", display: "flex", alignItems: "center", gap: 5,
                            }}>
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              {showTemplatePreview
                                ? <><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z"/></>
                                : <><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></>
                              }
                            </svg>
                            {showTemplatePreview ? "Edit" : "Preview"}
                          </button>

                          <div style={{ flex: 1 }} />

                          <button type="button" onClick={() => resetTemplate(evt.key)}
                            style={{
                              padding: "6px 14px", fontSize: 12, fontWeight: 600, borderRadius: "var(--rpm-radius-sm)",
                              border: "1px solid #FECACA", background: "#FEF2F2", color: "#DC2626",
                              cursor: "pointer",
                            }}>
                            Reset to Default
                          </button>
                          <button type="button" onClick={() => setEditingTemplate(null)}
                            style={{
                              padding: "6px 14px", fontSize: 12, fontWeight: 600, borderRadius: "var(--rpm-radius-sm)",
                              border: "var(--rpm-border)", background: "var(--rpm-surface)", color: "var(--rpm-text-muted)",
                              cursor: "pointer",
                            }}>
                            Cancel
                          </button>
                          <button type="button" onClick={() => saveTemplate(evt.key)}
                            disabled={templateFetcher.state !== "idle"}
                            style={{
                              padding: "6px 16px", fontSize: 12, fontWeight: 700, borderRadius: "var(--rpm-radius-sm)",
                              border: "none", background: evt.color, color: "#fff",
                              cursor: "pointer", opacity: templateFetcher.state !== "idle" ? 0.7 : 1,
                            }}>
                            {templateFetcher.state !== "idle" ? "Saving..." : "Save Template"}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* ────── WhatsApp / SMS Notifications ────── */}
          <div style={{ background: "var(--rpm-surface)", border: "var(--rpm-border)", borderRadius: "var(--rpm-radius)", padding: "20px 24px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 2 }}>WhatsApp Notifications</div>
                <div style={{ fontSize: 12, color: "var(--rpm-text-muted)" }}>Send real-time WhatsApp messages to customers on key events</div>
              </div>
              <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}>
                <input type="checkbox" name="whatsappEnabled" checked={waEnabled} onChange={e => setWaEnabled(e.target.checked)} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>{waEnabled ? "Enabled" : "Disabled"}</span>
              </label>
            </div>
            {waEnabled && (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "var(--rpm-text-muted)", display: "block", marginBottom: 4 }}>Provider</label>
                  <select name="whatsappProvider" value={waProvider} onChange={e => setWaProvider(e.target.value)}
                    style={{ width: "100%", maxWidth: 280, padding: "8px 10px", borderRadius: "var(--rpm-radius-sm)", border: "var(--rpm-border)", fontSize: 13 }}>
                    <option value="meta_cloud">Meta Cloud API (Official)</option>
                    <option value="twilio">Twilio</option>
                    <option value="wati">WATI</option>
                    <option value="interakt">Interakt</option>
                  </select>
                </div>
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "var(--rpm-text-muted)", display: "block", marginBottom: 4 }}>API Key / Access Token <span style={{ color: "#d72c0d" }}>*</span></label>
                  <input type="password" name="whatsappApiKey" value={waApiKey} onChange={e => setWaApiKey(e.target.value)}
                    placeholder="Your WhatsApp API key or bearer token"
                    style={{ width: "100%", padding: "8px 10px", borderRadius: "var(--rpm-radius-sm)", border: "var(--rpm-border)", fontSize: 13, boxSizing: "border-box" }} />
                </div>
                {waProvider === "meta_cloud" && (
                  <div>
                    <label style={{ fontSize: 12, fontWeight: 600, color: "var(--rpm-text-muted)", display: "block", marginBottom: 4 }}>Phone Number ID <span style={{ color: "#d72c0d" }}>*</span></label>
                    <input type="text" name="whatsappPhoneNumberId" value={waPhoneNumberId} onChange={e => setWaPhoneNumberId(e.target.value)}
                      placeholder="e.g. 1234567890123456"
                      style={{ width: "100%", padding: "8px 10px", borderRadius: "var(--rpm-radius-sm)", border: "var(--rpm-border)", fontSize: 13, boxSizing: "border-box" }} />
                    <div style={{ fontSize: 11, color: "var(--rpm-text-muted)", marginTop: 3 }}>Found in Meta Business Suite → WhatsApp → Phone numbers</div>
                  </div>
                )}
                <div>
                  <label style={{ fontSize: 12, fontWeight: 600, color: "var(--rpm-text-muted)", display: "block", marginBottom: 4 }}>From Number (E.164)</label>
                  <input type="text" name="whatsappFromNumber" value={waFromNumber} onChange={e => setWaFromNumber(e.target.value)}
                    placeholder="+911234567890"
                    style={{ width: "100%", maxWidth: 220, padding: "8px 10px", borderRadius: "var(--rpm-radius-sm)", border: "var(--rpm-border)", fontSize: 13, boxSizing: "border-box" }} />
                </div>
                <div style={{ padding: "10px 14px", background: "#EFF6FF", borderRadius: "var(--rpm-radius-sm)", fontSize: 12, color: "#1E40AF" }}>
                  WhatsApp messages will be sent to the customer's phone number on: return approved, rejected, and refunded events.
                </div>
              </div>
            )}
            {!waEnabled && (
              <div style={{ display: "none" }}>
                <input type="hidden" name="whatsappProvider" value={waProvider} />
                <input type="hidden" name="whatsappApiKey" value={waApiKey} />
                <input type="hidden" name="whatsappPhoneNumberId" value={waPhoneNumberId} />
                <input type="hidden" name="whatsappFromNumber" value={waFromNumber} />
              </div>
            )}
          </div>

          {/* ────── Portal Verification (OTP) ────── */}
          <div style={{ background: "var(--rpm-surface)", border: "var(--rpm-border)", borderRadius: "var(--rpm-radius)", padding: "20px 24px" }}>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 2 }}>Portal Verification (OTP)</div>
              <div style={{ fontSize: 12, color: "var(--rpm-text-muted)" }}>Require customers to verify their identity via a one-time code before viewing return results on the portal</div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <Toggle
                name="portalOtpEmailEnabled"
                checked={otpEmailEnabled}
                onChange={setOtpEmailEnabled}
                label="Email OTP verification"
                description="Send a 6-digit code to the customer's email before showing return results for email lookups"
                accentColor="#6366f1"
                icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="4" width="20" height="16" rx="2"/><polyline points="22,7 12,13 2,7"/></svg>}
              />
              <Toggle
                name="portalOtpSmsEnabled"
                checked={otpSmsEnabled}
                onChange={setOtpSmsEnabled}
                label="SMS / WhatsApp OTP verification"
                description="Send a 6-digit code via SMS or WhatsApp before showing return results for phone lookups (requires WhatsApp to be configured above)"
                accentColor="#10b981"
                icon={<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07 19.5 19.5 0 01-6-6 19.79 19.79 0 01-3.07-8.67A2 2 0 014.11 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L8.09 9.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>}
              />
            </div>
            <div style={{ marginTop: 12, padding: "10px 14px", background: "#FFF7ED", borderRadius: "var(--rpm-radius-sm)", fontSize: 12, color: "#92400E", lineHeight: 1.6 }}>
              When disabled, customers can look up returns directly without verification. Enable OTP for added security — especially recommended for email and phone lookups.
            </div>
          </div>

          {/* ────── Actions ────── */}
          <div style={{ display: "flex", gap: 10, justifyContent: "flex-start" }}>
            <s-button type="submit" loading={saveFetcher.state !== "idle"}>Save all settings</s-button>
            <Link to="/app/settings"><s-button variant="secondary" type="button">Discard</s-button></Link>
          </div>
        </saveFetcher.Form>

        {/* ────── Notification Log ────── */}
        <div style={{ background: "var(--rpm-surface)", border: "var(--rpm-border)", borderRadius: "var(--rpm-radius)", padding: "20px 24px", marginTop: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>Notification Log</div>
          <div style={{ fontSize: 12, color: "var(--rpm-text-muted)", marginBottom: 14 }}>Recent email and WhatsApp notifications sent from this shop</div>
          {data.notificationLogs.length === 0 ? (
            <div style={{ padding: "24px 0", textAlign: "center", color: "var(--rpm-text-muted)", fontSize: 13 }}>
              No notifications sent yet.
            </div>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr style={{ borderBottom: "2px solid var(--rpm-border-color, #e5e7eb)" }}>
                    <th style={{ textAlign: "left", padding: "8px 10px", fontWeight: 700, color: "var(--rpm-text-muted)", textTransform: "uppercase", fontSize: 10, letterSpacing: "0.04em" }}>Time</th>
                    <th style={{ textAlign: "left", padding: "8px 10px", fontWeight: 700, color: "var(--rpm-text-muted)", textTransform: "uppercase", fontSize: 10, letterSpacing: "0.04em" }}>Channel</th>
                    <th style={{ textAlign: "left", padding: "8px 10px", fontWeight: 700, color: "var(--rpm-text-muted)", textTransform: "uppercase", fontSize: 10, letterSpacing: "0.04em" }}>Event</th>
                    <th style={{ textAlign: "left", padding: "8px 10px", fontWeight: 700, color: "var(--rpm-text-muted)", textTransform: "uppercase", fontSize: 10, letterSpacing: "0.04em" }}>Recipient</th>
                    <th style={{ textAlign: "left", padding: "8px 10px", fontWeight: 700, color: "var(--rpm-text-muted)", textTransform: "uppercase", fontSize: 10, letterSpacing: "0.04em" }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.notificationLogs.map((log) => (
                    <tr key={log.id} style={{ borderBottom: "1px solid var(--rpm-border-color, #f1f5f9)" }}>
                      <td style={{ padding: "8px 10px", whiteSpace: "nowrap", color: "var(--rpm-text-muted)" }}>
                        {/* Use the runtime default locale instead of forcing "en" so admins
                            in non-English environments see dates in a familiar format. */}
                        {new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(log.createdAt))}
                      </td>
                      <td style={{ padding: "8px 10px" }}>
                        <span style={{
                          padding: "2px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, textTransform: "uppercase",
                          background: log.channel === "email" ? "#DBEAFE" : log.channel === "whatsapp" ? "#D1FAE5" : "#F3F4F6",
                          color: log.channel === "email" ? "#1D4ED8" : log.channel === "whatsapp" ? "#059669" : "#374151",
                        }}>{log.channel}</span>
                      </td>
                      <td style={{ padding: "8px 10px", textTransform: "capitalize" }}>{log.eventType.replace(/_/g, " ")}</td>
                      <td style={{ padding: "8px 10px", fontFamily: "var(--rpm-font-mono)", color: "var(--rpm-text-muted)" }}>{log.recipient}</td>
                      <td style={{ padding: "8px 10px" }}>
                        {log.status === "sent" ? (
                          <span style={{ color: "#059669", fontWeight: 600 }}>Sent</span>
                        ) : (
                          <span style={{ color: "#DC2626", fontWeight: 600 }} title={log.error || undefined}>Failed</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </s-page>
  );
}
