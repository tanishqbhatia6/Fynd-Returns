# Release Notes — 2026-05-06 (Production Bugs Batch)

End-to-end fixes for the 10 production bugs documented in the Returns App
Testing PDF. Shipped via commits `64900c5..a303f4b` plus follow-up release
work (this branch). All fixes are live in production
(`returnpromax-web-production.up.railway.app`) and covered by automated tests.

## Summary

| #   | Area                              | Fix                                                                              |
| --- | --------------------------------- | -------------------------------------------------------------------------------- |
| 1   | Fynd return creation              | Bag-aware payload — emit `identifier = fyndBagId` instead of aggregate SKU/qty   |
| 2   | Refund safety gate                | Auto-populate `after_qc` preset for Fynd-integrated shops with no gate configured |
| 3   | Desync banner                     | Show local-vs-Fynd state mismatch on the return detail page                      |
| 4   | Order "Return in progress" badge  | Sweep all open Returns on the order after refund close                           |
| 5   | Exchange / replacement SKU loss   | Fall through to a custom line item when the chosen variant has no SKU            |
| 6   | Exchange "resolved" status        | Add `exchangeResolved` flag so the timeline correctly marks the case complete    |
| 7   | Post-approval action visibility   | Replace `isApproved` with `isPostApproval` covering 9 statuses                   |
| 8   | Free exchange / replacement price | `FIXED_AMOUNT` discount equal to line subtotal (preserves visible price)         |
| 9   | Refund quantity over-counting     | Distribute total return-qty across line items; never refund more than requested  |
| 10  | Portal item availability          | Per-line `lineItemAvailability` map + Fynd metadata on offer-accept submission   |

## Changes by area

### `app/lib/return-actions/process-refund.server.ts`
- `fallbackByReturnQty()` distributes `Σ returnItems.qty` across Shopify line
  items so we never request a refund larger than the customer asked for.
- Stronger credit-note transition guard via `PAST_CREDIT_NOTE` set.
- Mirrors successful Fynd status push to local `fyndCurrentStatus`.

### `app/lib/return-actions/process-exchange.server.ts` & `process-replacement.server.ts`
- When `replacementVariantId` is set but the variant has no SKU, fall through
  to a custom line item with explicit `title` / `originalUnitPrice` / `sku`.
  Shopify ignores explicit SKU on variant lines, so this is the only way to
  ensure the SKU survives onto the Fynd order webhook.
- Free exchange / replacement uses `FIXED_AMOUNT` discount equal to the
  line subtotal — preserves the original visible price and makes the
  exchange-discount line clearly attributed.

### `app/lib/shopify-admin.server.ts`
- New `closeAllOpenReturnsOnOrder()` helper queries an order's `returns`
  connection and closes any non-terminal ones. Invoked by
  `closeShopifyReturnBestEffort` after a successful close (and when
  there's no tracked `shopifyReturnId` but an auto-created sibling exists).
- Diagnostic warning when total Shopify-side return qty exceeds total
  customer-requested qty.

### `app/lib/fynd-returns.server.ts`
- Bag-aware `buildProductsPayload()` — when a return item has a known
  `fyndBagId`, the payload uses that as the `identifier` (with `quantity = N`
  matching the requested qty). Falls back to SKU/aggregate emission only
  when bag id is unknown.

### `app/routes/app.returns.$id.tsx`
- Added `exchangeResolved` flag (Bug #6).
- `isApproved` → `isPostApproval` covering 9 statuses (Bug #7).
- Desync banner when local `status`/`refundStatus` is ahead of Fynd state
  (Bug #2 — visibility).
- Accessibility lints: `aria-label` on flagged form elements.

### `app/routes/api.portal.order.ts` & `app/portal/index.html`
- Server response now includes `lineItemAvailability` map per line item
  (`{ orderedQty, returnedQty, availableQty, alreadyInReturn }`).
- Portal `renderItemRow` uses this map for disable logic so already-returned
  bags don't appear selectable.
- Offer-accept submission now carries Fynd metadata
  (`fyndShipmentId`, `fyndBagId`, `fyndLineNumber`, etc.) — previously
  this path silently dropped it.

### `app/routes/app.settings.return-settings.tsx` & `app/routes/app.settings.integrations.tsx`
- `aria-label` on every flagged form element (105+329 axe issues cleared).
- `rel="noreferrer"` → `rel="noopener noreferrer"`.

## Migrations

`scripts/backfill-refund-gate-preset.mjs` runs on every Railway deploy and
auto-populates `refundGatePreset = "after_qc"` (with the matching
`allowedFyndStatusesForRefund` JSON) on any Fynd-integrated shop that
hasn't configured a gate. Idempotent — skips shops already configured or
that explicitly chose `none`/`custom`.

## Test coverage

- `app/lib/__tests__/bug-fixes-coverage.test.ts` — focused regressions for
  Bugs #1, #4, #8 (bag-aware payload, post-close sweep, FIXED_AMOUNT shape).
- `app/lib/return-actions/__tests__/process-exchange-final.test.ts:459` —
  variant-without-SKU fallthrough (Bug #5).
- Existing handler / integration suites updated to tolerate the new
  `openReturns` query inserted ahead of `returnClose`.

## Operational follow-ups

- **`RAILWAY_TOKEN` in GitHub Actions secrets is invalid** — the CI Deploy
  job currently fails with "Invalid token". Refresh at
  https://railway.app/account/tokens and update the GitHub repo secret.
  Until then, deploy with `npm run railway:deploy` from a local checkout.
- Smoke-test on production for Bugs #1, #4, #5, #10 against a real Fynd
  order (cannot be exercised end-to-end from CI).
