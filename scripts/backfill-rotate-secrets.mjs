#!/usr/bin/env node
/**
 * Re-encrypt all stored secrets with the current ENCRYPTION_KEY.
 *
 * Idempotent. Safe to re-run. Run during a key rotation:
 *   1. Set ENCRYPTION_KEY=<NEW>, ENCRYPTION_KEYS_PREVIOUS=<OLD>. Deploy.
 *   2. Run this script.
 *   3. Drop ENCRYPTION_KEYS_PREVIOUS once script reports 0 retired-key reads.
 *      Deploy.
 *
 * Usage:
 *   ENCRYPTION_KEY=<new> ENCRYPTION_KEYS_PREVIOUS=<old> \
 *     node scripts/backfill-rotate-secrets.mjs
 */
import { PrismaClient } from "@prisma/client";
import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const KEY_LENGTH_HEX = 64;
const ENCRYPTED_FORMAT_RE = /^[0-9a-fA-F]+:[0-9a-fA-F]+:[0-9a-fA-F]+$/;

function parseHexKey(raw) {
  const k = (raw ?? "").trim();
  if (!k || k.length !== KEY_LENGTH_HEX || !/^[0-9a-fA-F]+$/.test(k)) return null;
  return Buffer.from(k, "hex");
}

const activeKey = parseHexKey(process.env.ENCRYPTION_KEY);
if (!activeKey) {
  console.error("ENCRYPTION_KEY must be 64 hex chars.");
  process.exit(1);
}
const retiredKeys = (process.env.ENCRYPTION_KEYS_PREVIOUS ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean)
  .map(parseHexKey).filter(Boolean);

if (retiredKeys.length === 0) {
  console.warn("ENCRYPTION_KEYS_PREVIOUS not set — script will succeed only on rows already encrypted with ENCRYPTION_KEY (no rotation possible).");
}

function encrypt(text, key) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let enc = cipher.update(text, "utf8", "hex");
  enc += cipher.final("hex");
  return `${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${enc}`;
}

function tryDecrypt(encrypted, key) {
  const [ivHex, tagHex, data] = encrypted.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data, "hex", "utf8") + decipher.final("utf8");
}

const looksEncrypted = (v) => !!v && ENCRYPTED_FORMAT_RE.test(v);

const prisma = new PrismaClient();

async function rotate() {
  const all = await prisma.shopSettings.findMany({
    select: { id: true, smtpPass: true, whatsappApiKey: true, gorgiasApiKey: true, fyndCredentials: true, shopId: true },
  });
  const stats = {
    totalShops: all.length,
    rewrittenWithNewKey: 0,
    alreadyOnNewKey: 0,
    couldNotDecrypt: 0,
    skippedEmpty: 0,
  };

  for (const row of all) {
    const updates = {};
    for (const field of ["smtpPass", "whatsappApiKey", "gorgiasApiKey", "fyndCredentials"]) {
      const v = row[field];
      if (!v) { stats.skippedEmpty++; continue; }
      if (!looksEncrypted(v)) { stats.skippedEmpty++; continue; }
      // Try active key first.
      try {
        tryDecrypt(v, activeKey);
        stats.alreadyOnNewKey++;
        continue;
      } catch { /* fall through */ }
      // Try each retired key.
      let plaintext = null;
      for (const k of retiredKeys) {
        try { plaintext = tryDecrypt(v, k); break; } catch { /* try next */ }
      }
      if (plaintext == null) {
        stats.couldNotDecrypt++;
        console.warn(`[shop ${row.shopId}] could not decrypt ${field} with any key`);
        continue;
      }
      updates[field] = encrypt(plaintext, activeKey);
      stats.rewrittenWithNewKey++;
    }
    if (Object.keys(updates).length > 0) {
      await prisma.shopSettings.update({ where: { id: row.id }, data: updates });
    }
  }

  console.log(JSON.stringify(stats, null, 2));
  if (stats.couldNotDecrypt > 0) {
    console.error(`\n⚠  ${stats.couldNotDecrypt} fields could not be decrypted. Investigate before dropping ENCRYPTION_KEYS_PREVIOUS.`);
    process.exitCode = 2;
  }
}

rotate()
  .catch((err) => {
    console.error("[backfill-rotate-secrets] FAILED:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
