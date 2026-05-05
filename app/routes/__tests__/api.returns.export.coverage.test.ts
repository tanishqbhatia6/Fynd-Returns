/**
 * Extra integration tests for `app/routes/api.returns.export.ts`.
 *
 * Complements `api.returns.export.test.ts` by widening coverage on:
 *   - CSV generation edge cases (refund JSON parsing, event timestamps,
 *     null vs empty, Unicode payloads)
 *   - Filter scoping (shop isolation, date range plumb-through, query
 *     trimming, multi-field OR construction)
 *   - Pagination over a batched cursor (the loader uses
 *     findMany({ take: MAX_EXPORT_ROWS }) to bound output — these tests
 *     verify the take limit is honored and ordering is `createdAt desc`).
 *
 * All Prisma access is faked through `createPrismaMock`. No DB.
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

/** Builds a fully-populated returnCase row to keep individual tests terse. */
function mkReturnCase(overrides: Record<string, unknown> = {}) {
  return {
    id: "rc-default-id",
    returnRequestNo: "R-DEFAULT",
    shopifyOrderName: "#1000",
    status: "pending",
    resolutionType: "refund",
    customerName: "Default Customer",
    customerEmailNorm: "default@example.com",
    customerPhoneNorm: "+15551234567",
    customerCity: "Springfield",
    customerCountry: "US",
    customerAddress1: "1 Default Way",
    customerAddress2: null,
    customerProvince: "CA",
    customerZip: "90001",
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

describe("api.returns.export — extra coverage", () => {
  // ───────────────── CSV generation ─────────────────

  it("emits all 33 header columns in the correct order", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(0);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const csv = await res.text();
    const headerLine = csv.replace(/^﻿/, "").split("\r\n")[0];
    const cols = headerLine.split(",");

    expect(cols.length).toBe(33);
    expect(cols[0]).toBe("Return Request ID");
    expect(cols[1]).toBe("Order");
    expect(cols[27]).toBe("Item SKU");
    expect(cols[32]).toBe("Item Reason Code");
  });

  it("parses refundJson and emits method/amount/currency/date columns", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(1);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      mkReturnCase({
        refundJson: JSON.stringify({
          method: "manual",
          amount: 49.95,
          currency: "USD",
          createdAt: "2025-01-20T12:00:00Z",
        }),
      }),
    ]);

    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const csv = await res.text();

    expect(csv).toContain("manual");
    expect(csv).toContain("49.95");
    expect(csv).toContain("USD");
    expect(csv).toContain("2025-01-20T12:00:00Z");
  });

  it("emits empty refund columns when refundJson is malformed (graceful catch)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(1);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      mkReturnCase({ refundJson: "{not-valid-json" }),
    ]);

    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    // Should not have thrown and should still produce a CSV.
    const csv = await res.text();
    expect(csv).toContain("Return Request ID");
  });

  it("uses formatReturnRequestId fallback when returnRequestNo is null", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(1);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      mkReturnCase({ id: "rc-abcdef-long", returnRequestNo: null }),
    ]);

    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const csv = await res.text();

    expect(formatReturnRequestIdMock).toHaveBeenCalledWith("rc-abcdef-long");
    // The mock implementation is `R-${id.slice(0,6)}` → "R-rc-abc"
    expect(csv).toContain("R-rc-abc");
  });

  it("includes 'approved' event timestamp from events array", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(1);
    const approvedAt = new Date("2025-01-18T08:30:00Z");
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      mkReturnCase({
        events: [
          { eventType: "created", happenedAt: new Date("2025-01-15T10:00:00Z") },
          { eventType: "approved", happenedAt: approvedAt },
        ],
      }),
    ]);

    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const csv = await res.text();
    expect(csv).toContain(approvedAt.toISOString());
  });

  it("preserves Unicode (non-ASCII) data inside CSV payload", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(1);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      mkReturnCase({
        customerName: "山田太郎",
        customerCity: "東京",
        customerAddress1: "Straße 12",
      }),
    ]);

    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const csv = new TextDecoder("utf-8").decode(new Uint8Array(await res.arrayBuffer()));
    expect(csv).toContain("山田太郎");
    expect(csv).toContain("東京");
    expect(csv).toContain("Straße 12");
  });

  it("escapes embedded newlines by quoting the field", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(1);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      mkReturnCase({ customerAddress1: "Line1\nLine2" }),
    ]);

    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const csv = await res.text();
    expect(csv).toContain('"Line1\nLine2"');
  });

  it("Content-Disposition filename is dated with today's ISO date", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(0);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const cd = res.headers.get("Content-Disposition") || "";
    expect(cd).toMatch(/returns-export-\d{4}-\d{2}-\d{2}\.csv/);
  });

  // ───────────────── Filter scoping ─────────────────

  it("scopes the where clause to the authenticated shop's id", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-zzz" });
    prismaMock.returnCase.count.mockResolvedValueOnce(0);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    await loader({ request: mkReq(), params: {}, context: {} } as never);

    const countWhere = prismaMock.returnCase.count.mock.calls[0][0].where;
    const findWhere = prismaMock.returnCase.findMany.mock.calls[0][0].where;
    expect(countWhere.shopId).toBe("shop-zzz");
    expect(findWhere.shopId).toBe("shop-zzz");
  });

  it("forwards range/from/to query params to parseDateRange", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(0);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    await loader({
      request: mkReq("range=custom&from=2025-03-01&to=2025-03-31"),
      params: {},
      context: {},
    } as never);

    expect(parseDateRangeMock).toHaveBeenCalledWith("custom", "2025-03-01", "2025-03-31");
  });

  it("uses the parseDateRange result as the createdAt range filter", async () => {
    const start = new Date("2025-04-01T00:00:00Z");
    const end = new Date("2025-04-30T23:59:59Z");
    parseDateRangeMock.mockReturnValueOnce({ start, end });

    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(0);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    await loader({ request: mkReq("range=custom"), params: {}, context: {} } as never);

    const where = prismaMock.returnCase.findMany.mock.calls[0][0].where;
    expect(where.createdAt).toEqual({ gte: start, lte: end });
  });

  it("trims whitespace from query before applying the OR filter", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(0);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    await loader({ request: mkReq("query=%20%201001%20%20"), params: {}, context: {} } as never);

    const where = prismaMock.returnCase.count.mock.calls[0][0].where;
    expect(Array.isArray(where.OR)).toBe(true);
    expect(where.OR[0].shopifyOrderName.contains).toBe("1001");
  });

  it("omits the OR clause entirely when query is whitespace-only", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(0);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    await loader({ request: mkReq("query=%20%20%20"), params: {}, context: {} } as never);

    const where = prismaMock.returnCase.count.mock.calls[0][0].where;
    expect(where.OR).toBeUndefined();
  });

  it("OR filter spans all six searchable columns", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(0);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    await loader({ request: mkReq("query=acme"), params: {}, context: {} } as never);

    const where = prismaMock.returnCase.count.mock.calls[0][0].where;
    const fields = where.OR.map((c: Record<string, unknown>) => Object.keys(c)[0]);
    expect(fields.sort()).toEqual([
      "customerEmailNorm",
      "customerPhoneNorm",
      "forwardAwb",
      "fyndReturnNo",
      "returnAwb",
      "shopifyOrderName",
    ]);
  });

  it("does not set status filter when status param is empty", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(0);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    await loader({ request: mkReq("status="), params: {}, context: {} } as never);

    const where = prismaMock.returnCase.count.mock.calls[0][0].where;
    expect("status" in where).toBe(false);
  });

  // ───────────────── Pagination / batched cursor ─────────────────

  it("findMany is called with take = MAX_EXPORT_ROWS (10000)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(50);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    await loader({ request: mkReq(), params: {}, context: {} } as never);

    const args = prismaMock.returnCase.findMany.mock.calls[0][0];
    expect(args.take).toBe(10000);
  });

  it("findMany orders by createdAt desc (newest first in CSV)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(0);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    await loader({ request: mkReq(), params: {}, context: {} } as never);

    const args = prismaMock.returnCase.findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual({ createdAt: "desc" });
  });

  it("findMany includes items and events sorted by happenedAt asc", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(0);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    await loader({ request: mkReq(), params: {}, context: {} } as never);

    const args = prismaMock.returnCase.findMany.mock.calls[0][0];
    expect(args.include).toEqual({
      items: true,
      events: { orderBy: { happenedAt: "asc" } },
    });
  });

  it("renders a batch of many returns into one CSV (no truncation below cap)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(150);

    const batch = Array.from({ length: 150 }, (_, i) =>
      mkReturnCase({
        id: `rc-${i.toString().padStart(4, "0")}`,
        returnRequestNo: `R-${i}`,
        shopifyOrderName: `#${1000 + i}`,
      }),
    );
    prismaMock.returnCase.findMany.mockResolvedValueOnce(batch);

    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const csv = await res.text();
    const lines = csv.split("\r\n");

    // 1 header + 150 data rows (each return has zero items → one row each).
    expect(lines.length).toBe(151);
    expect(csv).toContain("#1000");
    expect(csv).toContain("#1149");
  });

  it("count is computed against the same where clause as findMany", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(0);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    await loader({ request: mkReq("status=approved&query=foo"), params: {}, context: {} } as never);

    const countWhere = prismaMock.returnCase.count.mock.calls[0][0].where;
    const findWhere = prismaMock.returnCase.findMany.mock.calls[0][0].where;
    expect(countWhere).toEqual(findWhere);
  });

  it("does not call findMany when count exceeds MAX_EXPORT_ROWS", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(99999);

    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(400);
    expect(prismaMock.returnCase.findMany).not.toHaveBeenCalled();
  });

  it("count exactly at MAX_EXPORT_ROWS (10000) is allowed (boundary)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(10000);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);

    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.returnCase.findMany).toHaveBeenCalled();
  });
});
