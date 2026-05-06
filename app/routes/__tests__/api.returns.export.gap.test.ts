/**
 * Targeted gap coverage for `app/routes/api.returns.export.ts`.
 *
 * Drives the last uncovered branches without modifying source:
 *   - `parseRefundJson` fallback paths (lines 127-130): when refundJson
 *     parses successfully but individual fields (method/amount/currency/
 *     createdAt) are missing/undefined, exercising the `?? null` and
 *     `!= null ? String(j.amount) : null` short-circuits.
 *   - Falsy `createdAt` / `updatedAt` ternary branches (lines 176-177):
 *     when the columns come back as null/undefined the ternary picks the
 *     empty-string arm instead of `new Date(...).toISOString()`.
 *
 * Existing `api.returns.export.test.ts` and `api.returns.export.coverage.test.ts`
 * are untouched.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateMock, parseDateRangeMock, formatReturnRequestIdMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  parseDateRangeMock: vi.fn(() => ({ start: new Date("2025-01-01"), end: new Date("2025-02-01") })),
  formatReturnRequestIdMock: vi.fn((id: string) => `R-${id.slice(0, 6)}`),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../lib/dashboard-date-utils", () => ({ parseDateRange: parseDateRangeMock }));
vi.mock("../../lib/return-request-id", () => ({ formatReturnRequestId: formatReturnRequestIdMock }));

import { loader } from "../api.returns.export";

function mkReq(qs: string = "") {
  return new Request(`https://app.example/api/returns/export${qs ? "?" + qs : ""}`);
}

function mkReturnCase(overrides: Record<string, unknown> = {}) {
  return {
    id: "rc-gap-id",
    returnRequestNo: "R-GAP",
    shopifyOrderName: "#9000",
    status: "pending",
    resolutionType: "refund",
    customerName: null,
    customerEmailNorm: null,
    customerPhoneNorm: null,
    customerCity: null,
    customerCountry: null,
    customerAddress1: null,
    customerAddress2: null,
    customerProvince: null,
    customerZip: null,
    customerLandmark: null,
    fyndReturnNo: null,
    fyndReturnId: null,
    fyndShipmentId: null,
    returnAwb: null,
    forwardAwb: null,
    refundStatus: null,
    refundJson: null,
    createdAt: new Date("2025-01-15T10:00:00Z"),
    updatedAt: new Date("2025-01-16T10:00:00Z"),
    items: [],
    events: [],
    ...overrides,
  };
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  parseDateRangeMock.mockReset().mockReturnValue({ start: new Date("2025-01-01"), end: new Date("2025-02-01") });
  formatReturnRequestIdMock.mockReset().mockImplementation((id: string) => `R-${id.slice(0, 6)}`);
});

describe("api.returns.export — gap coverage", () => {
  // ─────── parseRefundJson fallback branches (lines 127-130) ───────

  it("refundJson with all fields missing → emits empty refund cells (?? null + amount-null branches)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(1);
    // Valid JSON but every field is undefined — drives:
    //   method:    j.method ?? null            → null
    //   amount:    j.amount != null ? ... : null → null
    //   currency:  j.currency ?? null          → null
    //   date:      j.createdAt ?? null         → null
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      mkReturnCase({ refundJson: "{}" }),
    ]);

    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const csv = await res.text();
    const headerLine = csv.replace(/^﻿/, "").split("\r\n")[0];
    const cols = headerLine.split(",");
    const dataLine = csv.replace(/^﻿/, "").split("\r\n")[1];
    const dataCols = dataLine.split(",");

    // Refund Method/Amount/Currency/Date sit at column indices 20-23.
    expect(cols[20]).toBe("Refund Method");
    expect(cols[21]).toBe("Refund Amount");
    expect(cols[22]).toBe("Refund Currency");
    expect(cols[23]).toBe("Refund Date");
    expect(dataCols[20]).toBe("");
    expect(dataCols[21]).toBe("");
    expect(dataCols[22]).toBe("");
    expect(dataCols[23]).toBe("");
  });

  it("refundJson with amount=0 numeric → coerced to '0' (amount != null branch with falsy value)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(1);
    // amount=0 is `!= null` so should hit `String(j.amount)` and emit "0",
    // distinguishing the `!= null` test from a truthiness check.
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      mkReturnCase({
        refundJson: JSON.stringify({ amount: 0 }),
      }),
    ]);

    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const csv = await res.text();
    const dataLine = csv.replace(/^﻿/, "").split("\r\n")[1];
    const dataCols = dataLine.split(",");
    expect(dataCols[21]).toBe("0");
    // method/currency/date still null → empty
    expect(dataCols[20]).toBe("");
    expect(dataCols[22]).toBe("");
    expect(dataCols[23]).toBe("");
  });

  // ─────── createdAt / updatedAt falsy ternary branches (lines 176-177) ───────

  // ─────── hashToken null short-circuit (line 72) ───────

  it("anonymize=true with null PII → hashToken returns '' (early null guard)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(1);
    // anonymize=true forces piiSafe → hashToken; null inputs trip the
    // `if (!v) return ""` short-circuit instead of hashing.
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      mkReturnCase({
        customerName: null,
        customerEmailNorm: null,
        customerPhoneNorm: null,
      }),
    ]);

    const res = await loader({ request: mkReq("anonymize=true"), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const csv = await res.text();
    // No anon: token should be present since all PII inputs were null.
    expect(csv).not.toMatch(/anon:[0-9a-f]{12}/);
  });

  it("falsy createdAt/updatedAt → empty Created At + Updated At cells (ternary else branch)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(1);
    // Set both to null so the `rc.createdAt ? ... : ""` and
    // `rc.updatedAt ? ... : ""` ternaries take their else arm.
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      mkReturnCase({ createdAt: null, updatedAt: null }),
    ]);

    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    const csv = await res.text();
    const headerLine = csv.replace(/^﻿/, "").split("\r\n")[0];
    const cols = headerLine.split(",");
    const dataLine = csv.replace(/^﻿/, "").split("\r\n")[1];
    const dataCols = dataLine.split(",");

    // Created At = column 25, Updated At = column 26.
    expect(cols[25]).toBe("Created At");
    expect(cols[26]).toBe("Updated At");
    expect(dataCols[25]).toBe("");
    expect(dataCols[26]).toBe("");
  });
});
