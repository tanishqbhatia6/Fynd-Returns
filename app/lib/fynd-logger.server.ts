/**
 * Fynd integration debug logger - collects logs during request for debugging
 */
export type FyndLogEntry = { ts: string; step: string; message: string; detail?: string };

export function createFyndLogger() {
  const logs: FyndLogEntry[] = [];
  const log = (step: string, message: string, detail?: string) => {
    const ts = new Date().toISOString();
    logs.push({ ts, step, message, detail });
    console.log(`[Fynd ${step}] ${message}`, detail ? `| ${detail}` : "");
  };
  return { logs, log };
}
