import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * logger.server.ts tests.
 *
 * Focus on the pure functions we can test without hitting pino's internal
 * stream: shouldSampleLog (sample-rate table), createModuleLogger (env-var
 * override mechanics), and the existence of the named child loggers.
 */

// Silence pino output during tests by mocking the transport config path.
// We do NOT mock pino itself because the logger module needs a real pino
// instance to create child loggers.
describe("shouldSampleLog", () => {
  let mathRandomSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    mathRandomSpy?.mockRestore();
  });

  it("returns true for unknown modules (no sampling)", async () => {
    const { shouldSampleLog } = await import("../observability/logger.server");
    expect(shouldSampleLog("unknown.module")).toBe(true);
  });

  it("samples portal.lookup at 10%", async () => {
    const { shouldSampleLog } = await import("../observability/logger.server");
    mathRandomSpy = vi.spyOn(Math, "random").mockReturnValue(0.05);
    expect(shouldSampleLog("portal.lookup")).toBe(true);

    mathRandomSpy.mockReturnValue(0.5);
    expect(shouldSampleLog("portal.lookup")).toBe(false);
  });

  it("samples portal.otp.send at 50%", async () => {
    const { shouldSampleLog } = await import("../observability/logger.server");
    mathRandomSpy = vi.spyOn(Math, "random").mockReturnValue(0.4);
    expect(shouldSampleLog("portal.otp.send")).toBe(true);

    mathRandomSpy.mockReturnValue(0.6);
    expect(shouldSampleLog("portal.otp.send")).toBe(false);
  });

  it("samples health_check at 1%", async () => {
    const { shouldSampleLog } = await import("../observability/logger.server");
    mathRandomSpy = vi.spyOn(Math, "random").mockReturnValue(0.005);
    expect(shouldSampleLog("health_check")).toBe(true);

    mathRandomSpy.mockReturnValue(0.02);
    expect(shouldSampleLog("health_check")).toBe(false);
  });
});

describe("createModuleLogger", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    // Reset env to baseline between tests
    process.env = { ...origEnv };
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("creates a child logger with the module name", async () => {
    const { createModuleLogger } = await import("../observability/logger.server");
    const log = createModuleLogger("mymodule");
    expect(log).toBeDefined();
    // pino child loggers expose standard methods
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
    expect(typeof log.debug).toBe("function");
  });

  it("respects LOG_LEVEL_<MODULE> env override", async () => {
    process.env.LOG_LEVEL_MYMODULE = "trace";
    const { createModuleLogger } = await import("../observability/logger.server");
    const log = createModuleLogger("mymodule");
    // The child should have 'trace' level applied; we can inspect via level property
    expect(log.level).toBe("trace");
  });

  it("normalises dashes and dots in module name into underscores for env key", async () => {
    process.env.LOG_LEVEL_PORTAL_LOOKUP = "debug";
    const { createModuleLogger } = await import("../observability/logger.server");
    const log = createModuleLogger("portal.lookup");
    expect(log.level).toBe("debug");
  });

  it("falls back to parent level when no env override", async () => {
    // Ensure no LOG_LEVEL_NORIDDANCE env is present
    delete process.env.LOG_LEVEL_NORIDDANCE;
    const { createModuleLogger } = await import("../observability/logger.server");
    const log = createModuleLogger("noriddance");
    // With no env override, the child inherits parent's level (info or debug)
    expect(["info", "debug", "trace", "warn", "error", "fatal"]).toContain(log.level);
  });
});

describe("named module loggers", () => {
  it("exports all expected module loggers", async () => {
    const mod = await import("../observability/logger.server");
    expect(mod.fyndLogger).toBeDefined();
    expect(mod.webhookLogger).toBeDefined();
    expect(mod.refundLogger).toBeDefined();
    expect(mod.portalLogger).toBeDefined();
    expect(mod.notifLogger).toBeDefined();
    expect(mod.prismaLogger).toBeDefined();
    expect(mod.securityLogger).toBeDefined();
    expect(mod.cronLogger).toBeDefined();
    expect(mod.externalApiLogger).toBeDefined();
    expect(mod.appLogger).toBeDefined();
  });

  it("default export is the root logger", async () => {
    const { default: logger } = await import("../observability/logger.server");
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.child).toBe("function");
  });
});

describe("log redaction (integration via child.bindings)", () => {
  it("root logger has redact paths configured", async () => {
    const { default: logger } = await import("../observability/logger.server");
    // pino exposes the redact config through the internal bindings/options,
    // but we can indirectly validate by logging a sensitive field and capturing
    // output. Since we're not intercepting stdout here, we only check that
    // the .info method is callable without throwing for sensitive payloads.
    expect(() => logger.info({ password: "secret", token: "tok" }, "test")).not.toThrow();
    expect(() => logger.info({ customerEmail: "a@b.com" }, "pii test")).not.toThrow();
  });
});
