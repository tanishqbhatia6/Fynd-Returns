#!/usr/bin/env node
/**
 * Wrapper for one-shot backfill scripts that run on every deploy.
 *
 * Why this exists: the `start` script previously chained the backfills with
 * `&&`, so a single failing backfill bricked the deploy. These backfills are
 * idempotent (no-ops once already applied), so a transient failure should not
 * prevent the server from starting.
 *
 * - Each backfill runs in sequence (preserves the previous ordering).
 * - Failure is logged but does not propagate; exit code is always 0.
 * - Set BACKFILL_STRICT=true to revert to fail-fast behaviour (e.g. for
 *   one-time deploys where you want to gate startup on a backfill landing).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

const SCRIPTS = [
  "backfill-shopify-order-ids.mjs",
  "backfill-webhook-logs.mjs",
  "backfill-customer-info.mjs",
  "backfill-refund-gate-preset.mjs",
];

const STRICT = String(process.env.BACKFILL_STRICT ?? "false").toLowerCase() === "true";

function run(script) {
  return new Promise((res) => {
    const p = spawn(process.execPath, [resolve(__dirname, script)], {
      stdio: "inherit",
      env: process.env,
    });
    p.on("exit", (code) => res(code ?? 0));
    p.on("error", (err) => {
      console.error(`[startup-backfill] ${script} failed to spawn:`, err);
      res(1);
    });
  });
}

let failures = 0;
for (const script of SCRIPTS) {
  console.log(`[startup-backfill] running ${script}`);
  const code = await run(script);
  if (code !== 0) {
    failures += 1;
    console.error(`[startup-backfill] ${script} exited ${code} (continuing)`);
  }
}

if (failures > 0 && STRICT) {
  console.error(`[startup-backfill] ${failures} backfill(s) failed; BACKFILL_STRICT=true so exiting non-zero.`);
  process.exit(1);
}

console.log(`[startup-backfill] done (${SCRIPTS.length - failures}/${SCRIPTS.length} ok)`);
process.exit(0);
