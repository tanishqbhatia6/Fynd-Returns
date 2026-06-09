import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

function readSource(relativePath: string) {
  return readFileSync(join(repoRoot, relativePath), "utf8");
}

describe("portal logging audit", () => {
  it("keeps sensitive portal and rate-limit paths on structured redacted loggers", () => {
    const routeFiles = readdirSync(join(repoRoot, "app/routes"))
      .filter((file) => /^api\.portal\..*\.ts$/.test(file))
      .map((file) => `app/routes/${file}`);

    const files = [
      ...routeFiles,
      "app/routes/api.customer-account.returns.ts",
      "app/lib/portal-auth.server.ts",
      "app/lib/portal-cors.server.ts",
      "app/lib/rate-limit.server.ts",
    ];

    const rawConsolePattern = /\bconsole\.(?:error|warn|log|info)\b/;
    const offenders = files.filter((file) => rawConsolePattern.test(readSource(file)));

    expect(offenders).toEqual([]);
  });
});
