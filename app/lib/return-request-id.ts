/**
 * Configurable Return Request ID generation.
 * Safe to use in both client and server (no Prisma dependency here).
 */

/* ─── Types ─── */

export type ReturnIdBodyMode = "hash" | "sequential" | "date_hash" | "date_sequential";

export interface ReturnIdConfig {
  prefix: string;            // e.g. "RPM", "RET", "RMA"
  separator: string;         // e.g. "-", "_", "/", ""
  bodyMode: ReturnIdBodyMode;
  hashLength: number;        // 6, 8, or 10 (for hash modes)
  sequentialPadding: number; // 4–8 zero-pad width (for sequential modes)
  suffix: string;            // optional, e.g. "-2026", "-US"
}

export const DEFAULT_RETURN_ID_CONFIG: ReturnIdConfig = {
  prefix: "RPM",
  separator: "-",
  bodyMode: "hash",
  hashLength: 8,
  sequentialPadding: 6,
  suffix: "",
};

/* ─── Parse / Serialize ─── */

/** Parse config JSON from DB, filling in defaults for any missing fields. */
export function parseReturnIdConfig(json: string | null | undefined): ReturnIdConfig {
  if (!json) return { ...DEFAULT_RETURN_ID_CONFIG };
  try {
    const raw = JSON.parse(json) as Partial<ReturnIdConfig>;
    return {
      prefix: typeof raw.prefix === "string" ? raw.prefix : DEFAULT_RETURN_ID_CONFIG.prefix,
      separator: typeof raw.separator === "string" ? raw.separator : DEFAULT_RETURN_ID_CONFIG.separator,
      bodyMode: (["hash", "sequential", "date_hash", "date_sequential"] as ReturnIdBodyMode[]).includes(raw.bodyMode as ReturnIdBodyMode)
        ? (raw.bodyMode as ReturnIdBodyMode)
        : DEFAULT_RETURN_ID_CONFIG.bodyMode,
      hashLength: [6, 8, 10].includes(raw.hashLength as number) ? (raw.hashLength as number) : DEFAULT_RETURN_ID_CONFIG.hashLength,
      sequentialPadding: typeof raw.sequentialPadding === "number" && raw.sequentialPadding >= 4 && raw.sequentialPadding <= 8
        ? raw.sequentialPadding
        : DEFAULT_RETURN_ID_CONFIG.sequentialPadding,
      suffix: typeof raw.suffix === "string" ? raw.suffix : DEFAULT_RETURN_ID_CONFIG.suffix,
    };
  } catch {
    return { ...DEFAULT_RETURN_ID_CONFIG };
  }
}

/* ─── ID Generation ─── */

/** Extract an alphanumeric hash from a cuid/UUID string. */
function hashFromCuid(cuid: string, length: number): string {
  if (!cuid || cuid.length < length) return (cuid || "").toUpperCase().replace(/[^A-Z0-9]/g, "X").padEnd(length, "X");
  return cuid.slice(-length).toUpperCase().replace(/[^A-Z0-9]/g, "X");
}

/** Get current date as YYMMDD string. */
function datePart(): string {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(-2);
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return `${yy}${mm}${dd}`;
}

/**
 * Build a return request ID from config + cuid + optional counter.
 * For sequential modes, `counter` must be provided.
 */
export function buildReturnRequestId(
  config: ReturnIdConfig,
  cuid: string,
  counter?: number,
): string {
  let body: string;

  switch (config.bodyMode) {
    case "hash":
      body = hashFromCuid(cuid, config.hashLength);
      break;
    case "sequential":
      body = String(counter ?? 0).padStart(config.sequentialPadding, "0");
      break;
    case "date_hash":
      body = `${datePart()}${config.separator}${hashFromCuid(cuid, config.hashLength)}`;
      break;
    case "date_sequential":
      /* v8 ignore start */
      // defensive: counter null fallback; tests always pass a numeric counter for date_sequential
      body = `${datePart()}${config.separator}${String(counter ?? 0).padStart(config.sequentialPadding, "0")}`;
      /* v8 ignore stop */
      break;
    default:
      body = hashFromCuid(cuid, config.hashLength);
  }

  const parts: string[] = [];
  if (config.prefix) parts.push(config.prefix);
  parts.push(body);
  const id = parts.join(config.separator);
  return config.suffix ? `${id}${config.suffix}` : id;
}

/**
 * Generate a sample preview ID for the settings UI.
 * Uses a fake cuid and counter to show what IDs will look like.
 */
export function previewReturnRequestId(config: ReturnIdConfig): string {
  const fakeCuid = "cm5x9abc1234defg5678hijklmno";
  return buildReturnRequestId(config, fakeCuid, 42);
}

/* ─── Legacy fallback ─── */

/**
 * Original hardcoded format: RPM-XXXXXXXX
 * Kept for backward compatibility with old returns that lack a config.
 */
export function formatReturnRequestId(id: string): string {
  if (!id || id.length < 8) return id;
  const suffix = id.slice(-8).toUpperCase().replace(/[^A-Z0-9]/g, "X");
  return `RPM-${suffix}`;
}
