/**
 * Tests for api-docs-data.ts: shape integrity of the external API endpoint
 * registry and webhook event list. The admin API docs page and the Postman
 * collection generator both depend on these structures, so any drift in
 * required fields, duplicate paths, or duplicate method+path identifiers
 * surfaces as broken docs / collection imports.
 */
import { describe, it, expect } from "vitest";
import {
  EXTERNAL_API_ENDPOINTS,
  WEBHOOK_EVENTS,
  type ApiEndpointDef,
} from "../api-docs-data";

const ALLOWED_METHODS: ReadonlyArray<ApiEndpointDef["method"]> = [
  "GET",
  "POST",
  "DELETE",
];

describe("EXTERNAL_API_ENDPOINTS", () => {
  it("is a non-empty array", () => {
    expect(Array.isArray(EXTERNAL_API_ENDPOINTS)).toBe(true);
    expect(EXTERNAL_API_ENDPOINTS.length).toBeGreaterThan(0);
  });

  it("each entry has method/path/permission/folder of correct type", () => {
    for (const ep of EXTERNAL_API_ENDPOINTS) {
      expect(ALLOWED_METHODS).toContain(ep.method);
      expect(typeof ep.path).toBe("string");
      expect(ep.path.startsWith("/api/v1/external/")).toBe(true);
      expect(typeof ep.permission).toBe("string");
      expect(ep.permission.length).toBeGreaterThan(0);
      expect(typeof ep.folder).toBe("string");
      expect(ep.folder.length).toBeGreaterThan(0);
    }
  });

  it("each entry has name, description, responseExample, and errorCodes", () => {
    for (const ep of EXTERNAL_API_ENDPOINTS) {
      expect(typeof ep.name).toBe("string");
      expect(ep.name.length).toBeGreaterThan(0);
      expect(typeof ep.description).toBe("string");
      expect(ep.description.length).toBeGreaterThan(0);
      expect(typeof ep.responseExample).toBe("object");
      expect(ep.responseExample).not.toBeNull();
      expect(Array.isArray(ep.errorCodes)).toBe(true);
    }
  });

  it("error codes are well-formed (status/code/when)", () => {
    for (const ep of EXTERNAL_API_ENDPOINTS) {
      for (const err of ep.errorCodes) {
        expect(typeof err.status).toBe("number");
        expect(err.status).toBeGreaterThanOrEqual(400);
        expect(err.status).toBeLessThan(600);
        expect(typeof err.code).toBe("string");
        expect(err.code.length).toBeGreaterThan(0);
        expect(typeof err.when).toBe("string");
        expect(err.when.length).toBeGreaterThan(0);
      }
    }
  });

  it("has no duplicate method+path identifiers", () => {
    const ids = EXTERNAL_API_ENDPOINTS.map((ep) => `${ep.method} ${ep.path}`);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("permits duplicate paths only across different HTTP methods", () => {
    // A given path may be hit with multiple verbs (e.g. GET vs POST on the
    // webhooks collection). But the same (method, path) pair must never
    // appear twice — this catches accidental copy-paste regressions.
    const seen = new Map<string, Set<string>>();
    for (const ep of EXTERNAL_API_ENDPOINTS) {
      const methods = seen.get(ep.path) ?? new Set<string>();
      expect(methods.has(ep.method)).toBe(false);
      methods.add(ep.method);
      seen.set(ep.path, methods);
    }
  });

  it("groups endpoints into known folders", () => {
    const folders = new Set(EXTERNAL_API_ENDPOINTS.map((ep) => ep.folder));
    expect(folders.has("Returns")).toBe(true);
    expect(folders.has("Settings")).toBe(true);
    expect(folders.has("Webhooks")).toBe(true);
  });

  it("write/manage operations use POST or DELETE; reads use GET", () => {
    for (const ep of EXTERNAL_API_ENDPOINTS) {
      if (ep.permission.startsWith("read_")) {
        expect(ep.method).toBe("GET");
      }
      if (ep.permission.startsWith("write_") || ep.permission === "manage_webhooks") {
        // manage_webhooks covers list (GET), register (POST), delete (DELETE).
        expect(["GET", "POST", "DELETE"]).toContain(ep.method);
      }
    }
  });

  it("query params (when present) are well-formed", () => {
    for (const ep of EXTERNAL_API_ENDPOINTS) {
      if (!ep.queryParams) continue;
      for (const q of ep.queryParams) {
        expect(typeof q.key).toBe("string");
        expect(q.key.length).toBeGreaterThan(0);
        expect(typeof q.description).toBe("string");
        expect(typeof q.example).toBe("string");
      }
    }
  });

  it("request body (when present) has description and example object", () => {
    for (const ep of EXTERNAL_API_ENDPOINTS) {
      if (!ep.requestBody) continue;
      expect(typeof ep.requestBody.description).toBe("string");
      expect(ep.requestBody.description.length).toBeGreaterThan(0);
      expect(typeof ep.requestBody.example).toBe("object");
      expect(ep.requestBody.example).not.toBeNull();
    }
  });
});

describe("WEBHOOK_EVENTS", () => {
  it("is a non-empty list of strings", () => {
    expect(Array.isArray(WEBHOOK_EVENTS)).toBe(true);
    expect(WEBHOOK_EVENTS.length).toBeGreaterThan(0);
    for (const evt of WEBHOOK_EVENTS) {
      expect(typeof evt).toBe("string");
      expect(evt.length).toBeGreaterThan(0);
    }
  });

  it("each event is namespaced with a dot (e.g. return.created)", () => {
    for (const evt of WEBHOOK_EVENTS) {
      expect(evt).toMatch(/^[a-z]+\.[a-z_]+$/);
    }
  });

  it("contains expected return lifecycle events", () => {
    expect(WEBHOOK_EVENTS).toContain("return.created");
    expect(WEBHOOK_EVENTS).toContain("return.approved");
    expect(WEBHOOK_EVENTS).toContain("return.rejected");
    expect(WEBHOOK_EVENTS).toContain("return.refunded");
    expect(WEBHOOK_EVENTS).toContain("return.status_changed");
  });

  it("has no duplicate event names", () => {
    const set = new Set(WEBHOOK_EVENTS);
    expect(set.size).toBe(WEBHOOK_EVENTS.length);
  });
});
