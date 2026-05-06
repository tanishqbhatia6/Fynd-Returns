import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

/**
 * Coverage closure for apps.returns — line 16:
 *   `if (cachedTemplate && process.env.NODE_ENV === "production") return cachedTemplate;`
 * The cache fast-path only triggers when both conditions are true. Setting
 * NODE_ENV=production and invoking the loader twice exercises both halves.
 */

const TEMPLATE_HTML = "<html><body>%SHOP%</body></html>";

const { prismaMock, readFileSyncMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  readFileSyncMock: vi.fn(() => ""),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return { ...actual, readFileSync: readFileSyncMock };
});

import { loader } from "../apps.returns";

const origNodeEnv = process.env.NODE_ENV;

beforeEach(() => {
  resetPrismaMock(prismaMock);
  readFileSyncMock.mockReset();
  readFileSyncMock.mockReturnValue(TEMPLATE_HTML);
  process.env.NODE_ENV = "production";
});

afterEach(() => {
  if (origNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = origNodeEnv;
});

describe("apps.returns — production cache fast-path (line 16)", () => {
  it("uses cached template on second loader call when NODE_ENV=production", async () => {
    const req1 = new Request("https://example.com/apps/returns?shop=acme");
    const args1 = { request: req1, params: {}, context: {} } as unknown as Parameters<typeof loader>[0];
    const res1 = (await loader(args1)) as Response;
    expect(res1.status).toBe(200);

    const callsAfterFirst = readFileSyncMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThanOrEqual(1);

    // Second call — should hit the cached fast-path on line 16.
    const req2 = new Request("https://example.com/apps/returns?shop=acme");
    const args2 = { request: req2, params: {}, context: {} } as unknown as Parameters<typeof loader>[0];
    const res2 = (await loader(args2)) as Response;
    expect(res2.status).toBe(200);

    // No additional readFileSync calls — proves the cache short-circuit ran.
    expect(readFileSyncMock.mock.calls.length).toBe(callsAfterFirst);
  });
});
