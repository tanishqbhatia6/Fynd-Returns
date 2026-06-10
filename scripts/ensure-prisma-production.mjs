#!/usr/bin/env node

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const allowBaseline = ["1", "true", "yes"].includes(
  (process.env.ALLOW_PRISMA_BASELINE_ON_STARTUP ?? "").trim().toLowerCase(),
);

function run(args, options = {}) {
  const result = spawnSync("prisma", args, {
    stdio: "pipe",
    encoding: "utf8",
    env: process.env,
    ...options,
  });

  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) {
    const err = new Error(`prisma ${args.join(" ")} failed`);
    err.output = output;
    err.status = result.status;
    throw err;
  }

  if (output.trim()) process.stdout.write(output);
  return output;
}

function runDeploy() {
  return run(["migrate", "deploy"]);
}

function shouldBaseline(error) {
  const output = error?.output ?? "";
  return (
    allowBaseline &&
    (output.includes("P3009") || output.includes("P3018")) &&
    output.includes("20260218000000_add_fynd_api_type")
  );
}

try {
  runDeploy();
} catch (error) {
  if (!shouldBaseline(error)) {
    process.stderr.write(error?.output ?? String(error));
    process.exit(error?.status || 1);
  }

  console.warn("[startup] Existing migration history is incomplete; bootstrapping current schema.");
  run(["db", "push", "--skip-generate", "--accept-data-loss"], { stdio: "inherit" });

  const migrations = readdirSync(join(process.cwd(), "prisma", "migrations"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const migration of migrations) {
    const result = spawnSync("prisma", ["migrate", "resolve", "--applied", migration], {
      stdio: "pipe",
      encoding: "utf8",
      env: process.env,
    });

    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    if (result.status !== 0 && !/already.*applied|not.*failed/i.test(output)) {
      process.stderr.write(output);
      process.exit(result.status || 1);
    }
  }

  runDeploy();
}
