/**
 * Safe JSON array parser with fallback — reusable across settings loaders.
 * Returns `fallback` if val is empty, unparsable, or not an array.
 */
export function parseJsonArray<T>(val: string | null | undefined, fallback: T[]): T[] {
  if (!val || !val.trim()) return fallback;
  try {
    const parsed = JSON.parse(val) as unknown;
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function parseJsonObject<T extends Record<string, unknown>>(
  val: string | null | undefined,
  fallback: T,
): T {
  if (!val || !val.trim()) return fallback;
  try {
    const parsed = JSON.parse(val) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as T;
    return fallback;
  } catch {
    return fallback;
  }
}
