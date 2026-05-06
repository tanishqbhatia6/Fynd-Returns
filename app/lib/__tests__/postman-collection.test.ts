/**
 * Tests for postman-collection.server.ts: generatePostmanCollection produces a
 * valid Postman v2.1.0 JSON document. Cover JSON shape, baseUrl substitution,
 * auth headers, and item/folder counts. Pure (no IO) — parse the result and
 * assert structure rather than strings so harmless copy edits don't break it.
 */
import { describe, it, expect } from "vitest";
import { generatePostmanCollection } from "../postman-collection.server";
import { EXTERNAL_API_ENDPOINTS } from "../api-docs-data";

describe("generatePostmanCollection — JSON shape", () => {
  it("returns a string that parses as JSON", () => {
    const out = generatePostmanCollection("https://example.com");
    expect(typeof out).toBe("string");
    expect(() => JSON.parse(out)).not.toThrow();
  });

  it("emits the v2.1.0 schema URL and collection name", () => {
    const c = JSON.parse(generatePostmanCollection("https://example.com"));
    expect(c.info.schema).toBe(
      "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
    );
    expect(c.info.name).toBe("ReturnProMax External API");
  });

  it("top-level shape has info, variable, auth, item arrays/objects", () => {
    const c = JSON.parse(generatePostmanCollection("https://x.test"));
    expect(c.info).toBeTypeOf("object");
    expect(Array.isArray(c.variable)).toBe(true);
    expect(c.auth).toBeTypeOf("object");
    expect(Array.isArray(c.item)).toBe(true);
  });

  it("output is pretty-printed with 2-space indent", () => {
    const out = generatePostmanCollection("https://x.test");
    // The second line of pretty-printed JSON.stringify(_, null, 2) starts with
    // exactly two spaces — locks in the formatting contract.
    expect(out.split("\n")[1].startsWith("  ")).toBe(true);
  });
});

describe("generatePostmanCollection — baseUrl substitution", () => {
  it("uses the provided baseUrl as the {{base_url}} variable value", () => {
    const c = JSON.parse(generatePostmanCollection("https://my-shop.example.com"));
    const baseVar = c.variable.find((v: { key: string }) => v.key === "base_url");
    expect(baseVar?.value).toBe("https://my-shop.example.com");
  });

  it("substitutes empty string baseUrl without throwing", () => {
    const c = JSON.parse(generatePostmanCollection(""));
    const baseVar = c.variable.find((v: { key: string }) => v.key === "base_url");
    expect(baseVar?.value).toBe("");
  });

  it("does NOT inline the baseUrl into request URLs (uses placeholder instead)", () => {
    // This is important: if we inlined, exporting the collection would leak
    // the merchant's domain into every request. Verify only the variable holds
    // the literal — request URLs reference {{base_url}}.
    const c = JSON.parse(generatePostmanCollection("https://leak-me.example"));
    for (const folder of c.item) {
      for (const req of folder.item) {
        expect(req.request.url.raw).not.toContain("leak-me.example");
        expect(req.request.url.raw.startsWith("{{base_url}}")).toBe(true);
      }
    }
  });

  it("renders request URL host as ['{{base_url}}']", () => {
    const c = JSON.parse(generatePostmanCollection("https://x.test"));
    for (const folder of c.item) {
      for (const req of folder.item) {
        expect(req.request.url.host).toEqual(["{{base_url}}"]);
      }
    }
  });
});

describe("generatePostmanCollection — auth", () => {
  it("declares apikey-type auth in the X-API-Key header", () => {
    const c = JSON.parse(generatePostmanCollection("https://x.test"));
    expect(c.auth.type).toBe("apikey");
    const findField = (k: string) =>
      c.auth.apikey.find((f: { key: string; value: string }) => f.key === k);
    expect(findField("key")?.value).toBe("X-API-Key");
    expect(findField("value")?.value).toBe("{{api_key}}");
    expect(findField("in")?.value).toBe("header");
  });

  it("ships an obvious placeholder api_key (never a real key)", () => {
    const c = JSON.parse(generatePostmanCollection("https://x.test"));
    const k = c.variable.find((v: { key: string }) => v.key === "api_key");
    expect(k?.value).toBe("rpm_YOUR_API_KEY_HERE");
  });

  it("every request also carries an X-API-Key header at the request level", () => {
    // Belt-and-suspenders: collection-level auth + per-request header so that
    // merchants who clone a single request still see the auth header.
    const c = JSON.parse(generatePostmanCollection("https://x.test"));
    for (const folder of c.item) {
      for (const req of folder.item) {
        const h = req.request.header.find((x: { key: string }) => x.key === "X-API-Key");
        expect(h?.value).toBe("{{api_key}}");
      }
    }
  });

  it("intro description warns against committing real keys", () => {
    const c = JSON.parse(generatePostmanCollection("https://x.test"));
    expect(c.info.description).toMatch(/SECURITY/);
    expect(c.info.description).toMatch(/rotate the key/i);
  });
});

describe("generatePostmanCollection — item/folder counts", () => {
  it("produces one folder per distinct ep.folder value", () => {
    const c = JSON.parse(generatePostmanCollection("https://x.test"));
    const expectedFolders = new Set(EXTERNAL_API_ENDPOINTS.map((e) => e.folder));
    expect(c.item.length).toBe(expectedFolders.size);
    const got = new Set(c.item.map((f: { name: string }) => f.name));
    expect(got).toEqual(expectedFolders);
  });

  it("flattened item count equals total endpoint count", () => {
    const c = JSON.parse(generatePostmanCollection("https://x.test"));
    const total = c.item.reduce((sum: number, f: { item: unknown[] }) => sum + f.item.length, 0);
    expect(total).toBe(EXTERNAL_API_ENDPOINTS.length);
  });

  it("each folder contains only endpoints whose ep.folder matches the folder name", () => {
    const c = JSON.parse(generatePostmanCollection("https://x.test"));
    for (const folder of c.item) {
      const expectedNames = EXTERNAL_API_ENDPOINTS.filter((e) => e.folder === folder.name).map(
        (e) => e.name,
      );
      const gotNames = folder.item.map((r: { name: string }) => r.name);
      // Order within folder is insertion order from the source registry.
      expect(gotNames).toEqual(expectedNames);
    }
  });

  it("preserves first-seen folder order from the registry", () => {
    const c = JSON.parse(generatePostmanCollection("https://x.test"));
    const seen: string[] = [];
    for (const e of EXTERNAL_API_ENDPOINTS) {
      if (!seen.includes(e.folder)) seen.push(e.folder);
    }
    expect(c.item.map((f: { name: string }) => f.name)).toEqual(seen);
  });
});

describe("generatePostmanCollection — request semantics", () => {
  it("POST webhooks-create endpoints respond 201, others 200", () => {
    const c = JSON.parse(generatePostmanCollection("https://x.test"));
    for (const folder of c.item) {
      for (const req of folder.item) {
        const isWebhookCreate =
          req.request.method === "POST" &&
          req.request.url.raw.includes("webhooks") &&
          !req.request.url.raw.includes(":id");
        expect(req.response[0].code).toBe(isWebhookCreate ? 201 : 200);
      }
    }
  });

  it("attaches a raw-JSON body whenever the endpoint declares requestBody", () => {
    const c = JSON.parse(generatePostmanCollection("https://x.test"));
    for (const folder of c.item) {
      for (const req of folder.item) {
        const ep = EXTERNAL_API_ENDPOINTS.find((e) => e.name === req.name);
        if (ep?.requestBody) {
          expect(req.request.body.mode).toBe("raw");
          expect(req.request.body.options.raw.language).toBe("json");
          expect(() => JSON.parse(req.request.body.raw)).not.toThrow();
        } else {
          expect(req.request.body).toBeUndefined();
        }
      }
    }
  });

  it("query params are emitted disabled-by-default with example values", () => {
    const c = JSON.parse(generatePostmanCollection("https://x.test"));
    for (const folder of c.item) {
      for (const req of folder.item) {
        const ep = EXTERNAL_API_ENDPOINTS.find((e) => e.name === req.name);
        if (ep?.queryParams && ep.queryParams.length > 0) {
          expect(req.request.url.query).toBeDefined();
          expect(req.request.url.query.length).toBe(ep.queryParams.length);
          for (const q of req.request.url.query) {
            expect(q.disabled).toBe(true);
          }
        }
      }
    }
  });

  it("description appends 'Permission: <perm>' for every endpoint", () => {
    const c = JSON.parse(generatePostmanCollection("https://x.test"));
    for (const folder of c.item) {
      for (const req of folder.item) {
        const ep = EXTERNAL_API_ENDPOINTS.find((e) => e.name === req.name);
        expect(req.request.description).toContain(`Permission: ${ep!.permission}`);
      }
    }
  });
});

describe("generatePostmanCollection — determinism", () => {
  it("returns byte-identical output for the same input", () => {
    const a = generatePostmanCollection("https://same.test");
    const b = generatePostmanCollection("https://same.test");
    expect(a).toBe(b);
  });

  it("differs only in baseUrl substitution between distinct inputs", () => {
    const a = generatePostmanCollection("https://a.test");
    const b = generatePostmanCollection("https://b.test");
    expect(a).not.toBe(b);
    // Replacing 'a.test' with 'b.test' in the first should yield the second.
    expect(a.replaceAll("a.test", "b.test")).toBe(b);
  });
});
