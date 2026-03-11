# 17 — Portal Customization

> Theme configuration, branding, tab visibility, font selection, and widget embedding for the customer return portal.

---

## Overview

The customer-facing return portal is a standalone HTML page served at `/portal/{shop-domain}`. It is fully customizable through:

1. **Theme** -- Colors, fonts, border radius, shadows
2. **Branding** -- Logo and favicon
3. **Configuration** -- Tab visibility, default tab, media uploads
4. **Language** -- 15 built-in languages with label overrides
5. **Widget Embedding** -- Embed the portal in any Shopify storefront page

All customization settings are managed in the admin at **Settings > Widget** (`/app/settings/widget`).

---

## Theme Configuration

The portal theme is stored in `ShopSettings.portalThemeJson` as a JSON object. Missing fields fall back to defaults.

### Theme Properties

| Property           | CSS Variable         | Default                     | Description                        |
|--------------------|----------------------|-----------------------------|------------------------------------|
| `primaryColor`     | `%PRIMARY_COLOR%`    | `#008060`                   | Primary brand color (buttons, links, accents) |
| `primaryHoverColor`| `%PRIMARY_HOVER%`    | `#006e52`                   | Hover state for primary elements   |
| `backgroundColor`  | `%BG_COLOR%`         | `#faf9f7`                   | Page background color              |
| `surfaceColor`     | `%SURFACE_COLOR%`    | `#ffffff`                   | Card/panel background color        |
| `textColor`        | `%TEXT_COLOR%`        | `#202223`                   | Primary text color                 |
| `textMutedColor`   | `%TEXT_MUTED%`        | `#6d7175`                   | Secondary/muted text color         |
| `borderColor`      | `%BORDER_COLOR%`      | `#e1e3e5`                   | Border and divider color           |
| `fontFamily`       | `%FONT_FAMILY%`       | `'DM Sans', -apple-system...` | Body text font family            |
| `headingFont`      | `%HEADING_FONT%`      | `'DM Sans', -apple-system...` | Heading font family              |
| `borderRadius`     | `%BORDER_RADIUS%`     | `12px`                      | Border radius for cards and inputs |
| `shadow`           | `%SHADOW%`            | `0 4px 24px rgba(0,0,0,0.06)` | Box shadow for elevated elements |

### Example Theme JSON

```json
{
  "primaryColor": "#2563eb",
  "primaryHoverColor": "#1d4ed8",
  "backgroundColor": "#f8fafc",
  "surfaceColor": "#ffffff",
  "textColor": "#0f172a",
  "textMutedColor": "#64748b",
  "borderColor": "#e2e8f0",
  "fontFamily": "Inter, -apple-system, BlinkMacSystemFont, sans-serif",
  "headingFont": "'Playfair Display', Georgia, serif",
  "borderRadius": "8px",
  "shadow": "0 2px 12px rgba(0,0,0,0.04)"
}
```

### How Themes Are Applied

The `applyPortalThemeToHtml()` function performs string replacement on the portal HTML template:

```typescript
html
  .replaceAll("%PRIMARY_COLOR%", theme.primaryColor)
  .replaceAll("%PRIMARY_HOVER%", theme.primaryHoverColor)
  .replaceAll("%BG_COLOR%", theme.backgroundColor)
  // ... etc.
```

Theme values are injected into CSS custom properties used throughout the portal stylesheet.

---

## Font Options

The admin UI offers a curated list of font choices:

| Label               | Font Stack                                                      |
|---------------------|-----------------------------------------------------------------|
| DM Sans (Modern)    | `'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif` |
| Inter               | `Inter, -apple-system, BlinkMacSystemFont, sans-serif`          |
| System UI           | `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif` |
| Georgia             | `Georgia, 'Times New Roman', serif`                             |
| Playfair Display    | `'Playfair Display', Georgia, serif`                            |

Separate font settings for body text (`fontFamily`) and headings (`headingFont`) allow typographic contrast.

---

## Branding

### Logo

| Setting        | Type       | Description                                       |
|----------------|------------|---------------------------------------------------|
| `brandLogoUrl` | `String?`  | Portal header logo. Accepts base64 data URI or HTTPS URL. |

The logo appears in the portal header. Recommended dimensions: 120-200px wide, transparent background.

### Favicon

| Setting           | Type       | Description                                    |
|-------------------|------------|------------------------------------------------|
| `brandFaviconUrl` | `String?`  | Browser tab icon. Accepts base64 data URI or HTTPS URL. |

---

## Portal Configuration

The `portalConfigJson` field controls which features are visible on the portal.

### Configuration Options

| Option                 | Type      | Default  | Description                                |
|------------------------|-----------|----------|--------------------------------------------|
| `showOrderTracking`    | `Boolean` | `true`   | Show the "Track Order" tab                 |
| `showReturnTracking`   | `Boolean` | `true`   | Show the "Track Return" tab                |
| `showCreateReturnTab`  | `Boolean` | `true`   | Show the "Create Return" tab               |
| `defaultTab`           | `String`  | `"return"`| Default active tab: `"order"`, `"return"`, or `"create"` |
| `allowMediaUploads`    | `Boolean` | `true`   | Allow customers to upload images/video     |

### Example Configuration

```json
{
  "showOrderTracking": true,
  "showReturnTracking": true,
  "showCreateReturnTab": true,
  "defaultTab": "create",
  "allowMediaUploads": true
}
```

### Tab Combinations

| Use Case                    | Configuration                                          |
|-----------------------------|--------------------------------------------------------|
| Returns only                | `showOrderTracking: false, showCreateReturnTab: true`  |
| Tracking only (no creation) | `showCreateReturnTab: false, defaultTab: "return"`     |
| Order tracking focus        | `defaultTab: "order"`                                  |
| Full portal (default)       | All `true`, `defaultTab: "return"`                     |

---

## Portal Language

| Setting          | Default | Description                                |
|------------------|---------|--------------------------------------------|
| `portalLanguage` | `"en"`  | Language for all portal UI text            |

See [14-internationalization.md](./14-internationalization.md) for the full list of 15 supported languages and label override system.

---

## Label Overrides

Merchants can customize any text on the portal without changing the language via `portalLabelsJson`:

```json
{
  "portal.heading": "Return & Exchange Center",
  "portal.subheading": "Start a return, exchange, or check your return status.",
  "portal.create.submit": "Request Return",
  "portal.status.pending": "Under Review",
  "portal.common.poweredBy": "Powered by"
}
```

This is useful for:
- Adjusting brand voice and tone
- Renaming features (e.g., "returns" to "exchanges")
- Removing or customizing the footer text
- Adjusting specific phrases for clarity

---

## Widget Embedding

### Standalone Portal URL

```
https://{your-app-url}/portal/{shop-domain}
```

Example: `https://returnpromax.onrender.com/portal/mystore.myshopify.com`

### Embedding in Shopify Storefront

Add the portal as an iframe or link from any Shopify page:

**Link approach:**
```html
<a href="https://returnpromax.onrender.com/portal/mystore.myshopify.com"
   target="_blank">
  Track Your Return
</a>
```

**Iframe approach:**
```html
<iframe
  src="https://returnpromax.onrender.com/portal/mystore.myshopify.com"
  width="100%"
  height="800"
  frameborder="0"
  style="border: none; border-radius: 12px;">
</iframe>
```

### Custom Domain

For a branded experience, configure a custom domain or subdomain that proxies to the portal URL. This allows URLs like `returns.mystore.com`.

---

## Portal Pages

The portal serves multiple views within a single-page application:

| View              | Description                                              |
|-------------------|----------------------------------------------------------|
| **Track Order**   | Order lookup by order number, email, or phone            |
| **Track Return**  | Return status lookup by return ID, email, AWB, or phone  |
| **Create Return** | Multi-step return creation flow                          |
| **Order Detail**  | Shipment tracking, item list, price breakdown            |
| **Return Detail** | Return status, timeline, shipping label, admin notes     |

### Return Creation Flow

```
Step 1: Enter order number → Fetch order from Shopify
Step 2: Select items to return → Choose reason, upload photos
Step 3: Review and submit → Confirmation with return ID
```

If return offers are enabled, an offer card is shown between steps 2 and 3.

---

## Responsive Design

The portal is designed to work across all device sizes:

| Breakpoint | Layout                                |
|------------|---------------------------------------|
| < 480px    | Single column, stacked cards          |
| 480-768px  | Compact layout with reduced padding   |
| > 768px    | Full desktop layout                   |

---

## Related Files

| File                                    | Purpose                                  |
|-----------------------------------------|------------------------------------------|
| `app/lib/portal-theme.server.ts`        | Theme parsing and HTML injection         |
| `app/lib/portal-config.server.ts`       | Portal configuration parsing             |
| `app/lib/portal-i18n.ts`               | Language dictionaries and label system   |
| `app/portal/index.html`                | Portal HTML template                     |
| `app/routes/app.portal.tsx`            | Portal preview in admin                  |
| `app/routes/app.settings.widget.tsx`   | Widget/theme settings UI                 |
| `app/styles.css`                       | Portal and admin stylesheets             |
