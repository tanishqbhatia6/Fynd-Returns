import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

describe("deployment readiness audit", () => {
  it("keeps CI production-contract validation in sync with required secrets", () => {
    const workflow = read(".github/workflows/ci.yml");
    const requiredBuildEnv = [
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

    expect(workflow).toContain("run: npm run validate:production-env");
    for (const key of requiredBuildEnv) {
      expect(workflow).toMatch(new RegExp(`\\s${key}:\\s+\\S+`));
    }
  });

  it("keeps deploy gated by production preflight checks", () => {
    const workflow = read(".github/workflows/deploy.yml");
    const packageJson = read("package.json");

    expect(packageJson).toContain('"preflight:production": "node scripts/production-preflight.mjs"');
    expect(workflow).toContain("Production preflight (repo contract)");
    expect(workflow).toContain("npm run preflight:production -- --skip-env --skip-network");
    expect(workflow).toContain("Production preflight (Railway environment)");
    expect(workflow).toContain("railway run npm run preflight:production -- --skip-network");
    expect(workflow.indexOf("Production preflight (Railway environment)")).toBeLessThan(
      workflow.indexOf("- name: Deploy to Railway"),
    );
  });

  it("keeps the example env aligned with production-required runtime values", () => {
    const example = read(".env.example");
    for (const key of [
      "DATABASE_URL",
      "REDIS_URL",
      "SHOPIFY_API_KEY",
      "SHOPIFY_API_SECRET",
      "SHOPIFY_APP_URL",
      "ENCRYPTION_KEY",
      "PORTAL_JWT_SECRET",
      "CRON_SECRET",
      "FYND_WEBHOOK_SECRET",
      "APP_BILLING_MODE",
      "APP_MANAGED_PRICING_HANDLE",
    ]) {
      expect(example).toContain(`${key}=`);
    }
    expect(example).toContain("APP_BILLING_MODE=production");
    expect(example).toContain("Required in production");
    expect(example).not.toContain('Billing mode override: "managed"');
    expect(example).not.toContain("Optional Redis URL");
  });

  it("keeps deployment docs aligned with migration-safe production startup", () => {
    const deployment = read("docs/19-deployment.md");
    for (const key of [
      "REDIS_URL",
      "CRON_SECRET",
      "FYND_WEBHOOK_SECRET",
      "APP_BILLING_MODE",
      "APP_MANAGED_PRICING_HANDLE",
    ]) {
      expect(deployment).toContain(`key: ${key}`);
    }
    expect(deployment).toContain("startCommand: npm run start");
    expect(deployment).toContain("Production Env Validation");
    expect(deployment).toContain("Prisma Migrate Deploy");
    expect(deployment).toContain("node scripts/validate-production-env.mjs");
    expect(deployment).toContain("npx prisma migrate deploy");
    expect(deployment).not.toContain("startCommand: npx prisma db push");
    expect(deployment).not.toContain("Prisma DB Push");
    expect(deployment).not.toContain("Your database is now in sync");
  });

  it("keeps Kubernetes runtime secrets out of plaintext env values", () => {
    const manifest = read("deploy/kubernetes/returnpromax.yaml");
    const requiredSecretKeys = [
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

    for (const key of requiredSecretKeys) {
      expect(manifest).toMatch(new RegExp(`- name: ${key}[\\s\\S]*?secretKeyRef:[\\s\\S]*?key: ${key}`));
      expect(manifest).not.toMatch(new RegExp(`- name: ${key}\\n\\s+value:`));
    }

    expect(manifest).not.toMatch(/kind:\s*ConfigMap/);
  });

  it("declares launch-safe probes, rollout strategy, public host, and disruption budget", () => {
    const manifest = read("deploy/kubernetes/returnpromax.yaml");

    expect(manifest).toContain("path: /api/readyz");
    expect(manifest).toContain("path: /api/healthz");
    expect(manifest).toContain("type: RollingUpdate");
    expect(manifest).toContain("maxUnavailable: 0");
    expect(manifest).toContain("maxSurge: 1");
    expect(manifest).toContain("kind: PodDisruptionBudget");
    expect(manifest).toContain("minAvailable: 1");
    expect(manifest).toContain("returns.returnpromax.com");
    expect(manifest).not.toContain("app.example.com");
    expect(manifest).not.toContain("example.com");
    expect(manifest).toMatch(/- name: PORTAL_CSRF_REQUIRED\s+value: "true"/);
  });

  it("keeps the backup CronJob credentialed through Secrets", () => {
    const backup = read("deploy/kubernetes/postgres-backup-cronjob.yaml");
    for (const key of [
      "DATABASE_URL",
      "BACKUP_BUCKET",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_DEFAULT_REGION",
    ]) {
      expect(backup).toMatch(new RegExp(`- name: ${key}[\\s\\S]*?secretKeyRef:[\\s\\S]*?key: ${key}`));
      expect(backup).not.toMatch(new RegExp(`- name: ${key}\\n\\s+value:`));
    }
    expect(backup).toContain("--sse ${BACKUP_S3_SSE:-AES256}");
    expect(backup).toContain("BACKUP_S3_KMS_KEY_ID");
    expect(backup).toMatch(/- name: BACKUP_S3_SSE\s+value: AES256/);
  });

  it("keeps manual backup and restore scripts integrity-protected", () => {
    const backup = read("scripts/postgres-backup.sh");
    const restore = read("scripts/postgres-restore.sh");

    expect(backup).toContain("write_checksum");
    expect(backup).toContain("upload_to_s3");
    expect(backup).toContain("--sse");
    expect(backup).toContain("BACKUP_S3_SSE:-AES256");
    expect(backup).toContain("BACKUP_S3_KMS_KEY_ID");

    expect(restore).toContain("CONFIRM_RESTORE=returnpromax");
    expect(restore).toContain("verify_checksum");
    expect(restore).toContain("Missing checksum file");
    expect(restore).toContain("SKIP_BACKUP_CHECKSUM=true");
  });
});
