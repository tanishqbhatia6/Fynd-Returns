/**
 * Customer notification service - sends email when return is rejected
 */
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const NOTIFICATION_FROM = process.env.NOTIFICATION_FROM_EMAIL ?? "returns@resend.dev";

export async function sendRejectionNotification(params: {
  to: string;
  orderName: string;
  rejectionReason: string;
  shopName?: string;
}): Promise<{ success: boolean; error?: string }> {
  if (!RESEND_API_KEY) {
    console.warn("[Notification] RESEND_API_KEY not set - skipping rejection email");
    return { success: true };
  }

  const { to, orderName, rejectionReason, shopName } = params;
  if (!to || !rejectionReason) {
    return { success: false, error: "Missing recipient or rejection reason" };
  }

  const subject = `Your return request for ${orderName} has been declined`;
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Return Declined</title></head>
<body style="font-family: system-ui, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #d72c0d; margin-bottom: 16px;">Return Request Declined</h2>
  <p>Your return request for order <strong>${escapeHtml(orderName)}</strong> has been declined.</p>
  <div style="background: #fef2f2; border: 1px solid #fecaca; border-radius: 8px; padding: 16px; margin: 20px 0;">
    <p style="margin: 0; font-weight: 600;">Reason:</p>
    <p style="margin: 8px 0 0 0;">${escapeHtml(rejectionReason)}</p>
  </div>
  ${shopName ? `<p style="color: #6d7175; font-size: 14px;">If you have questions, please contact ${escapeHtml(shopName)}.</p>` : ""}
</body>
</html>
`;

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: NOTIFICATION_FROM,
        to: [to],
        subject,
        html,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error("[Notification] Resend error:", res.status, errText);
      return { success: false, error: `Email failed: ${res.status}` };
    }
    return { success: true };
  } catch (err) {
    console.error("[Notification] Send error:", err);
    return { success: false, error: err instanceof Error ? err.message : "Failed to send" };
  }
}

export async function sendApprovalNotification(params: {
  to: string;
  orderName: string;
  shopName?: string;
  notes?: string;
}): Promise<{ success: boolean; error?: string }> {
  if (!RESEND_API_KEY) return { success: true };
  const { to, orderName, shopName, notes } = params;
  if (!to) return { success: false };

  const subject = `Your return request for ${orderName} has been approved`;
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Return Approved</title></head>
<body style="font-family: system-ui, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #059669; margin-bottom: 16px;">Return Request Approved</h2>
  <p>Your return request for order <strong>${escapeHtml(orderName)}</strong> has been approved.</p>
  ${notes ? `<div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 20px 0;"><p style="margin: 0; font-weight: 600;">Message from store:</p><p style="margin: 8px 0 0 0;">${escapeHtml(notes)}</p></div>` : ""}
  ${shopName ? `<p style="color: #6d7175; font-size: 14px;">If you have questions, please contact ${escapeHtml(shopName)}.</p>` : ""}
</body>
</html>
`;
  return sendRawEmail(to, subject, html);
}

export async function sendRefundNotification(params: {
  to: string;
  orderName: string;
  shopName?: string;
}): Promise<{ success: boolean; error?: string }> {
  if (!RESEND_API_KEY) return { success: true };
  const { to, orderName, shopName } = params;
  if (!to) return { success: false };

  const subject = `Your refund for ${orderName} has been processed`;
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Refund Processed</title></head>
<body style="font-family: system-ui, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #005bd3; margin-bottom: 16px;">Refund Processed</h2>
  <p>We've processed the refund for your return on order <strong>${escapeHtml(orderName)}</strong>.</p>
  <p>Please note that it may take a few business days for the funds to appear on your original payment method depending on your bank.</p>
  ${shopName ? `<p style="color: #6d7175; font-size: 14px;">If you have questions, please contact ${escapeHtml(shopName)}.</p>` : ""}
</body>
</html>
`;
  return sendRawEmail(to, subject, html);
}

export async function sendNewReturnNotification(params: {
  to: string;
  orderName: string;
  customerEmail?: string;
  itemCount: number;
  returnRequestId: string;
  shopName?: string;
}): Promise<{ success: boolean; error?: string }> {
  if (!RESEND_API_KEY) return { success: true };
  const { to, orderName, customerEmail, itemCount, returnRequestId, shopName } = params;
  if (!to) return { success: false };

  const subject = `New return request ${returnRequestId} for ${orderName}`;
  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>New Return Request</title></head>
<body style="font-family: system-ui, sans-serif; line-height: 1.6; color: #1a1a1a; max-width: 560px; margin: 0 auto; padding: 24px;">
  <h2 style="color: #d97706; margin-bottom: 16px;">New Return Request</h2>
  <p>A customer has submitted a return request that needs your attention.</p>
  <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 16px; margin: 20px 0;">
    <p style="margin: 0;"><strong>Request ID:</strong> ${escapeHtml(returnRequestId)}</p>
    <p style="margin: 8px 0 0 0;"><strong>Order:</strong> ${escapeHtml(orderName)}</p>
    ${customerEmail ? `<p style="margin: 8px 0 0 0;"><strong>Customer:</strong> ${escapeHtml(customerEmail)}</p>` : ""}
    <p style="margin: 8px 0 0 0;"><strong>Items:</strong> ${itemCount} item(s)</p>
  </div>
  <p>Log in to Return Pro Max to review and approve or reject this request.</p>
  ${shopName ? `<p style="color: #6d7175; font-size: 14px;">— ${escapeHtml(shopName)}</p>` : ""}
</body>
</html>
`;
  return sendRawEmail(to, subject, html);
}

async function sendRawEmail(to: string, subject: string, html: string) {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${RESEND_API_KEY}`,
      },
      body: JSON.stringify({
        from: NOTIFICATION_FROM,
        to: [to],
        subject,
        html,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      return { success: false, error: `Email failed: ${res.status}` };
    }
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
