#!/usr/bin/env node

const nodeEnv = (process.env.NODE_ENV ?? "").trim().toLowerCase();
const skipValidation = nodeEnv === "development" || nodeEnv === "test";

if (skipValidation) {
  process.exit(0);
}

const required = [
  "DATABASE_URL",
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

const missing = required.filter((name) => !process.env[name]?.trim());
const invalid = [];

function requireHex64(name) {
  const value = process.env[name]?.trim() ?? "";
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    invalid.push(`${name} must be 64 hex characters`);
  }
}

function requireMinLength(name, min) {
  const value = process.env[name]?.trim() ?? "";
  if (value.length < min) {
    invalid.push(`${name} must be at least ${min} characters`);
  }
}

function requireHttpsUrl(name) {
  const value = process.env[name]?.trim() ?? "";
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      invalid.push(`${name} must be an https:// URL`);
    }
    if (url.pathname !== "/" || url.search || url.hash) {
      invalid.push(`${name} must be an origin only, with no path, query, or hash`);
    }
    if (!isStablePublicHost(url.hostname)) {
      invalid.push(`${name} must use a stable public hostname`);
    }
  } catch {
    invalid.push(`${name} must be a valid https:// URL`);
  }
}

function isStablePublicHost(hostname) {
  const host = hostname.toLowerCase();
  const privateIpv4 =
    /^10\./.test(host) ||
    /^127\./.test(host) ||
    /^169\.254\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
  return !(
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host === "example.com" ||
    host.endsWith(".example.com") ||
    privateIpv4
  );
}

function requireUrl(name, allowedProtocols) {
  const value = process.env[name]?.trim() ?? "";
  try {
    const url = new URL(value);
    if (!allowedProtocols.includes(url.protocol)) {
      invalid.push(`${name} must use one of: ${allowedProtocols.join(", ")}`);
    }
  } catch {
    invalid.push(`${name} must be a valid URL`);
  }
}

function requireAllowedValue(name, allowedValues) {
  const value = (process.env[name] ?? "").trim().toLowerCase();
  if (!allowedValues.includes(value)) {
    invalid.push(`${name} must be one of: ${allowedValues.join(", ")}`);
  }
}

function isTruthyFlag(name) {
  return ["1", "true", "yes"].includes((process.env[name] ?? "").trim().toLowerCase());
}

function validateBillingMode() {
  const value = (process.env.APP_BILLING_MODE ?? "").trim().toLowerCase();
  if (["prod", "production"].includes(value)) return;
  if (value === "dev" && isTruthyFlag("ALLOW_DEV_BILLING_IN_PRODUCTION")) return;
  invalid.push(
    "APP_BILLING_MODE must be one of: prod, production; dev is allowed only with ALLOW_DEV_BILLING_IN_PRODUCTION=true",
  );
}

function rejectFalseFlag(name, message) {
  const value = (process.env[name] ?? "").trim().toLowerCase();
  if (value === "false") {
    invalid.push(message);
  }
}

function validateEmailList(name) {
  const raw = process.env[name]?.trim();
  if (!raw) return;
  const emails = raw
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
  if (emails.length === 0) {
    invalid.push(`${name} must contain at least one email when set`);
    return;
  }
  const invalidEmails = emails.filter((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
  if (invalidEmails.length > 0) {
    invalid.push(`${name} contains invalid email addresses`);
  }
}

function validatePortalAllowedOrigins() {
  const raw = process.env.PORTAL_ALLOWED_ORIGINS?.trim();
  if (!raw) return;
  if (raw.includes("*")) {
    invalid.push("PORTAL_ALLOWED_ORIGINS must list exact origins; wildcards are not allowed");
    return;
  }
  const origins = raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length === 0) {
    invalid.push("PORTAL_ALLOWED_ORIGINS must list at least one origin when set");
    return;
  }

  for (const origin of origins) {
    try {
      const url = new URL(origin);
      if (url.protocol !== "https:") {
        invalid.push("PORTAL_ALLOWED_ORIGINS entries must be https:// origins");
      }
      if (url.origin !== origin.replace(/\/$/, "") || url.pathname !== "/" || url.search || url.hash) {
        invalid.push("PORTAL_ALLOWED_ORIGINS entries must be origin-only URLs");
      }
      if (!isStablePublicHost(url.hostname)) {
        invalid.push("PORTAL_ALLOWED_ORIGINS entries must use stable public hostnames");
      }
    } catch {
      invalid.push("PORTAL_ALLOWED_ORIGINS entries must be valid URLs");
    }
  }
}

requireUrl("DATABASE_URL", ["postgresql:", "postgres:"]);
if (process.env.REDIS_URL?.trim()) {
  requireUrl("REDIS_URL", ["redis:", "rediss:"]);
}
requireHttpsUrl("SHOPIFY_APP_URL");
requireHex64("ENCRYPTION_KEY");
requireMinLength("PORTAL_JWT_SECRET", 32);
requireMinLength("CRON_SECRET", 32);
requireMinLength("FYND_WEBHOOK_SECRET", 32);
validateBillingMode();
rejectFalseFlag(
  "PORTAL_CSRF_REQUIRED",
  "PORTAL_CSRF_REQUIRED must not be false in production",
);
validateEmailList("SUPERADMIN_EMAILS");
validatePortalAllowedOrigins();

if (missing.length || invalid.length) {
  console.error("[startup] Production environment validation failed.");
  for (const name of missing) console.error(`- Missing ${name}`);
  for (const msg of invalid) console.error(`- ${msg}`);
  process.exit(1);
}

console.log("[startup] Production environment validation passed.");
