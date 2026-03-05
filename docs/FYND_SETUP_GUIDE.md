# Fynd Setup Guide — Fynd Returns

Complete step-by-step guide to connect Fynd and enable automatic refund updates.

---

## Overview

Fynd Returns integrates with Fynd for:

1. **Creating returns on Fynd** — When you approve a return, sync it to Fynd via Platform API
2. **Automatic refund updates** — When Fynd processes the refund, a webhook notifies the app, which then creates the refund in Shopify

This guide walks you through both parts.

---

## Step 1: Fynd credentials

### What you need

- **Company ID** — From your Fynd company settings
- **Application ID** — From Company → Settings → Developers (or your sales channel)
- **Client ID & Client Secret** — From your OAuth app (Platform API)

### Where to find them

1. Log in to [Fynd Platform](https://platform.fynd.com)
2. Go to your **Company** → **Settings** → **Developers**
3. Create or select an OAuth application with Platform API access
4. Ensure the app has these scopes:
   - `company/orders/read`
   - `company/orders/write`
   - `company/settings` (for webhook registration via API)

### In Fynd Returns

1. Go to **Settings** → **Partner Integrations** (or use the **Fynd Setup Guide**)
2. Select **UAT** (sandbox) or **Production** environment
3. Enter Company ID, Application ID, Client ID, and Client Secret
4. Click **Save**

---

## Step 2: Test Platform connection

### What it does

Verifies that Fynd Returns can connect to Fynd Platform API using your credentials. It calls the `orders-listing` endpoint.

### In Fynd Returns

1. After saving credentials, click **Test Platform**
2. If successful: ✓ "Platform API connection successful"
3. If 403 Forbidden: Check scopes in Fynd Partners — your OAuth app needs `company/orders/read` and `company/orders/write`
4. If 401: Verify Company ID, Client ID, and Client Secret

---

## Step 3: Webhook setup

### What it does

The webhook lets Fynd notify Fynd Returns when refund status changes. Without it, you must manually process refunds in Shopify when Fynd completes them.

### Webhook URL

```
POST https://YOUR_APP_URL/api/webhooks/fynd
```

Replace `YOUR_APP_URL` with your deployed app URL (e.g. `https://returnpromax.onrender.com`). No trailing slash.

### In Fynd Platform

1. Go to **Fynd Partners** dashboard
2. Navigate to **Webhooks** (or your extension’s webhook configuration)
3. Add a new webhook for **shipment status** events
4. Set the callback URL to the webhook URL above
5. Save

### Status mapping

| Fynd status | Fynd Returns action |
|-------------|------------------------|
| `refund_initiated`, `refund_pending`, `UNDER PROCESS` | Sets `refundStatus` = `in_progress` |
| `refund_done`, `refunded` | Calls Shopify Refund API, sets `refundStatus` = `refunded` |

---

## Step 4: Test webhook

### What it does

Sends a test payload to the webhook endpoint to verify it is reachable and processes correctly. The test uses a fake shipment ID, so no return is updated.

### In Fynd Returns

1. In the **Fynd Setup Guide**, go to Step 4
2. Click **Test webhook**
3. If successful: ✓ "Webhook endpoint is working"
4. If failed: Check that `SHOPIFY_APP_URL` is set in your deployment environment

---

## Step 5: End-to-end flow

### Approving and syncing a return

1. Customer submits a return request via the portal
2. You approve the return in Fynd Returns
3. Click **Retry Fynd sync** (or **Sync to Fynd**) on the return detail page
4. Fynd creates the return shipment; the app stores `fyndShipmentId`

### Automatic refund when Fynd completes

1. Fynd processes the return (QC, refund, etc.)
2. Fynd sends a webhook to Fynd Returns with `shipment_id` and `refund_status`
3. Fynd Returns finds the return by `fyndShipmentId`
4. When `refund_status` = `refund_done`, the app calls Shopify Refund API
5. The return is marked as completed with `refundStatus` = `refunded`

---

## Troubleshooting

### 403 Forbidden on Platform API

- Enable `company/orders/read` and `company/orders/write` in Fynd Partners
- Use credentials from the correct environment (UAT vs Production)

### Webhook not receiving events

- Confirm the webhook URL is correct and publicly reachable
- Ensure Fynd is configured to send shipment status events to your URL
- Run **Test webhook** in the Setup Guide to verify the endpoint

### Refund not created in Shopify

- Return must have `fyndShipmentId` (synced to Fynd)
- Return must be in `approved` or `completed` status
- Shop must have an offline session (app installed)
- Check Return Events for `fynd_webhook` entries

### Manual refund still needed

- For **manual returns** (no Shopify order), the app marks `refundStatus` = `refunded` when Fynd reports `refund_done`, but you must process the actual refund outside Shopify

---

## Related documentation

- [FYND_API_DETAILS.md](./FYND_API_DETAILS.md) — API endpoints and URLs
- [FYND_WEBHOOK.md](./FYND_WEBHOOK.md) — Webhook payload format and configuration
