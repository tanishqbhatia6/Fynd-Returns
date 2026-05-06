import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateMock, parseDateRangeMock, formatReturnRequestIdMock } = vi.hoisted(
  () => ({
    prismaMock: {} as ReturnType<typeof createPrismaMock>,
    authenticateMock: vi.fn(),
    parseDateRangeMock: vi.fn(() => ({
      start: new Date("2025-01-01"),
      end: new Date("2025-02-01"),
    })),
    formatReturnRequestIdMock: vi.fn((id: string) => `R-${id.slice(0, 6)}`),
  }),
);
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../lib/dashboard-date-utils", () => ({ parseDateRange: parseDateRangeMock }));
vi.mock("../../lib/return-request-id", () => ({
  formatReturnRequestId: formatReturnRequestIdMock,
}));

import { loader } from "../api.returns.export";

function mkReq(qs: string = "") {
  return new Request(`https://app.example/api/returns/export${qs ? "?" + qs : ""}`);
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  parseDateRangeMock
    .mockReset()
    .mockReturnValue({ start: new Date("2025-01-01"), end: new Date("2025-02-01") });
  formatReturnRequestIdMock.mockReset().mockImplementation((id: string) => `R-${id.slice(0, 6)}`);
});

describe("GET /api/returns/export", () => {
  it("creates a shop record when one doesn't exist", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce(null);
    prismaMock.shop.create.mockResolvedValueOnce({ id: "shop-new" });
    prismaMock.returnCase.count.mockResolvedValueOnce(0);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    const res = await loader({
      request: mkReq("range=last_30_days"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(prismaMock.shop.create).toHaveBeenCalled();
  });

  it("400 when row count exceeds MAX_EXPORT_ROWS (10000)", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(10001);
    const res = await loader({
      request: mkReq("range=last_year"),
      params: {},
      context: {},
    } as never);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toMatch(/Export limit exceeded/);
  });

  it("emits CSV with UTF-8 BOM + CRLF line terminator", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(1);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-long-id",
        returnRequestNo: "R-1",
        shopifyOrderName: "#1001",
        status: "approved",
        resolutionType: "refund",
        customerName: "Jane",
        customerEmailNorm: "j@x.com",
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
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [
          {
            sku: "SKU-1",
            title: "Item",
            qty: 2,
            price: "20.00",
            condition: "new",
            reasonCode: "defective",
          },
        ],
        events: [],
      },
    ]);
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/csv");
    expect(res.headers.get("Content-Disposition")).toContain(".csv");
    // Inspect raw bytes to verify the UTF-8 BOM prefix (EF BB BF).
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf[0]).toBe(0xef);
    expect(buf[1]).toBe(0xbb);
    expect(buf[2]).toBe(0xbf);
    const csv = new TextDecoder("utf-8", { ignoreBOM: false }).decode(buf);
    expect(csv).toContain("\r\n");
    expect(csv).toContain("j@x.com");
  });

  it("anonymises PII when ?anonymize=true", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(1);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        returnRequestNo: null,
        shopifyOrderName: "#1001",
        status: "approved",
        resolutionType: "refund",
        customerName: "Jane Doe",
        customerEmailNorm: "jane@example.com",
        customerPhoneNorm: "+14155551212",
        customerCity: "SF",
        customerCountry: "US",
        customerAddress1: "1 Main St",
        customerAddress2: null,
        customerProvince: "CA",
        customerZip: "94101",
        customerLandmark: null,
        fyndReturnNo: null,
        fyndReturnId: null,
        fyndShipmentId: null,
        returnAwb: null,
        forwardAwb: null,
        refundStatus: null,
        refundJson: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [],
        events: [],
      },
    ]);
    const res = await loader({
      request: mkReq("anonymize=true"),
      params: {},
      context: {},
    } as never);
    const csv = new TextDecoder("utf-8").decode(new Uint8Array(await res.arrayBuffer()));
    expect(csv).not.toContain("jane@example.com");
    expect(csv).not.toContain("Jane Doe");
    expect(csv).not.toContain("1 Main St"); // address completely stripped
    expect(csv).toMatch(/anon:[0-9a-f]{12}/); // hash token pattern
  });

  it("applies status + search filter to where clause", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(0);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([]);
    await loader({
      request: mkReq("status=approved&query=1001"),
      params: {},
      context: {},
    } as never);
    const where = prismaMock.returnCase.count.mock.calls[0][0].where;
    expect(where.status).toBe("approved");
    expect(Array.isArray(where.OR)).toBe(true);
  });

  it("500 on unexpected error", async () => {
    prismaMock.shop.findUnique.mockRejectedValueOnce(new Error("db"));
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/Failed to export/);
  });

  it("emits one row per item when return has multiple items", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(1);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        returnRequestNo: "R-1",
        shopifyOrderName: "#1001",
        status: "approved",
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
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [
          { sku: "A", title: "Item A", qty: 1, price: "10", condition: null, reasonCode: null },
          { sku: "B", title: "Item B", qty: 2, price: "20", condition: null, reasonCode: null },
        ],
        events: [],
      },
    ]);
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const csv = await res.text();
    // 1 header row + 2 data rows = at least 3 CRLF-separated lines
    expect(csv.split("\r\n").length).toBeGreaterThanOrEqual(3);
    expect(csv).toContain("Item A");
    expect(csv).toContain("Item B");
  });

  it("emits one empty-items row when return has no items", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(1);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        returnRequestNo: "R-1",
        shopifyOrderName: "#1001",
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
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [],
        events: [],
      },
    ]);
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    expect(res.status).toBe(200);
    // CSV should include the header + 1 data row
    const csv = await res.text();
    expect(csv.split("\r\n").length).toBe(2);
  });

  it("escapes commas and quotes in values", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1" });
    prismaMock.returnCase.count.mockResolvedValueOnce(1);
    prismaMock.returnCase.findMany.mockResolvedValueOnce([
      {
        id: "rc-1",
        returnRequestNo: "R-1",
        shopifyOrderName: `#"1001", weird`, // contains both , and "
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
        createdAt: new Date(),
        updatedAt: new Date(),
        items: [],
        events: [],
      },
    ]);
    const res = await loader({ request: mkReq(), params: {}, context: {} } as never);
    const csv = await res.text();
    // Values with , or " get wrapped in quotes, and internal " becomes ""
    expect(csv).toContain(`"#""1001"", weird"`);
  });
});
