#!/usr/bin/env node
/**
 * One-shot backfill: encrypt any plaintext SMTP / WhatsApp credentials in
 * ShopSettings. Idempotent — already-encrypted values are detected by format
 * and skipped.
 *
 * Run once after deploying the encryption-on-write change. Safe to re-run.
 *
 * Usage:
 *   node scripts/backfill-encrypt-secrets.mjs
 *
 * Requires: ENCRYPTION_KEY env var (64 hex chars).
 */
import { PrismaClient } from "@prisma/client";
import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const KEY_LENGTH_HEX = 64;
const ENCRYPTED_FORMAT_RE = /^[0-9a-fA-F]+:[0-9a-fA-F]+:[0-9a-fA-F]+$/;

function getKey() {
  const key = process.env.ENCRYPTION_KEY?.trim();
  if (!key || key.length !== KEY_LENGTH_HEX || !/^[0-9a-fA-F]+$/.test(key)) {
    throw new Error("ENCRYPTION_KEY must be 64 hex chars (32 bytes). Run: openssl rand -hex 32");
  }
  return Buffer.from(key, "hex");
}

function encrypt(text) {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let enc = cipher.update(text, "utf8", "hex");
  enc += cipher.final("hex");
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc}`;
}

const looksEncrypted = (v) => !!v && ENCRYPTED_FORMAT_RE.test(v);

const prisma = new PrismaClient();

async function main() {
  const all = await prisma.shopSettings.findMany({
    select: { id: true, smtpPass: true, whatsappApiKey: true, gorgiasApiKey: true, shopId: true },
  });

  const stats = {
    totalShops: all.length,
    smtpEncrypted: 0, smtpAlreadyEncrypted: 0,
    whatsappApiKeyEncrypted: 0, whatsappApiKeyAlreadyEncrypted: 0,
    gorgiasApiKeyEncrypted: 0, gorgiasApiKeyAlreadyEncrypted: 0,
  };

  for (const row of all) {
    const updates = {};
    for (const [field, statKey] of [
      ["smtpPass", "smtp"],
      ["whatsappApiKey", "whatsappApiKey"],
      ["gorgiasApiKey", "gorgiasApiKey"],
    ]) {
      const v = row[field];
      if (!v) continue;
      if (looksEncrypted(v)) {
        stats[`${statKey}AlreadyEncrypted`]++;
      } else {
        updates[field] = encrypt(v);
        stats[`${statKey}Encrypted`]++;
      }
    }
    if (Object.keys(updates).length > 0) {
      await prisma.shopSettings.update({ where: { id: row.id }, data: updates });
    }
  }

  console.log(JSON.stringify(stats, null, 2));
}

main()
  .catch((err) => {
    console.error("[backfill-encrypt-secrets] FAILED:", err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
