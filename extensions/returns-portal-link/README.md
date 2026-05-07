# Returns portal link — theme app extension

This theme app extension adds three merchant-installable app blocks that
surface Fynd Returns inside the storefront theme:

1. **`returns-entry`** — prominent CTA that links to the portal.
2. **`order-status-link`** — inline subtle link variant.
3. **`track-return`** — embeddable form that lets a customer track an
   existing return live (no portal redirect required).

The portal itself is served by Shopify App Proxy at `/apps/returns`.
The first two blocks are CTAs that send customers there. The third
block calls the public `/api/portal/track` endpoint directly (CORS-
gated, rate-limited, email/phone-match required) so customers can
check status without leaving the page.

---

## What's included

### 1. `returns-entry.liquid` — "Start a return" call-to-action

A prominent, styled block with a heading, description, and button. Drop
it into any theme section via the theme editor.

**Settings** (exposed in the theme editor):

| Setting | Default | Description |
|---|---|---|
| Heading | `Returns & Exchanges` | Block heading |
| Description | Default copy | Sub-heading description |
| Button label | `Start a return` | Primary CTA text |
| Alignment | `Center` | left / center / right |
| Button background | `#0f172a` | Button colour |
| Button text | `#ffffff` | Button label colour |

### 3. `track-return.liquid` — embeddable "Track your return" form

A self-contained block with a small form (return ID + email/phone) and
a results panel that shows status, refund state, courier reference,
tracking number, and the live return-stage timeline.

**How it works**

- The form `POST`s to `{app-host}/api/portal/track` over CORS (the
  endpoint accepts `*.myshopify.com` origins).
- The endpoint requires a matching email or phone — pure return ID is
  not enough — to prevent enumeration of other customers' returns.
- Rate-limited (per IP, per shop) by `app/lib/rate-limit.server.ts`.
- No PII beyond what the customer originally submitted is leaked.

**Settings**

| Setting | Default | Description |
|---|---|---|
| Heading | `Track your return` | Block heading |
| Description | Default copy | Sub-heading description |
| Button label | `Track return` | Submit-button text |
| Accent color | `#0f172a` | Button background + focus ring |
| Accent text | `#ffffff` | Button label colour |
| App host URL | Production Railway URL | Backend host. Override for staging |

### 2. `order-status-link.liquid` — inline "Need to return something?" link

A single-line link for more subtle placements, e.g. the order-status
page or site footer.

**Settings**:

| Setting | Default | Description |
|---|---|---|
| Prompt text | `Need to return something?` | Text before the link |
| Link label | `Start a return` | Link label |
| Text color | `#0f172a` | Text colour |

---

## How merchants add this to their theme

After installing Fynd Returns, merchants follow these steps to surface
the portal inside their theme:

1. In Shopify admin, open **Online Store → Themes → Customize**.
2. In the theme editor left sidebar, navigate to any section where you
   want to show the returns CTA — commonly the **Footer**, **Order
   status page**, or a standalone custom section.
3. Click **Add block**. In the picker, choose the **Apps** tab.
4. Select **Returns portal** (for the full CTA block) or
   **Returns link (inline)** (for the subtle variant).
5. Customize the block's settings in the right panel.
6. Click **Save** in the top-right.

The block is now live on the storefront. When customers click the CTA
they're sent to `<your-store>.myshopify.com/apps/returns` — the
Shopify App Proxy URL — where the returns portal (served by this app)
handles the rest.

---

## Deployment

This extension is deployed together with the app:

```bash
npm run deploy
```

Or directly via the Shopify CLI:

```bash
npx shopify app deploy
```

Shopify's theme-store infrastructure compiles and distributes the
extension; no manual store-side install is needed beyond the usual
"Install Fynd Returns" flow.

---

## Compliance notes

- **Follows "Theme app extension" App Store requirement.** Shopify
  policy requires storefront-facing apps to use theme app extensions
  rather than asking merchants to hand-edit Liquid files. This
  extension satisfies that requirement.
- **Deep-link only — no storefront CSS/JS injection.** The block
  renders a self-contained button + inline styles. No
  `<script>` tag, no external JS, no global CSS. Passes Shopify's
  App Store "must not interfere with storefront" check.
- **No third-party tracking.** No analytics calls, no pixels, no
  cookies. The merchant's existing storefront tracking is untouched.
