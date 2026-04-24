import { describe, it, expect, vi, afterEach } from "vitest";
import { loader } from "../api.healthz";

describe("GET /api/healthz", () => {
  const origEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...origEnv };
  });

  async function callLoader() {
    const req = new Request("https://app.example/api/healthz");
    return loader({ request: req, params: {}, context: {} } as never);
  }

  it("returns 200 with status=ok", async () => {
    const res = await callLoader();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
  });

  it("includes process uptime", async () => {
    const res = await callLoader();
    const body = await res.json();
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it("includes BUILD_VERSION from env, or 'dev' fallback", async () => {
    process.env.BUILD_VERSION = "1.2.3";
    const res1 = await callLoader();
    const body1 = await res1.json();
    expect(body1.version).toBe("1.2.3");

    delete process.env.BUILD_VERSION;
    const res2 = await callLoader();
    const body2 = await res2.json();
    expect(body2.version).toBe("dev");
  });

  it("includes ISO timestamp", async () => {
    const res = await callLoader();
    const body = await res.json();
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  });
});
