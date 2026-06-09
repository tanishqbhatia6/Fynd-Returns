import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function readDoc(relativePath: string) {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

describe("portal security documentation audit", () => {
  it("documents secure OTP storage and does not describe OTP skip paths", () => {
    const portalDoc = readDoc("docs/06-customer-portal.md");
    const securityDoc = readDoc("docs/18-security.md");
    const combined = `${portalDoc}\n${securityDoc}`;

    expect(combined).toMatch(/OTP[\s\S]{0,120}bcrypt/i);
    expect(combined).toMatch(/otpTarget[\s\S]{0,160}cleared/i);
    expect(portalDoc).toMatch(/token[\s\S]{0,140}sensitive order details/i);
    expect(combined).not.toMatch(/hash(?:es)?\s+the\s+OTP\s+with\s+SHA-256/i);
    expect(combined).not.toMatch(/OTP(?:s)?\s+are\s+SHA-256/i);
    expect(combined).not.toMatch(/dev mode bypass/i);
    expect(combined).not.toMatch(/OTP verification can be skipped/i);
  });
});
