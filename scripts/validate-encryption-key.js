#!/usr/bin/env node
/**
 * Validates ENCRYPTION_KEY: format and round-trip encrypt/decrypt.
 * Run: node scripts/validate-encryption-key.js
 * Requires .env with ENCRYPTION_KEY set, or: ENCRYPTION_KEY=xxx node scripts/validate-encryption-key.js
 */
import { config } from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, "../.env") });

const key = process.env.ENCRYPTION_KEY?.trim();
const KEY_LENGTH_HEX = 64;

console.log("ENCRYPTION_KEY validation\n");

if (!key) {
  console.log("❌ ENCRYPTION_KEY is not set.");
  console.log("   Set it in .env or run: ENCRYPTION_KEY=$(openssl rand -hex 32) node scripts/validate-encryption-key.js");
  process.exit(1);
}

// Format check
const formatOk = key.length === KEY_LENGTH_HEX && /^[0-9a-fA-F]+$/.test(key);
if (!formatOk) {
  console.log("❌ Invalid format. Key must be exactly 64 hex characters (32 bytes).");
  console.log(`   Current length: ${key.length}`);
  console.log("   Generate with: openssl rand -hex 32");
  process.exit(1);
}
console.log("✓ Format valid (64 hex chars)");

// Round-trip test
import crypto from "crypto";
try {
  const buf = Buffer.from(key, "hex");
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-gcm", buf, iv);
  let enc = cipher.update("test", "utf8", "hex") + cipher.final("hex");
  const tag = cipher.getAuthTag();
  const decipher = crypto.createDecipheriv("aes-256-gcm", buf, iv);
  decipher.setAuthTag(tag);
  const dec = decipher.update(enc, "hex", "utf8") + decipher.final("utf8");
  if (dec !== "test") {
    console.log("❌ Round-trip failed: decrypted value does not match.");
    process.exit(1);
  }
  console.log("✓ Round-trip encrypt/decrypt OK");
} catch (err) {
  console.log("❌ Round-trip failed:", err.message);
  process.exit(1);
}

console.log("\n✅ ENCRYPTION_KEY is valid and working.");
