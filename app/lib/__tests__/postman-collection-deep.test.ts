import { describe, it, expect } from "vitest";
import { generatePostmanCollection } from "../postman-collection.server";

/* Pure generator — no IO. Parse the result as JSON and assert
   structure, not strings, so minor copy tweaks don't break it. */

describe("generatePostmanCollection", () => {
  const collection = JSON.parse(generatePostmanCollection("https://returnpromax.app"));

  it("produces valid Postman Collection v2.1.0 schema", () => {
    expect(collection.info.schema).toBe(
      "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    );
    expect(collection.info.name).toBe("ReturnProMax External API");
  });

  it("includes a prominent SECURITY warning in the intro", () => {
    expect(collection.info.description).toMatch(/SECURITY/);
    expect(collection.info.description).toMatch(/rotate the key/i);
  });

  it("defines the collection-level {{base_url}} variable from input", () => {
    const baseVar = collection.variable.find((v: { key: string; value: string }) => v.key === "base_url");
    expect(baseVar?.value).toBe("https://returnpromax.app");
  });

  it("defines an {{api_key}} variable with an intentionally-obvious placeholder", () => {
    const keyVar = collection.variable.find((v: { key: string; value: string }) => v.key === "api_key");
    expect(keyVar?.value).toBe("rpm_YOUR_API_KEY_HERE");
  });

  it("configures apikey auth in the X-API-Key header", () => {
    expect(collection.auth.type).toBe("apikey");
    const keyField = collection.auth.apikey.find((f: { key: string; value: string }) => f.key === "key");
    const placement = collection.auth.apikey.find((f: { key: string; value: string }) => f.key === "in");
    expect(keyField?.value).toBe("X-API-Key");
    expect(placement?.value).toBe("header");
  });

  it("groups endpoints into folders", () => {
    expect(Array.isArray(collection.item)).toBe(true);
    expect(collection.item.length).toBeGreaterThan(0);
    for (const folder of collection.item) {
      expect(typeof folder.name).toBe("string");
      expect(Array.isArray(folder.item)).toBe(true);
    }
  });

  it("every request includes Content-Type + X-API-Key headers", () => {
    for (const folder of collection.item) {
      for (const req of folder.item) {
        const headers = req.request.header;
        expect(headers.some((h: { key: string }) => h.key === "Content-Type")).toBe(true);
        expect(headers.some((h: { key: string }) => h.key === "X-API-Key")).toBe(true);
      }
    }
  });

  it("every request URL uses the {{base_url}} variable", () => {
    for (const folder of collection.item) {
      for (const req of folder.item) {
        expect(req.request.url.raw).toMatch(/^\{\{base_url\}\}/);
        expect(req.request.url.host).toEqual(["{{base_url}}"]);
      }
    }
  });

  it("POST webhook-create endpoints return 201 in example response", () => {
    for (const folder of collection.item) {
      for (const req of folder.item) {
        const isWebhookCreate =
          req.request.method === "POST" &&
          req.request.url.raw.includes("webhooks") &&
          !req.request.url.raw.includes(":id");
        if (isWebhookCreate) {
          expect(req.response[0].code).toBe(201);
        }
      }
    }
  });

  it("non-webhook-create endpoints return 200 in example response", () => {
    for (const folder of collection.item) {
      for (const req of folder.item) {
        const isWebhookCreate =
          req.request.method === "POST" &&
          req.request.url.raw.includes("webhooks") &&
          !req.request.url.raw.includes(":id");
        if (!isWebhookCreate) {
          expect(req.response[0].code).toBe(200);
        }
      }
    }
  });

  it("bodies are attached as raw JSON when the endpoint has a requestBody", () => {
    for (const folder of collection.item) {
      for (const req of folder.item) {
        if (req.request.body) {
          expect(req.request.body.mode).toBe("raw");
          expect(() => JSON.parse(req.request.body.raw)).not.toThrow();
          expect(req.request.body.options.raw.language).toBe("json");
        }
      }
    }
  });

  it("query params are marked disabled by default (merchant enables them)", () => {
    for (const folder of collection.item) {
      for (const req of folder.item) {
        if (req.request.url.query) {
          for (const q of req.request.url.query) {
            expect(q.disabled).toBe(true);
          }
        }
      }
    }
  });

  it("description includes the permission name for each endpoint", () => {
    for (const folder of collection.item) {
      for (const req of folder.item) {
        expect(req.request.description).toMatch(/Permission:/);
      }
    }
  });

  it("is deterministic — same baseUrl in, same JSON out", () => {
    const a = generatePostmanCollection("https://x.com");
    const b = generatePostmanCollection("https://x.com");
    expect(a).toBe(b);
  });
});
