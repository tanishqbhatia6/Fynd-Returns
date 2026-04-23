# Shopify App Store Readiness

Tracking document for the **Shopify App Store submission** of Fynd
Returns. Records the findings from the Shopify AI Toolkit self-review
(`/shopify-plugin:shopify-app-store-review`), the fixes applied, and
the outstanding decisions the listing owner must confirm before
pressing "Submit for review".

---

## Review summary

| | Count |
|---|---:|
| Likely passing | 23 |
| Likely failing (now fixed) | 2 |
| Needs human sign-off | 5 |

Report source: Shopify AI Toolkit plugin, April 2026 run. The plugin
reviews a subset of requirements statically; the full review happens
during Shopify's manual submission process.

---

## ❌ Blockers — fixed in this repo

### 1. Installation must start from a Shopify-owned surface

**Rule.** Shopify App Store policy: apps are installed only via App
Store listing or Admin → Apps. Asking the merchant to type their
`.myshopify.com` domain into a form on *our* site is explicitly
prohibited.

**What was wrong.** [app/routes/auth.login/route.tsx](app/routes/auth.login/route.tsx)
rendered a "Connect your store" form with an input field for the
store domain, submitting to `/auth?shop=<typed value>`. That's the
canonical anti-pattern.

**What we changed.** The route is now an information-only page:

- **No form, no input field, no submit button.**
- If Shopify redirects here with `?shop=<store>.myshopify.com` in the
  query string (expired session / Shopify-initiated), the loader
  validates the domain format and server-side redirects straight to
  `/auth?shop=…` — the canonical OAuth path. This is a
  Shopify-initiated flow, not a user-entered one.
- Without a `shop` param, the page shows a neutral "Install from the
  Shopify App Store" card linking to the public listing.
- Route is **not linked from anywhere** in the app surface — only
  reachable via direct URL or Shopify redirects.

**Follow-up before submission.** Update the
`APP_STORE_LISTING_URL` constant in the route file to point at the
real listing URL once the app is approved and public.

### 2. Refunds must go through the original payment processor

**Rule.** Shopify App Store policy: refunds may only flow through
`refundCreate` (refunds to the original gateway) or
`storeCreditRefund` (refunds to Shopify store credit). Issuing a
discount code as a refund mechanism is prohibited. Discount codes are
fine as a separate customer incentive — just not labelled or wired up
as a "refund method".

**What was wrong.** Multiple touch points:

- [app/lib/shopify-admin.server.ts](app/lib/shopify-admin.server.ts):
  `RefundMethodConfig.method` included `"discount_code"`;
  `createDiscountCodeRefund()` exported a code path that generated a
  Shopify discount code equal to the refund amount and labelled the
  transaction as a refund.
- [app/routes/app.settings.return-settings.tsx](app/routes/app.settings.return-settings.tsx):
  showed "Discount code" as a peer refund method with explicit copy
  "Generate a single-use Shopify discount code for the refund amount".
- [app/routes/app.returns.$id.tsx](app/routes/app.returns.$id.tsx):
  refund modal rendered a radio button for "discount_code" alongside
  "original" and "store_credit".
- [app/routes/api.returns.$id.actions.ts](app/routes/api.returns.$id.actions.ts)
  and [app/routes/api.v1.external.returns.$id.refund.ts](app/routes/api.v1.external.returns.$id.refund.ts):
  accepted `refundMethod: "discount_code"` on the admin action and
  public REST API, running the discount-code-as-refund flow.

**What we changed.**

- `RefundMethodConfig.method` narrowed to `"original" | "store_credit" | "both"`.
  A separate `RefundMethod` type alias was added and exported for
  downstream callers.
- The settings-page radio button for "Discount code" is gone. Legacy
  stored settings with `refundPaymentMethod = "discount_code"` fall
  back silently to `"original"` so UIs don't crash on existing rows.
- The refund modal on the return-detail page no longer offers
  discount-code as a choice. The COD-order callout no longer suggests
  "Use Store credit or Discount code" — it now says "Use Store
  credit" only.
- The admin action handler returns **HTTP 400** with a clear error
  when called with `refundMethod: "discount_code"` (defence against
  replayed requests from older clients).
- The public REST API whitelist rejects `"discount_code"` with a
  helpful error message.
- `createDiscountCodeRefund()` remains in the lib, but is explicitly
  marked **`@internal-use-only`** with a comment stating it cannot be
  wired into any UI labelled as a refund method. It's kept so the
  app can still issue discount codes as a separate non-refund
  incentive (e.g. retention offers, thank-you codes) without forcing
  a full rewrite.
- **Historical data display stays intact.** Returns that were already
  refunded via the discount-code path before this change still render
  correctly on the return detail page — we just can't issue new ones.

**Migration safety.** No database schema changes required. The
`discountCode` and `discountCodeValue` columns on `ReturnCase` remain
so historical records keep their display values.

---

## ⚠️ Needs human sign-off before submission

These aren't code bugs — they're policy decisions or copy that only
the listing owner can confirm.

### 3. Unsubstantiated marketing metrics

**Rule.** App Store listings and any marketing surface (login pages,
hero sections) must not make unverifiable performance claims. Fake
urgency, fake social proof, and fake performance numbers are grounds
for rejection.

**What was removed.**

- [app/routes/_index/route.tsx](app/routes/_index/route.tsx): the
  hero "stats" row showed **50% Faster processing**, **3x Customer
  satisfaction**, **99.9% Uptime SLA**, **0 Manual interventions**.
  None of these were backed by public data or a cited source.
  Replaced with factual product attributes — language count, resolution
  types, settings modules, API surface — none of which need external
  validation.
- [app/routes/auth.login/route.tsx](app/routes/auth.login/route.tsx):
  trust-signals block claimed **"SOC 2 compliant infrastructure by
  Fynd"** and **"Trusted by 300M+ customers via Fynd platform"**. Both
  removed. The rewrite for Blocker #1 eliminated the entire login
  form along with these claims — there's no trust-signal block on
  the new page.

**Owner sign-off required.**

- If you want to add ANY performance claim back to the App Store
  listing (e.g. uptime SLA), you need a link to the public status
  page or SLA document that supports it.
- If you want to reference SOC 2, cite the exact certification (SOC 2
  Type I vs Type II, date of audit, auditor name).
- "Trusted by X customers" should specify whether that's *our app*,
  *Fynd the platform*, *end-shoppers who used returns flows*, etc.,
  and be backed by a concrete metric you can produce on demand.

### 4. Billing — Shopify Managed Pricing or Billing API

**Rule.** Apps must use Shopify's Managed Pricing or the Shopify
Billing API (`appSubscriptionCreate`,
`appPurchaseOneTimeCreate`). Listing an app as "free" on the App
Store while billing merchants off-platform (contracted SaaS pricing,
Fynd-platform fees, separate invoices) is an **automatic rejection**.

**What the code does today.** Nothing. Zero matches for billing API
symbols in `app/`. No subscription creation, no charge approval flow,
no reinstall-on-cancel handling.

**Owner decision required.** One of:

1. **The app really is free.** No billing anywhere — not here, not
   through Fynd, not as part of a larger SaaS contract. The "Free to
   install" framing is accurate. No code changes needed. This is the
   default assumption embedded in the current listing.
2. **The app is free but Fynd charges for the reverse-logistics
   service underneath.** This is common for marketplace-style apps.
   Make sure the App Store listing's pricing section is explicit:
   "App is free; Fynd's logistics service has separate pricing —
   see [link]". Shopify's reviewers will check that nothing about
   Fynd's service is gated behind a hidden paywall *for the app's
   core advertised features*.
3. **The app will charge merchants directly.** Implement Shopify's
   Billing API *before* submission. We have no code for this yet;
   it's a multi-week effort (plan selection, charge creation, charge
   approval redirect, reinstall-on-cancellation handling, plan
   changes). File an issue tagged `billing-implementation` if this
   is the direction.

Once the owner picks a path, update the App Store listing's
**Pricing** section and the Privacy / Terms pages to match.

### 5. `read_all_orders` scope justification

**Rule.** `read_all_orders` is a sensitive scope. Shopify reviewers
require an explicit, narrow justification on the App Store listing
and expect the in-app copy to match.

**What was wrong.** The in-app copy at
[app/routes/app.settings.permissions.tsx](app/routes/app.settings.permissions.tsx)
previously said only "Required for full return and refund
functionality" — too vague to pass a manual review.

**What we changed.** The permissions page now lists three specific
uses:

1. Customer portal lookup of orders > 60 days old when the shop's
   return-window policy allows historical returns.
2. Historical analytics — return-rate / top-reasons / revenue-impact
   reports over date ranges longer than 60 days.
3. Fynd cross-referencing — matching Fynd-originated orders to
   Shopify orders for data migrated from Fynd OMS.

**App Store listing copy — suggested text for the listing's "Data
Access" section.** Paste this verbatim or edit to match:

> Fynd Returns requests `read_all_orders` because our self-service
> return portal and historical analytics both require access to
> orders older than 60 days.
>
> 1. **Return creation** — when a merchant's return window is
>    longer than 60 days (e.g. 90-day policies), the customer
>    portal must read older orders to verify the request.
>
> 2. **Analytics** — reports on return rates, top reasons, and
>    revenue retained cover the full analytics range the merchant
>    selects, which can extend past 60 days.
>
> 3. **Logistics matching** — for merchants migrating from Fynd
>    OMS, we match legacy orders to their Shopify counterparts.
>
> Access is opt-in per merchant via **Settings → Permissions**.
> Data is never shared externally and is redacted on
> `customers/redact` and `shop/redact` webhooks.

---

## Pre-submission checklist

Before pressing "Submit for review":

- [ ] Update `APP_STORE_LISTING_URL` in [app/routes/auth.login/route.tsx](app/routes/auth.login/route.tsx) once the listing is live.
- [ ] Choose a billing path (§4) and update the listing's Pricing section.
- [ ] Paste the `read_all_orders` justification (§5) into the listing's Data Access section.
- [ ] Confirm the marketing metrics on [app/routes/_index/route.tsx](app/routes/_index/route.tsx) and any external landing pages match the factual-only rule (§3).
- [ ] Run the App Proxy compliance check (monitoring dashboard — should now pass since webhooks reliability was fixed in an earlier PR).
- [ ] Address the "Use theme app extensions" red X on the submission checklist (separate work — see earlier conversation about scaffolding an `extensions/` folder).
- [ ] Re-run `/shopify-plugin:shopify-app-store-review` — expected new state: 25 passing, 0 failing, 3 needs-review.
- [ ] Deploy the compliance commit to Railway and wait 24 hours so Shopify's automated checks re-run against production.

---

## Out of scope (separate work)

- **Theme app extension** — flagged on the submission checklist as a
  red X ("Use theme app extensions"). Not a review-tool finding but
  a hard App Store requirement in its own right. See the earlier
  conversation about scaffolding an `extensions/` directory with a
  "Start a return" block that deep-links into the portal.
- **Playwright E2E suite** — in-flight in the Phase 2 coverage push.
  Independent of App Store submission but useful for the
  "Stability" pillar of Shopify's app quality review.
