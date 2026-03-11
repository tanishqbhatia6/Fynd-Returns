# 14 — Internationalization (i18n)

> Multi-language support for the customer portal and email notifications with 15 built-in languages, RTL support, and merchant label overrides.

---

## Overview

ReturnProMax provides a comprehensive internationalization system covering:

- **15 built-in languages** with ~120 translation keys each
- **RTL (right-to-left)** layout support for Arabic, Hebrew, Farsi, and Urdu
- **Merchant label overrides** to customize any text string
- **Locale-aware formatting** for currencies, dates, and numbers via `Intl` APIs

---

## Supported Languages

| Code | Language                | RTL | Script    |
|------|-------------------------|-----|-----------|
| `en` | English                 | No  | Latin     |
| `es` | Espanol (Spanish)       | No  | Latin     |
| `fr` | Francais (French)       | No  | Latin     |
| `de` | Deutsch (German)        | No  | Latin     |
| `hi` | Hindi                   | No  | Devanagari|
| `ar` | Arabic                  | Yes | Arabic    |
| `pt` | Portugues (Portuguese)  | No  | Latin     |
| `ja` | Japanese                | No  | CJK       |
| `zh` | Chinese                 | No  | CJK       |
| `ko` | Korean                  | No  | Hangul    |
| `it` | Italiano (Italian)      | No  | Latin     |
| `nl` | Nederlands (Dutch)      | No  | Latin     |
| `ru` | Russian                 | No  | Cyrillic  |
| `tr` | Turkce (Turkish)        | No  | Latin     |
| `th` | Thai                    | No  | Thai      |

The default language is `en` (English).

### Setting the Language

The portal language is set via `ShopSettings.portalLanguage`. Change it in **Settings > Portal Customization** or via the API.

---

## RTL Support

### Detection

RTL locales are detected by the `isRtlLocale()` function from `i18n.server.ts`:

```typescript
const RTL_LOCALES = new Set(["ar", "he", "fa", "ur"]);

function isRtlLocale(locale: string): boolean {
  const base = locale.split("-")[0].toLowerCase();
  return RTL_LOCALES.has(base);
}
```

### Application

- **Portal HTML**: The portal `<html>` tag includes `dir="rtl"` when the locale is RTL.
- **Email templates**: The `<html>` tag in email layouts includes `dir="rtl"` for RTL locales.
- **CSS**: The portal stylesheet supports bidirectional text flow.

---

## Translation Key System

### Key Naming Convention

Keys use dot-notation with namespace groups:

```
portal.{section}.{element}
email.{event}.{part}
```

### Key Categories

| Namespace Prefix        | Count | Description                              |
|-------------------------|-------|------------------------------------------|
| `portal.title`          | 4     | Page titles and headings                 |
| `portal.tab.*`          | 5     | Tab labels                               |
| `portal.lookup.*`       | 25+   | Lookup form labels and placeholders      |
| `portal.results.*`      | 10+   | Search result labels                     |
| `portal.create.*`       | 35+   | Return creation form                     |
| `portal.status.*`       | 25+   | Status labels (return + order)           |
| `portal.tracking.*`     | 20+   | Tracking page labels                     |
| `portal.order.*`        | 10+   | Order detail labels                      |
| `portal.price.*`        | 7     | Price breakdown labels                   |
| `portal.progress.*`     | 11    | Progress step labels                     |
| `portal.common.*`       | 20+   | Common UI elements                       |
| `portal.error.*`        | 15+   | Validation and error messages            |
| `portal.event.*`        | 13    | Timeline event descriptions              |
| `portal.eligibility.*`  | 6     | Eligibility status messages              |
| `portal.statusDesc.*`   | 30+   | Detailed status descriptions             |
| `email.*`               | 15    | Email template strings                   |

### Template Interpolation

Translation strings support `{placeholder}` interpolation:

```typescript
// Definition
"email.newReturn.subject": "New return request {id} for order {order}"

// Usage
t("email.newReturn.subject", labels, { id: "RPM-A1B2C3D4", order: "#1001" })
// → "New return request RPM-A1B2C3D4 for order #1001"
```

The `t()` function:
1. Looks up the key in the merged label set
2. Falls back to English (`EN`) if the key is missing in the current language
3. Falls back to the raw key string if not found in English either
4. Replaces `{placeholder}` patterns with provided values

---

## Merchant Label Overrides

Merchants can override any translation key via `ShopSettings.portalLabelsJson`:

```json
{
  "portal.heading": "Return & Exchange Center",
  "portal.create.submit": "Request Return",
  "portal.status.pending": "Under Review",
  "email.footer.poweredBy": "Powered by MyBrand"
}
```

### Override Resolution Order

```
1. Merchant override (portalLabelsJson)
2. Selected language translation
3. English (EN) base translation
4. Raw key string (last resort)
```

### Accessing Labels

```typescript
import { getPortalLabels, t } from "~/lib/portal-i18n";

// Get merged labels for a language with optional overrides
const labels = getPortalLabels("es", merchantOverrides);

// Translate a key with interpolation
const text = t("portal.policyBanner", labels, { days: "30" });
// → "Se aceptan devoluciones dentro de 30 días de la entrega."
```

### Getting All Available Keys

```typescript
import { getAllLabelKeys } from "~/lib/portal-i18n";

const keys = getAllLabelKeys(); // Returns all ~120 key names
```

---

## Locale-Aware Formatting

The `i18n.server.ts` module provides locale-aware formatting using JavaScript `Intl` APIs.

### Currency Formatting

```typescript
import { formatMoney } from "~/lib/i18n.server";

formatMoney(1299.50, "INR", "hi");  // "₹1,299.50"
formatMoney(49.99, "USD", "en");     // "$49.99"
formatMoney(39.99, "EUR", "de");     // "39,99 €"
```

### Date Formatting

```typescript
import { formatDate, formatDateTime } from "~/lib/i18n.server";

formatDate("2026-03-10", "en", "America/New_York");
// → "Mar 10, 2026"

formatDateTime("2026-03-10T14:30:00Z", "hi", "Asia/Kolkata");
// → "10 मार्च 2026, 8:00 pm"
```

### Number Formatting

```typescript
import { formatNumber } from "~/lib/i18n.server";

formatNumber(12500, "hi");  // "12,500" (Indian grouping)
formatNumber(12500, "de");  // "12.500" (German grouping)
```

### Shop Locale Settings

Locale settings are auto-detected from Shopify and stored in `ShopSettings`:

| Setting        | Default | Description                             |
|----------------|---------|------------------------------------------|
| `shopLocale`   | `"en"`  | BCP 47 locale tag for formatting         |
| `shopCurrency` | `"USD"` | ISO 4217 currency code                   |
| `shopTimezone` | `"UTC"` | IANA timezone for date display           |

---

## Adding a New Language

To add a new language:

1. Create a new language constant in `app/lib/portal-i18n.ts`:

```typescript
const XX: Record<string, string> = {
  "portal.title": "...",
  // ... all ~120 keys
};
```

2. Add to the `LANGUAGE_MAP`:

```typescript
const LANGUAGE_MAP: Record<string, Record<string, string>> = {
  // ... existing languages
  xx: XX,
};
```

3. Add to the `SUPPORTED_LANGUAGES` array:

```typescript
export const SUPPORTED_LANGUAGES = [
  // ... existing entries
  { code: "xx", label: "Language Name" },
];
```

4. If RTL, add the locale code to `RTL_LOCALES` in `i18n.server.ts`.

---

## Related Files

| File                          | Purpose                                    |
|-------------------------------|--------------------------------------------|
| `app/lib/portal-i18n.ts`     | Translation dictionaries, label resolution |
| `app/lib/i18n.server.ts`     | Locale-aware formatting utilities          |
| `app/lib/notification.server.ts` | i18n-aware email templates              |
| `app/portal/index.html`      | Portal HTML with i18n injection points     |
