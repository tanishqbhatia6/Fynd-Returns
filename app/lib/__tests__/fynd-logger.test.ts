import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFyndLogger } from "../fynd-logger.server";

const { fyndLoggerMock } = vi.hoisted(() => ({
  fyndLoggerMock: {
    debug: vi.fn(),
  },
}));

vi.mock("../observability/logger.server", () => ({
  fyndLogger: fyndLoggerMock,
}));

describe("createFyndLogger (deprecated shim)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns a logger with logs array and log fn", () => {
    const { logs, log } = createFyndLogger();
    expect(Array.isArray(logs)).toBe(true);
    expect(typeof log).toBe("function");
    expect(logs.length).toBe(0);
  });

  it("appends entries with step + message + ISO timestamp", () => {
    const { logs, log } = createFyndLogger();
    log("request", "calling Fynd");
    expect(logs).toHaveLength(1);
    expect(logs[0].step).toBe("request");
    expect(logs[0].message).toBe("calling Fynd");
    expect(logs[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("also mirrors to the structured Fynd logger", () => {
    const { log } = createFyndLogger();
    log("step", "hello");
    expect(fyndLoggerMock.debug).toHaveBeenCalledWith(
      { step: "step", detail: undefined },
      "hello",
    );
  });

  it("redacts clientSecret in detail strings", () => {
    const { logs } = createFyndLoggerWithEntry(`POST body: clientSecret=abcd1234`);
    expect(logs[0].detail).toContain("clientSecret=");
    expect(logs[0].detail).not.toContain("abcd1234");
    expect(logs[0].detail).toContain("[REDACTED]");
  });

  it("redacts applicationToken", () => {
    const { logs } = createFyndLoggerWithEntry(`headers: applicationToken="tok-xyz"`);
    expect(logs[0].detail).not.toContain("tok-xyz");
    expect(logs[0].detail).toContain("[REDACTED]");
  });

  it("redacts access_token key=value", () => {
    const { logs } = createFyndLoggerWithEntry(`access_token=secrettoken`);
    expect(logs[0].detail).not.toContain("secrettoken");
    expect(logs[0].detail).toContain("[REDACTED]");
  });

  it("redacts Bearer tokens", () => {
    const { logs } = createFyndLoggerWithEntry("Authorization: Bearer abc.def.ghi");
    expect(logs[0].detail).not.toContain("abc.def.ghi");
    expect(logs[0].detail).toContain("[REDACTED]");
  });

  it("redacts Basic auth", () => {
    const { logs } = createFyndLoggerWithEntry("Authorization: Basic dXNlcjpwYXNz");
    expect(logs[0].detail).not.toContain("dXNlcjpwYXNz");
  });

  it("passes detail untouched when no sensitive pattern matches", () => {
    const { logs } = createFyndLoggerWithEntry("no secrets here");
    expect(logs[0].detail).toBe("no secrets here");
  });

  it("treats undefined detail safely", () => {
    const { logs, log } = createFyndLogger();
    log("step", "plain message");
    expect(logs[0].detail).toBe(undefined);
  });
});

function createFyndLoggerWithEntry(detail: string) {
  const { logs, log } = createFyndLogger();
  log("step", "msg", detail);
  return { logs, log };
}
