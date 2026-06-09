/**
 * Tests for observability/logger.server.ts — focused on the public surface:
 *
 *   - shouldSampleLog() probability gates
 *   - createModuleLogger() module-name + env-var override mechanics
 *   - Each named child logger (refundLogger, securityLogger, …) exposes
 *     the four standard pino levels: info / warn / error / debug.
 *
 * Pino is mocked so we can assert the configuration passed to it (redact
 * paths, formatters, transport) and so log calls stay silent and side-effect
 * free during the test run. The mock returns a logger whose `.child()` yields
 * a fully-functional stub with info/warn/error/debug methods so module
 * loggers can be sanity-checked without bringing real pino streams online.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Pino mock
// ---------------------------------------------------------------------------
// Capture the options passed to pino() so the redact / formatter / mixin
// configuration can be asserted on. Each test re-imports the module fresh so
// the mock state is reproducible.
const pinoCalls: { options: Record<string, unknown> }[] = [];

function makeStubLogger(level = "info"): Record<string, unknown> {
  const stub: Record<string, unknown> = {
    level,
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn((_bindings: Record<string, unknown>, opts?: { level?: string }) =>
      makeStubLogger(opts?.level ?? level),
    ),
  };
  return stub;
}

vi.mock("pino", () => {
  const factory = (options: Record<string, unknown>) => {
    pinoCalls.push({ options });
    return makeStubLogger((options.level as string) ?? "info");
  };
  // pino.stdSerializers.err is referenced inside the source's err serializer.
  (factory as unknown as { stdSerializers: unknown }).stdSerializers = {
    err: (e: Error) => ({ message: e.message, name: e.name, stack: e.stack }),
  };
  return { default: factory };
});

// Reset module registry + captured calls before every test so each suite gets
// a fresh logger module instance with a fresh pino mock invocation.
beforeEach(() => {
  vi.resetModules();
  pinoCalls.length = 0;
});

// ---------------------------------------------------------------------------
// shouldSampleLog
// ---------------------------------------------------------------------------
describe("shouldSampleLog", () => {
  let randomSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    randomSpy?.mockRestore();
  });

  it("returns true (no sampling) for modules absent from the rate table", async () => {
    const { shouldSampleLog } = await import("../observability/logger.server");
    expect(shouldSampleLog("definitely.not.configured")).toBe(true);
  });

  it("samples portal.lookup at 10% — random < 0.1 keeps the log", async () => {
    const { shouldSampleLog } = await import("../observability/logger.server");
    randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.05);
    expect(shouldSampleLog("portal.lookup")).toBe(true);
    randomSpy.mockReturnValue(0.5);
    expect(shouldSampleLog("portal.lookup")).toBe(false);
  });

  it("samples portal.otp.send at 50%", async () => {
    const { shouldSampleLog } = await import("../observability/logger.server");
    randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.49);
    expect(shouldSampleLog("portal.otp.send")).toBe(true);
    randomSpy.mockReturnValue(0.51);
    expect(shouldSampleLog("portal.otp.send")).toBe(false);
  });

  it("samples health_check aggressively at 1%", async () => {
    const { shouldSampleLog } = await import("../observability/logger.server");
    randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.005);
    expect(shouldSampleLog("health_check")).toBe(true);
    randomSpy.mockReturnValue(0.05);
    expect(shouldSampleLog("health_check")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// pino root configuration
// ---------------------------------------------------------------------------
describe("root pino configuration", () => {
  it("registers PII / credential redaction paths with [REDACTED] censor", async () => {
    await import("../observability/logger.server");
    expect(pinoCalls.length).toBe(1);
    const opts = pinoCalls[0].options as {
      redact: { paths: string[]; censor: string };
    };
    expect(opts.redact.censor).toBe("[REDACTED]");
    // A representative subset across the categories:
    expect(opts.redact.paths).toEqual(
      expect.arrayContaining([
        "password",
        "token",
        "apiKey",
        "customerEmail",
        "customerPhone",
        "req.headers.authorization",
      ]),
    );
  });

  it("formats the level field as a label (not a numeric pino code)", async () => {
    await import("../observability/logger.server");
    const opts = pinoCalls[0].options as {
      formatters: { level: (label: string) => Record<string, unknown> };
    };
    expect(opts.formatters.level("warn")).toEqual({ level: "warn" });
  });

  it("registers an `err` serializer that adds AppError fields when applicable", async () => {
    await import("../observability/logger.server");
    const opts = pinoCalls[0].options as {
      serializers: { err: (e: unknown) => Record<string, unknown> };
    };
    const plain = opts.serializers.err(new Error("boom"));
    // For a vanilla Error we should get pino's stdSerializer shape (mocked).
    expect(plain.message).toBe("boom");
    expect("isOperational" in plain).toBe(false);
  });

  it("registers a `req` serializer that strips query strings", async () => {
    await import("../observability/logger.server");
    const opts = pinoCalls[0].options as {
      serializers: {
        req: (r: {
          method: string;
          url: string;
          headers: Record<string, string>;
        }) => Record<string, unknown>;
      };
    };
    const out = opts.serializers.req({
      method: "GET",
      url: "/orders?token=secret",
      headers: { "user-agent": "vitest", authorization: "Bearer x" },
    });
    expect(out).toEqual({
      method: "GET",
      url: "/orders",
      headers: { "user-agent": "vitest" },
    });
  });
});

// ---------------------------------------------------------------------------
// createModuleLogger
// ---------------------------------------------------------------------------
describe("createModuleLogger", () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it("creates a child logger that exposes info/warn/error/debug", async () => {
    const { createModuleLogger } = await import("../observability/logger.server");
    const log = createModuleLogger("custom");
    expect(typeof log.info).toBe("function");
    expect(typeof log.warn).toBe("function");
    expect(typeof log.error).toBe("function");
    expect(typeof log.debug).toBe("function");
  });

  it("applies LOG_LEVEL_<MODULE> overrides through the child() options", async () => {
    process.env.LOG_LEVEL_CUSTOM = "trace";
    const { createModuleLogger } = await import("../observability/logger.server");
    const log = createModuleLogger("custom");
    expect(log.level).toBe("trace");
  });

  it("normalises non-alphanumeric module names into the env-key shape", async () => {
    process.env.LOG_LEVEL_PORTAL_LOOKUP = "debug";
    const { createModuleLogger } = await import("../observability/logger.server");
    const log = createModuleLogger("portal.lookup");
    expect(log.level).toBe("debug");
  });
});

// ---------------------------------------------------------------------------
// Named module loggers
// ---------------------------------------------------------------------------
describe("named module loggers", () => {
  it("exports each documented logger with info/warn/error/debug methods", async () => {
    const mod = await import("../observability/logger.server");
    const named = [
      "fyndLogger",
      "webhookLogger",
      "refundLogger",
      "portalLogger",
      "notifLogger",
      "prismaLogger",
      "securityLogger",
      "cronLogger",
      "externalApiLogger",
      "appLogger",
    ] as const;
    for (const name of named) {
      const log = (mod as unknown as Record<string, Record<string, unknown>>)[name];
      expect(log, `${name} should be exported`).toBeDefined();
      expect(typeof log.info).toBe("function");
      expect(typeof log.warn).toBe("function");
      expect(typeof log.error).toBe("function");
      expect(typeof log.debug).toBe("function");
    }
  });

  it("default export is the root pino logger with .child()", async () => {
    const { default: logger } = await import("../observability/logger.server");
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe("function");
    expect(typeof logger.child).toBe("function");
  });

  it("does not throw when logging payloads with sensitive fields", async () => {
    const { default: logger, securityLogger } = await import("../observability/logger.server");
    expect(() =>
      logger.info({ password: "p", token: "t", customerEmail: "a@b" }, "ok"),
    ).not.toThrow();
    expect(() => securityLogger.warn({ apiKey: "x", otp: "123456" }, "auth event")).not.toThrow();
  });
});
