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
    });

    if (!res.ok) {
      const err = await res.text();
      console.error("[Notification] Resend error:", res.status, err);
      return { success: false, error: `Email failed: ${res.status}` };
    }
    return { success: true };
  } catch (err) {
    console.error("[Notification] Send error:", err);
    return { success: false, error: err instanceof Error ? err.message : "Failed to send" };
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
