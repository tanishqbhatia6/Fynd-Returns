import { describe, it, expect } from "vitest";
import { parseJsonArray, parseJsonObject } from "../parse-json";

describe("parseJsonArray", () => {
  const fallback = ["default"];

  it("parses a valid JSON array string", () => {
    const result = parseJsonArray('[1, 2, 3]', fallback);
    expect(result).toEqual([1, 2, 3]);
  });

  it("parses a JSON array of objects", () => {
    const result = parseJsonArray('[{"id": 1}, {"id": 2}]', []);
    expect(result).toEqual([{ id: 1 }, { id: 2 }]);
  });

  it("returns fallback for null input", () => {
    expect(parseJsonArray(null, fallback)).toEqual(fallback);
  });

  it("returns fallback for undefined input", () => {
    expect(parseJsonArray(undefined, fallback)).toEqual(fallback);
  });

  it("returns fallback for empty string", () => {
    expect(parseJsonArray("", fallback)).toEqual(fallback);
  });

  it("returns fallback for whitespace-only string", () => {
    expect(parseJsonArray("   ", fallback)).toEqual(fallback);
  });

  it("returns fallback for invalid JSON", () => {
    expect(parseJsonArray("{not valid json", fallback)).toEqual(fallback);
  });

  it("returns fallback when parsed value is an object (not array)", () => {
    expect(parseJsonArray('{"key": "value"}', fallback)).toEqual(fallback);
  });

  it("returns fallback when parsed value is a string", () => {
    expect(parseJsonArray('"just a string"', fallback)).toEqual(fallback);
  });

  it("returns fallback when parsed value is a number", () => {
    expect(parseJsonArray("42", fallback)).toEqual(fallback);
  });

  it("returns an empty array when input is '[]'", () => {
    expect(parseJsonArray("[]", fallback)).toEqual([]);
  });

  it("handles nested arrays", () => {
    const result = parseJsonArray("[[1, 2], [3, 4]]", []);
    expect(result).toEqual([[1, 2], [3, 4]]);
  });
});

describe("parseJsonObject", () => {
  const fallback = { default: true } as Record<string, unknown>;

  it("parses a valid JSON object string", () => {
    const result = parseJsonObject('{"name": "test", "count": 5}', fallback);
    expect(result).toEqual({ name: "test", count: 5 });
  });

  it("returns fallback for null input", () => {
    expect(parseJsonObject(null, fallback)).toEqual(fallback);
  });

  it("returns fallback for undefined input", () => {
    expect(parseJsonObject(undefined, fallback)).toEqual(fallback);
  });

  it("returns fallback for empty string", () => {
    expect(parseJsonObject("", fallback)).toEqual(fallback);
  });

  it("returns fallback for whitespace-only string", () => {
    expect(parseJsonObject("   \n\t  ", fallback)).toEqual(fallback);
  });

  it("returns fallback for invalid JSON", () => {
    expect(parseJsonObject("not json", fallback)).toEqual(fallback);
  });

  it("returns fallback when parsed value is an array", () => {
    expect(parseJsonObject("[1, 2, 3]", fallback)).toEqual(fallback);
  });

  it("returns fallback when parsed value is a string", () => {
    expect(parseJsonObject('"hello"', fallback)).toEqual(fallback);
  });

  it("returns fallback when parsed value is a number", () => {
    expect(parseJsonObject("99", fallback)).toEqual(fallback);
  });

  it("returns fallback when parsed value is null", () => {
    expect(parseJsonObject("null", fallback)).toEqual(fallback);
  });

  it("parses an empty object", () => {
    const result = parseJsonObject("{}", fallback);
    expect(result).toEqual({});
  });

  it("parses nested objects", () => {
    const input = '{"outer": {"inner": true}}';
    const result = parseJsonObject(input, fallback);
    expect(result).toEqual({ outer: { inner: true } });
  });
});
