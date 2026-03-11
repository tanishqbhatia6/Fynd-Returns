# 10 — Notifications

> Email (SMTP), WhatsApp, and admin alert notifications for return lifecycle events.

---

## Overview

ReturnProMax sends notifications across the return lifecycle via:

1. **Email** (SMTP) -- Customer-facing and admin alerts
2. **WhatsApp** -- Customer-facing messages via Meta Cloud API (or other providers)
3. **Admin Sound** -- In-app audio notification for new returns

All notification logic lives in `app/lib/notification.server.ts`. Every send attempt is logged to the `NotificationLog` table for audit and debugging.

---

## SMTP Setup

### Configuration Fields

| Setting         | Type       | Default       | Description                                         |
|-----------------|------------|---------------|-----------------------------------------------------|
| `smtpHost`      | `String`   | --            | SMTP server hostname (e.g., `smtp.gmail.com`)       |
| `smtpPort`      | `Int`      | `587`         | Port: 587 (STARTTLS), 465 (SSL), 25 (plain)        |
| `smtpSecure`    | `Boolean`  | `false`       | `true` for SSL/TLS (port 465), `false` for STARTTLS |
| `smtpUser`      | `String`   | --            | Username (usually email address)                    |
| `smtpPass`      | `String`   | --            | Password or app-specific password                   |
| `smtpFromEmail` | `String?`  | `= smtpUser`  | "From" email address                                |
| `smtpFromName`  | `String?`  | `Fynd Returns` | "From" display name                                |

### Connection Timeouts

| Timeout            | Value   |
|--------------------|---------|
| Connection timeout | 10,000 ms |
| Greeting timeout   | 10,000 ms |
| Socket timeout     | 15,000 ms |

### Test Connection

```typescript
import { testSmtpConnection } from "~/lib/notification.server";

const result = await testSmtpConnection({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  user: "you@gmail.com",
  pass: "app-password",
});
// result: { success: true } or { success: false, error: "..." }
```

Uses `nodemailer.createTransport().verify()` to test credentials without sending.

### Common SMTP Providers

| Provider     | Host                  | Port | Secure | Notes                              |
|--------------|-----------------------|------|--------|------------------------------------|
| Gmail        | `smtp.gmail.com`      | 587  | false  | Requires App Password (2FA)        |
| Outlook      | `smtp.office365.com`  | 587  | false  | Requires App Password              |
| SendGrid     | `smtp.sendgrid.net`   | 587  | false  | Username: `apikey`, password: key  |
| Amazon SES   | `email-smtp.{region}.amazonaws.com` | 587 | false | IAM SMTP credentials       |
| Zoho Mail    | `smtp.zoho.com`       | 587  | false  | Requires App Password              |

---

## Email Templates

### Built-in Templates

ReturnProMax ships with 5 built-in email templates, each with responsive HTML layout and i18n support:

| Event          | Accent Color | Recipient     | Description                              |
|----------------|-------------|---------------|------------------------------------------|
| `new_return`   | `#D97706` (amber) | Admin    | New return request submitted             |
| `approved`     | `#059669` (green) | Customer | Return approved with optional notes      |
| `rejected`     | `#DC2626` (red)   | Customer | Return declined with reason              |
| `refunded`     | `#7C3AED` (purple)| Customer | Refund processed with amount             |
| `otp`          | `#3B82F6` (blue)  | Customer | Verification code for portal lookup      |

Additionally, a `custom_note` template is used when admins send notes to customers.

### Template HTML Structure

All email templates use a shared layout with:
- Responsive `<table>` structure (max-width 560px)
- 4px accent color bar at top
- RTL support via `dir="rtl"` when locale is Arabic, Hebrew, Farsi, or Urdu
- Shop name in footer
- "Powered by Fynd Returns" footer text (customizable via i18n labels)

### Custom Templates

Merchants can override any built-in template via `emailTemplatesJson`:

```json
{
  "new_return": {
    "subject": "New return #{{returnId}} for order {{orderName}}",
    "bodyHtml": "<h1>New Return</h1><p>Order: {{orderName}}</p><p>Customer: {{customerEmail}}</p>"
  },
  "approved": {
    "subject": "Return approved for {{orderName}}",
    "bodyHtml": "<p>Your return has been approved!</p>"
  }
}
```

### Template Variables

All custom templates support these `{{variable}}` placeholders:

| Variable           | Description                              | Available In              |
|--------------------|------------------------------------------|---------------------------|
| `{{orderName}}`    | Shopify order name (e.g., `#1001`)       | All templates             |
| `{{customerEmail}}`| Customer email address                   | All templates             |
| `{{shopName}}`     | Shop display name                        | All templates             |
| `{{returnId}}`     | Return request ID (e.g., `RPM-A1B2C3D4`) | All templates            |
| `{{status}}`       | Current return status                    | All templates             |
| `{{refundAmount}}` | Formatted refund amount with currency    | `refunded` template       |
| `{{rejectionReason}}`| Reason for rejection                   | `rejected` template       |

Variables are HTML-escaped to prevent XSS. Unknown variables render as empty strings.

---

## i18n Support

Email templates are fully internationalized using the same i18n system as the customer portal.

### How It Works

1. The shop's `portalLanguage` (or `shopLocale`) determines the base language.
2. Built-in labels are loaded from `portal-i18n.ts` for the matching language.
3. Merchant label overrides from `portalLabelsJson` are merged on top.
4. The `t()` function resolves keys with `{placeholder}` interpolation.

### i18n Keys Used in Emails

| Key                             | Default (English)                                    |
|---------------------------------|------------------------------------------------------|
| `email.newReturn.subject`       | `New return request {id} for order {order}`          |
| `email.newReturn.heading`       | `New Return Request`                                 |
| `email.newReturn.body`          | `A customer has submitted a new return request.`     |
| `email.approved.subject`        | `Your return for order {order} has been approved`    |
| `email.approved.heading`        | `Return Approved`                                    |
| `email.rejected.subject`        | `Your return for order {order} has been declined`    |
| `email.rejected.heading`        | `Return Declined`                                    |
| `email.refunded.subject`        | `Your refund for order {order} has been processed`   |
| `email.refunded.heading`        | `Refund Processed`                                   |
| `email.otp.subject`             | `Your verification code`                             |
| `email.otp.heading`             | `Verification Code`                                  |
| `email.otp.expiry`              | `This code expires in 10 minutes.`                   |
| `email.footer.poweredBy`        | `Powered by Fynd Returns`                            |

### RTL Support

Emails automatically set `dir="rtl"` on the `<html>` tag for RTL locales: Arabic (`ar`), Hebrew (`he`), Farsi (`fa`), and Urdu (`ur`).

---

## WhatsApp Notifications

### Supported Providers

| Provider      | Status        | Auth Method                           |
|---------------|---------------|---------------------------------------|
| Meta Cloud API| Fully implemented | Bearer token (API key)           |
| Twilio        | Stub (logs)   | --                                    |
| WATI          | Stub (logs)   | --                                    |
| Interakt      | Stub (logs)   | --                                    |

### Meta Cloud API Integration

When `whatsappProvider = "meta_cloud"`:

```
POST https://graph.facebook.com/v18.0/{phoneNumberId}/messages
Authorization: Bearer {apiKey}
Content-Type: application/json

{
  "messaging_product": "whatsapp",
  "to": "+911234567890",
  "type": "text",
  "text": { "body": "Your return for order #1001 has been approved." }
}
```

### WhatsApp Events

WhatsApp messages are sent as follow-ups after email for these events:

| Event      | Message Template                                                |
|------------|-----------------------------------------------------------------|
| `approved` | `Your return for order {orderName} has been approved. {notes}`  |
| `rejected` | `Your return for order {orderName} was not approved. Reason: {reason}` |
| `refunded` | `Your refund of {amount} {currency} for order {orderName} has been processed.` |

WhatsApp is triggered only when:
1. `whatsappEnabled = true`
2. A valid `whatsappApiKey` and `whatsappProvider` are configured
3. The customer's phone number is available on the return case

---

## Admin Alerts

### New Return Alert

When a new return is created, the admin receives:
- **Email**: Sent to `adminNotifyEmail` with return details (request ID, order, customer, item count).
- **Sound**: In-app audio notification if `adminSoundEnabled = true`.

### Admin Email Content

The new return admin email includes:
- Return Request ID
- Order name
- Customer email
- Item count
- Call-to-action: "Log in to Fynd Returns to review this return."

---

## Notification Logging

All notification attempts are recorded in the `NotificationLog` table:

| Field          | Type       | Description                                  |
|----------------|------------|----------------------------------------------|
| `shopId`       | `String`   | Shop identifier                              |
| `returnCaseId` | `String?`  | Associated return case (if applicable)       |
| `channel`      | `String`   | `"email"`, `"whatsapp"`, or `"sms"`          |
| `recipient`    | `String`   | Email address or phone number                |
| `eventType`    | `String`   | `"new_return"`, `"approved"`, `"rejected"`, `"refunded"`, `"otp"`, `"custom_note"` |
| `subject`      | `String?`  | Email subject line                           |
| `status`       | `String`   | `"sent"` or `"failed"`                       |
| `error`        | `String?`  | Error message on failure                     |
| `createdAt`    | `DateTime` | Timestamp                                    |

---

## Notification Functions

### Public API

| Function                          | Description                                        |
|-----------------------------------|----------------------------------------------------|
| `sendNewReturnNotification()`     | Email to admin when new return is created           |
| `sendApprovalNotification()`      | Email + WhatsApp to customer on approval            |
| `sendRejectionNotification()`     | Email + WhatsApp to customer on rejection           |
| `sendRefundNotification()`        | Email + WhatsApp to customer on refund              |
| `sendOtpEmail()`                  | OTP verification code email                         |
| `sendCustomerNoteNotification()`  | Admin note forwarded to customer via email          |
| `testSmtpConnection()`            | Verify SMTP credentials                             |

---

## Notification Flow Diagrams

### New Return Notification Flow

```
Customer submits return on portal
  └─→ sendNewReturnNotification()
       ├─→ Check toggles: notificationNewReturn enabled?
       │    └─→ If disabled: return success (skip)
       ├─→ Check SMTP config available?
       │    └─→ If no SMTP: log warning, return success (skip)
       ├─→ Determine recipient (adminNotifyEmail)
       │    └─→ If no admin email: return error
       ├─→ Check custom template (emailTemplates.new_return)?
       │    ├─→ If custom: replaceTemplateVars() with variables
       │    └─→ If built-in: newReturnEmail() with i18n labels
       ├─→ sendEmail() via nodemailer
       └─→ logNotification() to NotificationLog table
```

### Approval Notification Flow

```
Admin approves return
  └─→ sendApprovalNotification()
       ├─→ Email: Same flow as above (customer-facing)
       └─→ WhatsApp follow-up:
            ├─→ getWhatsAppConfig() — check if enabled
            ├─→ If enabled + customer phone available:
            │    └─→ sendWhatsAppNotification()
            └─→ logNotification() for WhatsApp channel
```

---

## Custom Note Notification

Admins can send freeform notes to customers that are delivered via email:

```typescript
await sendCustomerNoteNotification({
  shopDomain: "mystore.myshopify.com",
  to: "customer@example.com",
  orderName: "#1001",
  note: "Please ship the item back to our warehouse.",
  shopName: "My Store",
  returnId: "RPM-A1B2C3D4",
});
```

The custom note email uses a simpler template with a blue accent card for the note text.

---

## Error Handling

### Email Failures

- All email send failures are caught and returned as `{ success: false, error: "..." }`.
- Failures are logged to the `NotificationLog` table with `status: "failed"` and the error message.
- The calling code continues processing even if notification fails (non-blocking).

### WhatsApp Failures

- API errors are caught and logged similarly.
- Unsupported providers (Twilio, WATI, Interakt) log the intended message to console but do not fail.

### Notification Logging Failures

- If logging itself fails (database error), it is caught silently with `console.warn` to avoid cascading failures.

---

## Testing Notifications

### SMTP Test

Use the Settings UI "Test Connection" button, which calls:

```typescript
const result = await testSmtpConnection({
  host: "smtp.gmail.com",
  port: 587,
  secure: false,
  user: "you@gmail.com",
  pass: "app-password",
});
```

This verifies the connection without sending any email.

### Manual Email Test

To test the full email pipeline, create a test return and check:
1. The `NotificationLog` table for the send attempt.
2. The recipient inbox for delivery.
3. The error field if `status = "failed"`.

---

## Related Files

| File                                | Purpose                                   |
|-------------------------------------|-------------------------------------------|
| `app/lib/notification.server.ts`    | All notification logic                    |
| `app/lib/portal-i18n.ts`           | i18n labels for email templates           |
| `app/lib/i18n.server.ts`           | Currency/date formatting, RTL detection   |
| `prisma/schema.prisma`             | NotificationLog model                     |
