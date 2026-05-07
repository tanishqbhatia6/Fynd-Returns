/**
 * Live email-template preview helper.
 *
 * Substitutes Mustache-style merge tags (`{{key}}`) with sample values
 * for the merchant-side template editor preview. Pure module — never
 * used at actual send-time, only for the live iframe rendering inside
 * app/routes/app.settings.notifications.tsx.
 *
 * Unrecognised tokens are left untouched so merchants spot typos at
 * preview rather than at send-time.
 */
export function renderEmailPreview(
  rawHtml: string,
  sampleData: Record<string, string>,
): string {
  return rawHtml.replace(/\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g, (_match, key: string) => {
    return Object.prototype.hasOwnProperty.call(sampleData, key)
      ? sampleData[key]
      : `{{${key}}}`;
  });
}
