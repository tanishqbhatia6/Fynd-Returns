/**
 * Tests for parse-json.ts: safe JSON parsing helpers used by settings loaders
 * across the app. These helpers must NEVER throw — a regression here would
 * crash request handlers that decode merchant-supplied JSON columns.
 */
import { describe, it, expect } from "vitest";
import { parseJsonArray, parseJsonObject } from "../parse-json";

describe("parseJsonArray", () => {
  const fallback = ["default"];

  it("parses a valid JSON array of primitives", () => {
    expect(parseJsonArray("[1, 2, 3]", fallback)).toEqual([1, 2, 3]);
  });

  it("parses a JSON array of objects", () => {
    expect(parseJsonArray('[{"id":1},{"id":2}]', [])).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("returns an empty array when input is '[]' (does not coerce to fallback)", () => {
    expect(parseJsonArray("[]", fallback)).toEqual([]);
  });

  it("preserves nested arrays", () => {
    expect(parseJsonArray("[[1,2],[3,4]]", [])).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("returns fallback for null", () => {
    expect(parseJsonArray(null, fallback)).toBe(fallback);
  });

  it("returns fallback for undefined", () => {
    expect(parseJsonArray(undefined, fallback)).toBe(fallback);
  });

  it("returns fallback for empty string", () => {
    expect(parseJsonArray("", fallback)).toBe(fallback);
  });

  it("returns fallback for whitespace-only string", () => {
    expect(parseJsonArray("   \n\t  ", fallback)).toBe(fallback);
  });

  it("returns fallback for malformed JSON without throwing", () => {
    expect(() => parseJsonArray("{not valid json", fallback)).not.toThrow();
    expect(parseJsonArray("{not valid json", fallback)).toBe(fallback);
  });

  it("returns fallback when parsed value is an object (wrong shape)", () => {
    expect(parseJsonArray('{"key":"value"}', fallback)).toBe(fallback);
  });

  it("returns fallback when parsed value is a string literal", () => {
    expect(parseJsonArray('"just a string"', fallback)).toBe(fallback);
  });

  it("returns fallback when parsed value is a number", () => {
    expect(parseJsonArray("42", fallback)).toBe(fallback);
  });

  it("returns fallback when parsed value is a boolean", () => {
    expect(parseJsonArray("true", fallback)).toBe(fallback);
  });

  it("returns fallback when parsed value is null literal", () => {
    expect(parseJsonArray("null", fallback)).toBe(fallback);
  });

  it("tolerates surrounding whitespace around a valid array", () => {
    expect(parseJsonArray("  [1,2]  ", fallback)).toEqual([1, 2]);
  });
});

describe("parseJsonObject", () => {
  const fallback = { default: true } as Record<string, unknown>;

  it("parses a valid JSON object string", () => {
    expect(parseJsonObject('{"name":"test","count":5}', fallback)).toEqual({
      name: "test",
      count: 5,
    });
  });

  it("parses an empty object (does not coerce to fallback)", () => {
    expect(parseJsonObject("{}", fallback)).toEqual({});
  });

  it("preserves nested objects", () => {
    expect(parseJsonObject('{"outer":{"inner":true}}', fallback)).toEqual({
      outer: { inner: true },
    });
  });

  it("returns fallback for null", () => {
    expect(parseJsonObject(null, fallback)).toBe(fallback);
  });

  it("returns fallback for undefined", () => {
    expect(parseJsonObject(undefined, fallback)).toBe(fallback);
  });

  it("returns fallback for empty string", () => {
    expect(parseJsonObject("", fallback)).toBe(fallback);
  });

  it("returns fallback for whitespace-only string", () => {
    expect(parseJsonObject("   \n\t  ", fallback)).toBe(fallback);
  });

  it("returns fallback for malformed JSON without throwing", () => {
    expect(() => parseJsonObject("not json", fallback)).not.toThrow();
    expect(parseJsonObject("not json", fallback)).toBe(fallback);
  });

  it("returns fallback when parsed value is an array (wrong shape)", () => {
    expect(parseJsonObject("[1,2,3]", fallback)).toBe(fallback);
  });

  it("returns fallback when parsed value is a string literal", () => {
    expect(parseJsonObject('"hello"', fallback)).toBe(fallback);
  });

  it("returns fallback when parsed value is a number", () => {
    expect(parseJsonObject("99", fallback)).toBe(fallback);
  });

  it("returns fallback when parsed value is a boolean", () => {
    expect(parseJsonObject("false", fallback)).toBe(fallback);
  });

  it("returns fallback when parsed value is null literal", () => {
    // `null` is technically typeof 'object' — guard must explicitly reject it.
    expect(parseJsonObject("null", fallback)).toBe(fallback);
  });

  it("tolerates surrounding whitespace around a valid object", () => {
    expect(parseJsonObject('  {"a":1}  ', fallback)).toEqual({ a: 1 });
  });
});
