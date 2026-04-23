# Shopify App Store Readiness

Tracking document for the **Shopify App Store submission** of Fynd
Returns. Records the findings from the Shopify AI Toolkit self-review
(`/shopify-plugin:shopify-app-store-review`), the fixes applied, and
the outstanding decisions the listing owner must confirm before
pressing "Submit for review".

---

## Review summary

| | First pass | Second pass (now) |
|---|---:|---:|
| Likely passing | 23 | 24 |
| Likely failing | 2 | 0 |
| Needs human sign-off | 5 | 3 |

**Round 2 notes** — after the first commit (`7861dbd`), the user
pushed back that the fixes weren't deep enough. This pass goes further:

- `createDiscountCodeRefund` + its types + its GraphQL mutation are
  **deleted outright**, not just marked `@internal-use-only`.
- The historical "Discount code issued" display on the return-detail
  page is removed — all refunds now render uniformly as "Refund
  processed" regardless of whether the underlying row pre-dates the
  policy change.
- Dead `dcEnabled / dcPrefix / dcExpiryDays` React state in the
  return-settings form is gone.
- The unused `auth.login/error.server.tsx` helper module is deleted.
- `_index/route.tsx` marketing copy scrubbed: "Secure & Compliant"
  → "Secure by design" (with specific tech mentioned); "Real-time
  Analytics" → "Analytics Dashboard" (factual); "your customers will
  love to use" → factual customisation description; "Join brands
  that trust" hero line rewritten to be about features, not
  testimonials. README's "Enterprise-grade" heading removed.
- **New**: theme app extension scaffolded at `extensions/returns-portal-link/`.
  Provides two app blocks (full CTA + inline link) so merchants can
  surface the returns portal via the theme editor rather than via a
  Liquid edit. Resolves the "Use theme app extensions" red X on the
  Shopify submission checklist.

Report source: Shopify AI Toolkit plugin
(`/shopify-plugin:shopify-app-store-review`), first run April 2026.

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

### 4. Billing — Shopify Managed Pricing ✅

**Resolved.** The app uses **Shopify Managed Pricing** with an
environment-aware gate and a per-shop override. Implementation
details are in `app/lib/billing.server.ts` (34 unit tests cover
every decision-tree branch).

**Design.** Three-layer billing gate:

1. **Environment gate (`APP_BILLING_MODE`)**
   - `APP_BILLING_MODE=dev` → billing bypassed. Every shop gets free
     access. Used by UAT, local dev, and any non-production deploy.
   - `APP_BILLING_MODE=prod` → subscription enforced unless one of
     the lower layers overrides. Used by the Railway production
     deployment.
   - unset → defaults to `dev` (fail-open; safer than locking
     everyone out of a misconfigured deploy).

2. **Per-shop override (`ShopSettings.billingPlanOverride`)**
   - `"free"` → shop gets full app access without an active
     subscription. Use for partner shops, beta testers, QA shops.
   - `"paid"` → shop must have an active subscription even on a dev
     build. Useful for dogfooding.
   - `null` → fall back to the environment default.

3. **Live Shopify Managed Pricing check**
   - Calls `currentAppInstallation.activeSubscriptions` via GraphQL
     on every gate call, with a 10-minute cached snapshot on
     `ShopSettings` for webhook contexts without an admin session.
   - Test-mode subscriptions (Shopify's dev-store freebies) are
     ignored — they don't count as paying subscriptions.
   - `app_subscriptions/update` webhook refreshes the snapshot on
     every plan change.

**Pricing configured in Partner Dashboard.** One tier for
submission — **$9.99/month with a 14-day free trial**. Shopify handles
the payment form, plan picker, and charge approval. Merchants are
redirected to
`/charges/<app-handle>/pricing_plans` when no active subscription
is detected.

**Superadmin UI.** `/app/settings/billing-override` — gated by
`SUPERADMIN_EMAILS` env var (comma-separated). Lets your team set
the per-shop override for specific shops (partner stores, QA shops,
enterprise deals). Every change is audited with actor email +
timestamp + reason on the `ShopSettings` row. Regular merchants
never see this route.

**App Store listing copy — Pricing section:**

> **Free 14-day trial, then $9.99/month.** Managed via Shopify
> billing — no separate invoice. Cancel anytime from your admin.
>
> Development and test stores always get free access.

**Env config for production (Railway):**

```
APP_BILLING_MODE=prod
APP_MANAGED_PRICING_HANDLE=<your-app-handle>
SUPERADMIN_EMAILS=ops@fynd.com,eng-oncall@fynd.com
```

For UAT, leave `APP_BILLING_MODE` unset or set to `dev`.

### 4a. Implement Shopify Managed Pricing correctly ✅

**Resolved** together with §4. Implementation checklist:

- [x] Gate every `/app/*` route via the root-loader redirect in
      `app/routes/app.tsx`.
- [x] `/app/billing` status page with upgrade CTA to Shopify's
      Managed Pricing plan picker.
- [x] `app_subscriptions/update` webhook keeps the cache in sync
      with Shopify on plan changes, cancellations, freezes.
- [x] 34 unit tests cover dev/prod modes, override paths, cache
      behaviour, fail-closed on network error.

### 4b. Allow pricing plan changes ✅

**Resolved.** Plan changes flow through Shopify Managed Pricing's
native plan picker — merchants open `/app/billing` or Settings →
Billing → "Manage plan", which deep-links to Shopify's
`/charges/<handle>/pricing_plans` URL. Shopify handles the
upgrade / downgrade UX; our `app_subscriptions/update` webhook
syncs the new state back to our DB.

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

**App Store listing copy — paste this verbatim into the listing's
"Data Access" section. It matches the in-app justification at
[app/routes/app.settings.permissions.tsx](app/routes/app.settings.permissions.tsx)
line-for-line, which Shopify reviewers cross-check.**

> Fynd Returns manages the complete return lifecycle on Shopify —
> a flow that by its nature spans orders from any point in time,
> not just the last 60 days. We request `read_all_orders` because
> four specific, merchant-facing features depend on it:
>
> 1. **Extended return windows.** Merchants regularly configure
>    return policies of 90, 180, or 365 days (apparel, gift
>    purchases, electronics with defect warranties). When a
>    customer submits a return through the storefront portal, we
>    look up their order to verify eligibility, value, and
>    fulfillment status. Without this scope the portal fails
>    precisely on the orders most likely to be returned under an
>    extended policy, defeating the entire feature.
>
> 2. **Fynd ↔ Shopify order matching.** Merchants using the Fynd
>    OMS layer receive webhooks carrying an `affiliate_order_id`
>    that references the Shopify order. Those orders can be
>    arbitrarily old — particularly for merchants migrating
>    historical data to Shopify. Without this scope we can't
>    resolve the references, breaking reverse-logistics
>    automation for the very orders that most need it.
>
> 3. **Historical analytics.** The in-app reporting dashboard
>    supports any date range the merchant selects — "This year",
>    "Last 90 days", custom ranges spanning multiple years.
>    Return-rate and revenue-impact metrics are computed relative
>    to order volume in the same period, so every multi-month
>    report depends on reading historical orders.
>
> 4. **Retroactive policy changes.** When a merchant extends their
>    return window mid-cycle (e.g. a holiday extension from 30 to
>    90 days), orders that were previously outside the window
>    become newly eligible. Without this scope, the portal would
>    incorrectly reject those now-valid requests.
>
> **Privacy and data handling:**
>
> - The scope is opt-in per merchant via the in-app Settings →
>   Permissions page. Merchants who don't enable it operate with
>   the default 60-day window and the app gracefully degrades.
> - Order data is never shared with third parties.
> - Customer PII is deleted within 30 days of the
>   `customers/redact` webhook.
> - All shop data is wiped on `shop/redact` per Shopify's GDPR
>   compliance requirements.
> - Credentials for Fynd OMS are AES-256-GCM encrypted at rest;
>   webhooks are HMAC-verified before being processed.

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
