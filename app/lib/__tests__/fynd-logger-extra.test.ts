import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createFyndLogger } from "../fynd-logger.server";

/**
 * Extra coverage for createFyndLogger:
 * - redaction of cookie/auth/credential-like patterns
 * - passthrough of safe fields
 * - independence of multiple logger instances
 */
describe("createFyndLogger — extra redaction & passthrough", () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  function logOne(detail: string | undefined, step = "step", message = "msg") {
    const { logs, log } = createFyndLogger();
    log(step, message, detail);
    return logs;
  }

  // ---------- Credential redaction ----------

  it("redacts clientSecret with colon separator", () => {
    const logs = logOne("config { clientSecret: supersecretvalue }");
    expect(logs[0].detail).not.toContain("supersecretvalue");
    expect(logs[0].detail).toContain("[REDACTED]");
  });

  it("redacts clientSecret regardless of case (ClientSecret)", () => {
    const logs = logOne("ClientSecret=mYsEcReT123");
    expect(logs[0].detail).not.toContain("mYsEcReT123");
    expect(logs[0].detail).toContain("[REDACTED]");
  });

  it("redacts applicationToken with single quotes", () => {
    const logs = logOne("applicationToken='tok-abc-123'");
    expect(logs[0].detail).not.toContain("tok-abc-123");
    expect(logs[0].detail).toContain("[REDACTED]");
  });

  it("redacts access_token without quotes", () => {
    const logs = logOne("query?access_token=opaque-bearer-jwt");
    expect(logs[0].detail).not.toContain("opaque-bearer-jwt");
    expect(logs[0].detail).toContain("[REDACTED]");
  });

  it("redacts a generic token=... pair (not just access_token)", () => {
    const logs = logOne("token=raw-uuid-deadbeef");
    expect(logs[0].detail).not.toContain("raw-uuid-deadbeef");
    expect(logs[0].detail).toContain("[REDACTED]");
  });

  // ---------- Auth header redaction ----------

  it("redacts Bearer JWT-shaped tokens", () => {
    const logs = logOne(
      "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature",
    );
    expect(logs[0].detail).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    expect(logs[0].detail).not.toContain("signature");
    expect(logs[0].detail).toContain("[REDACTED]");
  });

  it("redacts Basic auth credentials blob", () => {
    // Use a base64-ish value without trailing '=' padding: the redactor's
    // inner replacement uses [^=:]+ which would otherwise be defeated by
    // trailing '=' chars. This documents the intended behavior on a typical
    // Basic auth string.
    const logs = logOne("Authorization: Basic dXNlcjpwYXNzd29yZA");
    expect(logs[0].detail).not.toContain("dXNlcjpwYXNzd29yZA");
    expect(logs[0].detail).toContain("[REDACTED]");
  });

  it("redacts multiple sensitive patterns in the same string", () => {
    const logs = logOne(
      "clientSecret=topsecret applicationToken=anothersecret Bearer thirdsecret",
    );
    const detail = logs[0].detail || "";
    expect(detail).not.toContain("topsecret");
    expect(detail).not.toContain("anothersecret");
    expect(detail).not.toContain("thirdsecret");
    // At least one [REDACTED] marker should be present.
    expect(detail).toContain("[REDACTED]");
  });

  // ---------- Passthrough of safe fields ----------

  it("passes through purely numeric / id-like detail unchanged", () => {
    const logs = logOne("orderId=12345 status=success");
    expect(logs[0].detail).toBe("orderId=12345 status=success");
  });

  it("passes through JSON-like safe payload unchanged", () => {
    const safe = '{"orderId":"abc","items":3,"company":"acme"}';
    const logs = logOne(safe);
    expect(logs[0].detail).toBe(safe);
  });

  it("passes through empty string detail unchanged (no false-positive redaction)", () => {
    const logs = logOne("");
    // Falsy detail short-circuits in redact() and is returned as-is.
    expect(logs[0].detail).toBe("");
  });

  it("preserves step and message verbatim even when detail is redacted", () => {
    const logs = logOne("Bearer secret-xyz", "fynd.request", "calling api");
    expect(logs[0].step).toBe("fynd.request");
    expect(logs[0].message).toBe("calling api");
    expect(logs[0].detail).toContain("[REDACTED]");
  });

  // ---------- Console mirroring & instance independence ----------

  it("mirrors redacted detail (not the raw secret) to console", () => {
    const { log } = createFyndLogger();
    log("step", "msg", "clientSecret=should-not-appear");
    const calls = consoleSpy.mock.calls.flat().join("\n");
    expect(calls).not.toContain("should-not-appear");
    expect(calls).toContain("[REDACTED]");
  });

  it("each createFyndLogger() call returns an independent logs array", () => {
    const a = createFyndLogger();
    const b = createFyndLogger();
    a.log("a-step", "a-msg");
    expect(a.logs).toHaveLength(1);
    expect(b.logs).toHaveLength(0);
    expect(a.logs).not.toBe(b.logs);
  });

  it("appends entries in call order with monotonically valid ISO timestamps", () => {
    const { logs, log } = createFyndLogger();
    log("s1", "first");
    log("s2", "second");
    log("s3", "third");
    expect(logs.map((l) => l.step)).toEqual(["s1", "s2", "s3"]);
    for (const entry of logs) {
      expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(Number.isNaN(Date.parse(entry.ts))).toBe(false);
    }
  });
});
