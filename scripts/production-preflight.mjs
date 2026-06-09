#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import tls from "node:tls";

const args = new Set(process.argv.slice(2));
const skipEnv = args.has("--skip-env");
const skipNetwork = args.has("--skip-network");
const checkNetwork = args.has("--check-network");
const strict = args.has("--strict");

const failures = [];

const requiredRuntimeKeys = [
  "DATABASE_URL",
  "REDIS_URL",
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "SHOPIFY_APP_URL",
  "SCOPES",
  "ENCRYPTION_KEY",
  "PORTAL_JWT_SECRET",
  "CRON_SECRET",
  "FYND_WEBHOOK_SECRET",
  "APP_BILLING_MODE",
  "APP_MANAGED_PRICING_HANDLE",
];

function fail(message) {
  failures.push(message);
}

function read(path) {
  if (!existsSync(path)) {
    fail(`Missing required file: ${path}`);
    return "";
  }
  return readFileSync(path, "utf8");
}

function assertContains(content, needle, message) {
  if (!content.includes(needle)) fail(message);
}

function assertNotContains(content, needle, message) {
  if (content.includes(needle)) fail(message);
}

function assertMatches(content, pattern, message) {
  if (!pattern.test(content)) fail(message);
}

function envBlock(content, key) {
  const pattern = new RegExp(`- name: ${key}\\n([\\s\\S]*?)(?=\\n\\s*- name:|\\n\\s*readinessProbe:|\\n\\s*resources:|$)`);
  return content.match(pattern)?.[0] ?? "";
}

function auditKubernetesManifest() {
  const manifest = read("deploy/kubernetes/returnpromax.yaml");
  if (!manifest) return;

  for (const key of requiredRuntimeKeys) {
    const block = envBlock(manifest, key);
    if (!block) {
      fail(`Kubernetes deployment must define env var ${key}`);
      continue;
    }
    assertMatches(
      block,
      new RegExp(`secretKeyRef:[\\s\\S]*?key: ${key}`),
      `Kubernetes deployment must source ${key} from returnpromax-secrets`,
    );
    assertMatches(
      block,
      /secretKeyRef:[\s\S]*?name: returnpromax-secrets/,
      `Kubernetes deployment must source ${key} from returnpromax-secrets`,
    );
    if (/optional:\s*true/.test(block)) {
      fail(`${key} must not be optional in Kubernetes deployment`);
    }
    assertNotContains(block, "\n              value:", `Kubernetes deployment must not put ${key} in plaintext value fields`);
  }

  assertNotContains(manifest, "kind: ConfigMap", "Kubernetes baseline must not contain ConfigMaps");
  assertContains(manifest, "path: /api/readyz", "Kubernetes readinessProbe must use /api/readyz");
  assertContains(manifest, "path: /api/healthz", "Kubernetes livenessProbe must use /api/healthz");
  assertContains(manifest, "type: RollingUpdate", "Kubernetes deployment must use RollingUpdate");
  assertContains(manifest, "maxUnavailable: 0", "Rolling update must keep maxUnavailable at 0");
  assertContains(manifest, "maxSurge: 1", "Rolling update must keep maxSurge at 1");
  assertContains(manifest, "kind: PodDisruptionBudget", "Kubernetes baseline must include a PDB");
  assertContains(manifest, "minAvailable: 1", "PDB must keep at least one pod available");
  assertContains(manifest, "secretName: returnpromax-tls", "Ingress must terminate HTTPS with a TLS secret");
  assertNotContains(manifest, "example.com", "Kubernetes manifest must not use example.com placeholders");
}

function auditBackupManifest() {
  const manifest = read("deploy/kubernetes/postgres-backup-cronjob.yaml");
  if (!manifest) return;

  for (const key of [
    "DATABASE_URL",
    "BACKUP_BUCKET",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_DEFAULT_REGION",
  ]) {
    const block = envBlock(manifest, key);
    if (!block) {
      fail(`Postgres backup CronJob must define env var ${key}`);
      continue;
    }
    assertMatches(
      block,
      new RegExp(`secretKeyRef:[\\s\\S]*?name: returnpromax-secrets[\\s\\S]*?key: ${key}`),
      `Postgres backup CronJob must source ${key} from returnpromax-secrets`,
    );
    assertNotContains(
      block,
      "\n                  value:",
      `Postgres backup CronJob must not put ${key} in plaintext value fields`,
    );
  }

  assertContains(manifest, "pg_dump", "Postgres backup CronJob must run pg_dump");
  assertContains(manifest, "sha256sum", "Postgres backup CronJob must write a checksum");
  assertContains(manifest, "--sse ${BACKUP_S3_SSE:-AES256}", "Postgres backup uploads must enable S3 SSE");
}

function auditScriptsAndDocs() {
  const packageJson = read("package.json");
  const deployWorkflow = read(".github/workflows/deploy.yml");
  const operationalDocs = read("docs/22-operational-readiness.md");
  const backup = read("scripts/postgres-backup.sh");
  const restore = read("scripts/postgres-restore.sh");

  assertContains(packageJson, "validate-production-env.mjs", "Production start must validate env");
  assertContains(packageJson, "prisma migrate deploy", "Production start must use prisma migrate deploy");
  assertContains(packageJson, "run-startup-backfills.mjs", "Production start must run startup backfills");
  assertContains(deployWorkflow, "preflight:production", "Deploy workflow must run production preflight");
  assertContains(operationalDocs, "Restore drill", "Operational docs must include restore drill");
  assertContains(operationalDocs, "Secret Rotation", "Operational docs must include secret rotation");
  assertContains(operationalDocs, "Log Redaction Verification", "Operational docs must include log redaction verification");
  assertContains(backup, "write_checksum", "Manual backup script must write a checksum");
  assertContains(restore, "verify_checksum", "Manual restore script must verify checksum");
  assertContains(restore, "CONFIRM_RESTORE=returnpromax", "Manual restore script must require explicit confirmation");
}

function runEnvValidation() {
  if (skipEnv) return;
  const result = spawnSync(process.execPath, ["scripts/validate-production-env.mjs"], {
    env: {
      ...process.env,
      NODE_ENV: "production",
    },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    fail(
      [
        "Production environment contract failed.",
        result.stdout.trim(),
        result.stderr.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

function connectTcp(urlValue, name, defaultPort) {
  return new Promise((resolve) => {
    let url;
    try {
      url = new URL(urlValue);
    } catch {
      resolve(`${name} is not a valid URL`);
      return;
    }

    const port = Number(url.port || defaultPort);
    const host = url.hostname;
    const socket =
      url.protocol === "rediss:"
        ? tls.connect({ host, port, servername: host, timeout: 5000 })
        : net.createConnection({ host, port, timeout: 5000 });

    const done = (message) => {
      socket.destroy();
      resolve(message);
    };

    socket.once("connect", () => done(null));
    socket.once("secureConnect", () => done(null));
    socket.once("timeout", () => done(`${name} connection timed out (${host}:${port})`));
    socket.once("error", (error) => done(`${name} connection failed (${host}:${port}): ${error.message}`));
  });
}

async function checkHttp(urlValue, path) {
  let url;
  try {
    url = new URL(path, urlValue);
  } catch {
    return `${urlValue}${path} is not a valid URL`;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!response.ok) {
      return `${url.toString()} returned HTTP ${response.status}`;
    }
    return null;
  } catch (error) {
    return `${url.toString()} failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function runNetworkChecks() {
  if (skipNetwork || (!checkNetwork && !strict)) return;

  const dbError = await connectTcp(process.env.DATABASE_URL ?? "", "DATABASE_URL", 5432);
  if (dbError) fail(dbError);

  const redisError = await connectTcp(process.env.REDIS_URL ?? "", "REDIS_URL", 6379);
  if (redisError) fail(redisError);

  const appUrl = process.env.SHOPIFY_APP_URL;
  if (appUrl) {
    for (const path of ["/api/healthz", "/api/readyz"]) {
      const error = await checkHttp(appUrl, path);
      if (error) fail(error);
    }
  }
}

auditKubernetesManifest();
auditBackupManifest();
auditScriptsAndDocs();
runEnvValidation();
await runNetworkChecks();

if (failures.length > 0) {
  console.error("[preflight] Production readiness preflight failed.");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("[preflight] Production readiness preflight passed.");
