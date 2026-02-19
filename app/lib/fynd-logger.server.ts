/**
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
    const consoleDetail = safeDetail ? ` | ${safeDetail}` : "";
    console.log(`[Fynd ${step}] ${message}${consoleDetail}`);
  };
  return { logs, log };
}
