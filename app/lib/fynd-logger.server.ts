import { fyndLogger } from "./observability/logger.server";

/**
 * @deprecated Use `app/lib/observability/logger.server.ts` instead.
 * This module is superseded by the structured Pino logger with OTel trace
 * correlation and PII redaction. It remains here only for backward compatibility
 * with any code that still imports `createFyndLogger()`.
 *
 * Fynd integration debug logger.
 * NEVER logs credential values (clientSecret, applicationToken, access_token).
 */
export type FyndLogEntry = { ts: string; step: string; message: string; detail?: string };

const REDACT_PATTERNS = [
  /clientSecret[=:]\s*["']?[^"'\s]+/gi,
  /applicationToken[=:]\s*["']?[^"'\s]+/gi,
  /access_token[=:]\s*["']?[^"'\s]+/gi,
  /token[=:]\s*["']?[^"'\s]+/gi,
  /Bearer\s+[^\s]+/gi,
  /Basic\s+[^\s]+/gi,
];

function redact(detail: string | undefined): string | undefined {
  if (!detail) return detail;
  let out = detail;
  for (const p of REDACT_PATTERNS) {
    out = out.replace(p, (m) => m.replace(/[^=:]+\s*$/, "[REDACTED]"));
  }
  return out;
}

export function createFyndLogger() {
  const logs: FyndLogEntry[] = [];
  const log = (step: string, message: string, detail?: string) => {
    const ts = new Date().toISOString();
    const safeDetail = redact(detail);
    logs.push({ ts, step, message, detail: safeDetail });
    fyndLogger.debug({ step, detail: safeDetail }, message);
  };
  return { logs, log };
}
