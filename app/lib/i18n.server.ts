/**
 * Unified internationalization formatting utilities.
 * Uses Intl APIs for locale-aware currency, date, and number formatting.
 */

const DEFAULT_LOCALE = "en";
const DEFAULT_CURRENCY = "USD";
const DEFAULT_TIMEZONE = "UTC";

export function formatMoney(
  amount: number | string,
  currency?: string | null,
  locale?: string | null,
): string {
  const num = typeof amount === "string" ? parseFloat(amount) : amount;
  if (isNaN(num)) return "—";
  try {
    return new Intl.NumberFormat(locale || DEFAULT_LOCALE, {
      style: "currency",
      currency: currency || DEFAULT_CURRENCY,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(num);
  } catch {
    return `${currency || DEFAULT_CURRENCY} ${num.toFixed(2)}`;
  }
}

export function formatDate(
  date: string | Date | null | undefined,
  locale?: string | null,
  timezone?: string | null,
): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  if (isNaN(d.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat(locale || DEFAULT_LOCALE, {
      dateStyle: "medium",
      timeZone: timezone || DEFAULT_TIMEZONE,
    }).format(d);
  } catch {
    return d.toLocaleDateString();
  }
}

export function formatDateTime(
  date: string | Date | null | undefined,
  locale?: string | null,
  timezone?: string | null,
): string {
  if (!date) return "—";
  const d = typeof date === "string" ? new Date(date) : date;
  if (isNaN(d.getTime())) return "—";
  try {
    return new Intl.DateTimeFormat(locale || DEFAULT_LOCALE, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone || DEFAULT_TIMEZONE,
    }).format(d);
  } catch {
    return d.toLocaleString();
  }
}

export function formatNumber(
  value: number,
  locale?: string | null,
): string {
  try {
    return new Intl.NumberFormat(locale || DEFAULT_LOCALE).format(value);
  } catch {
    return String(value);
  }
}

/** Map Shopify locale codes (e.g. "en", "fr", "pt-BR") to BCP 47 locale tags for Intl */
export function normalizeLocale(shopifyLocale: string | null | undefined): string {
  if (!shopifyLocale) return DEFAULT_LOCALE;
  return shopifyLocale.replace("_", "-");
}

export const RTL_LOCALES = new Set(["ar", "he", "fa", "ur"]);

export function isRtlLocale(locale: string | null | undefined): boolean {
  if (!locale) return false;
  const base = locale.split("-")[0].toLowerCase();
  return RTL_LOCALES.has(base);
}
