# Returns portal link — theme app extension

This theme app extension adds two merchant-installable app blocks that
surface the Fynd Returns customer portal inside the storefront theme.
Nothing here duplicates portal logic — the portal itself is served by
Shopify App Proxy at `/apps/returns`. These blocks are CTAs that send
customers there.

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
