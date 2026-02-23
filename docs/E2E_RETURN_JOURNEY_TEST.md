# End-to-End Return Journey — Testing Guide

This guide walks through testing the full return flow: **Shopify → Fynd → Shopify** and **Customer Portal**, including webhook updates.

---

## Prerequisites

- [ ] Fynd Platform API configured (Settings → Integrations)
- [ ] Webhook registered: `https://YOUR_APP_URL/api/webhooks/fynd`
- [ ] Test store with Fynd-integrated orders (orders have `affiliate_order_id` in custom attributes)
- [ ] Return window and rules configured (Settings → Return Settings)

---

## Flow 1: Admin-Approved Return (Shopify → Fynd → Shopify)

### Step 1: Create return (Portal or Admin)

1. **Via Customer Portal:** Customer visits `https://STORE.myshopify.com/apps/returns`, enters order number, selects items, submits.
2. **Via Admin:** Create return manually in Return Pro Max (Dashboard → Returns).

### Step 2: Approve return (Admin)

1. Go to **Returns** → select the return → **Approve**.
2. On approve, the app:
   - Syncs to Fynd (`return_initiated`)
   - Stores `fyndShipmentId`, `fyndOrderId`, `fyndReturnId`
3. Verify: Return detail shows **Forward Shipment ID** and **Return Shipment ID**.

### Step 3: Fynd processes refund

1. Fynd processes the return (pickup, inspection, refund).
2. Fynd sends webhook to `POST /api/webhooks/fynd` with:
   - `shipment_id` or `affiliate_order_id`
   - `refund_status`: `UNDER PROCESS` → `refund_done`

### Step 4: Webhook updates Shopify

1. App receives webhook, finds return by `fyndShipmentId` or `fyndOrderId`.
2. For `refund_done`: App creates refund in Shopify via Refund API.
3. Return status → **Completed**, refund status → **Refunded**.
4. Verify: Check **Return Events** for `fynd_webhook` entries.

---

## Flow 2: Auto-Approved Return (Portal → Fynd → Webhook)

When **Auto-approve** is enabled (Settings → Return Settings):

1. Customer submits return via portal.
2. Return is created with status **approved**.
3. App immediately syncs to Fynd (same as manual approve).
4. Fynd processes refund and sends webhook.
5. App creates Shopify refund when `refund_done` received.

---

## Flow 3: Webhook Verification

### Test webhook endpoint

```bash
# GET — should return 200
curl -s https://YOUR_APP_URL/api/webhooks/fynd

# POST dummy payload — should return 200
curl -X POST https://YOUR_APP_URL/api/webhooks/fynd \
  -H "Content-Type: application/json" \
  -d '{"shipment_id":"test-123","refund_status":"UNDER PROCESS"}'
```

### Inspect webhook logs

Webhook events are logged in `FyndWebhookLog`:

- `action`: `ignored` | `refund_in_progress` | `refund_completed` | `error`
- `shipmentId`, `orderId`, `refundStatus`, `returnCaseId`
- `rawPayload`, `error` (for debugging)

Query via SQL or add an admin UI to view recent webhooks.

---

## Edge Cases Handled

| Scenario | Behavior |
|----------|----------|
| Webhook before sync | Returns `ignored` (200). After admin approves, next webhook matches. |
| Duplicate webhook (refund_done twice) | Idempotent: Second call sees `refundStatus=refunded`, returns `ignored`. |
| Shopify "already refunded" | Treated as success; return marked completed. |
| No matching return | Returns `ignored` (200); logged in FyndWebhookLog. |
| No offline session | Returns 500; Fynd retries. Reinstall app to fix. |
| Manual return + refund_done | Marks complete in app; no Shopify refund (manual process). |
| Payload with `order_id` only | Lookup by `fyndOrderId`; backfills `fyndShipmentId` when present. |
| Dummy/test payload | Returns 200 with `action: ignored`. |

---

## Checklist for E2E Test

- [ ] Create return via portal (order with `affiliate_order_id`)
- [ ] Approve return; verify Fynd sync (Forward/Return Shipment IDs visible)
- [ ] Trigger Fynd refund (or wait for Fynd to process)
- [ ] Verify webhook received (check Return Events, FyndWebhookLog)
- [ ] Verify Shopify refund created (Orders → Refunds)
- [ ] Test auto-approve flow (if enabled)
- [ ] Test manual return (no Fynd sync; webhook marks complete only)
- [ ] Test duplicate webhook (send same payload twice; no double refund)

---

## Troubleshooting

| Issue | Check |
|-------|-------|
| Webhook returns 500 | Render logs; `FyndWebhookLog` for `action: error` |
| Return not found by webhook | Ensure `fyndShipmentId` or `fyndOrderId` is set after approve |
| Shopify refund fails | Order must exist; line items valid; not already refunded |
| Fynd sync fails on approve | Test Platform in Settings → Integrations; check Fynd scopes |
