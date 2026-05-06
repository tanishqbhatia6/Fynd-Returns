import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

/**
 * Coverage closure for api.integrations.gorgias-actions:
 *   - line 57: catch block when Buffer.from throws (decryptIfEncrypted returns
 *     a non-string value that Buffer.from cannot accept).
 */

const { prismaMock, decryptMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  decryptMock: vi.fn((v: string) => v),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../lib/encryption.server", () => ({
  decryptIfEncrypted: decryptMock,
}));

import { action } from "../api.integrations.gorgias-actions";

function mkReq(body: unknown) {
  return new Request("https://app.example/api/integrations/gorgias-actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  decryptMock.mockReset();
});

describe("api.integrations.gorgias-actions — Buffer.from catch (line 57)", () => {
  it("returns 401 invalid key when Buffer.from throws on a non-string decrypted value", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { gorgiasEnabled: true, gorgiasApiKey: "enc:bad" },
    });
    // Returning a number (or any non-string-non-Buffer-non-array) makes
    // Buffer.from(value, "utf8") throw — exercises the catch on line 57.
    decryptMock.mockReturnValueOnce(12345 as unknown as string);

    const res = await action({
      request: mkReq({ shop: "x", api_key: "anything", action: "approve", returnId: "rc-1" }),
      params: {},
      context: {},
    } as never);

    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe("Invalid API key");
  });
});
