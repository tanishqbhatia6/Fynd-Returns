import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;

function getKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length < 64) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("ENCRYPTION_KEY must be 32-byte hex (64 chars)");
    }
    return Buffer.alloc(32, "dev-key-change-in-production");
  }
  return Buffer.from(key.slice(0, 64), "hex");
}

export function encrypt(text: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted}`;
}

export function decrypt(encrypted: string): string {
  const key = getKey();
  const [ivHex, tagHex, data] = encrypted.split(":");
  if (!ivHex || !tagHex || !data) throw new Error("Invalid encrypted format");
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(data, "hex", "utf8") + decipher.final("utf8");
}
