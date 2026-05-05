import { describe, it, expect, afterEach, vi } from "vitest";
import { loader } from "../api.healthz";

describe("GET /api/healthz — coverage", () => {
  const origEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...origEnv };
    vi.restoreAllMocks();
  });

  async function callLoader() {
    const req = new Request("https://app.example/api/healthz");
    return loader({ request: req, params: {}, context: {} } as never);
  }

  it("OK: responds with HTTP 200", async () => {
    const res = await callLoader();
    expect(res.status).toBe(200);
  });

  it("OK: returns JSON content-type", async () => {
    const res = await callLoader();
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("OK: body shape includes status, uptime, version, timestamp", async () => {
    const res = await callLoader();
    const body = await res.json();
    expect(body).toEqual(
      expect.objectContaining({
        status: "ok",
        uptime: expect.any(Number),
        version: expect.any(String),
        timestamp: expect.any(String),
      }),
    );
  });

  it("OK: uptime reflects process.uptime() value", async () => {
    const spy = vi.spyOn(process, "uptime").mockReturnValue(123.456);
    const res = await callLoader();
    const body = await res.json();
    expect(body.uptime).toBe(123.456);
    spy.mockRestore();
  });

  it("OK: uses BUILD_VERSION when provided", async () => {
    process.env.BUILD_VERSION = "v9.9.9-coverage";
    const res = await callLoader();
    const body = await res.json();
    expect(body.version).toBe("v9.9.9-coverage");
  });

  it("Degraded-env fallback: BUILD_VERSION absent → 'dev'", async () => {
    delete process.env.BUILD_VERSION;
    const res = await callLoader();
    const body = await res.json();
    expect(body.version).toBe("dev");
  });

  it("Degraded-env fallback: empty BUILD_VERSION → 'dev'", async () => {
    process.env.BUILD_VERSION = "";
    const res = await callLoader();
    const body = await res.json();
    expect(body.version).toBe("dev");
  });

  it("OK: timestamp parses as a valid Date close to now", async () => {
    const before = Date.now();
    const res = await callLoader();
    const body = await res.json();
    const after = Date.now();
    const ts = Date.parse(body.timestamp);
    expect(Number.isNaN(ts)).toBe(false);
    expect(ts).toBeGreaterThanOrEqual(before - 1000);
    expect(ts).toBeLessThanOrEqual(after + 1000);
  });
});
