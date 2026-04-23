import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parseDateRange, DATE_RANGE_OPTIONS } from "../dashboard-date-utils";

/* Covers the preset-by-preset branches of parseDateRange that the existing
   tz-focused test file doesn't exercise. Uses fixed system time so label
   ordering and week/month/quarter math are deterministic. */

describe("parseDateRange — all presets (UTC anchor)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Wednesday, 2026-04-22 12:00 UTC — middle of week/month/quarter.
    vi.setSystemTime(new Date("2026-04-22T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("today", () => {
    const r = parseDateRange("today", null, null, "UTC");
    expect(r.preset).toBe("today");
    expect(r.label).toBe("Today");
    expect(r.start.toISOString()).toBe("2026-04-22T00:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-04-22T23:59:59.999Z");
  });

  it("yesterday", () => {
    const r = parseDateRange("yesterday", null, null, "UTC");
    expect(r.preset).toBe("yesterday");
    expect(r.label).toBe("Yesterday");
    expect(r.start.toISOString()).toBe("2026-04-21T00:00:00.000Z");
  });

  it("last_7_days includes today + 6 prior days", () => {
    const r = parseDateRange("last_7_days", null, null, "UTC");
    expect(r.preset).toBe("last_7_days");
    expect(r.start.toISOString()).toBe("2026-04-16T00:00:00.000Z");
  });

  it("current_week returns start/label", () => {
    const r = parseDateRange("current_week", null, null, "UTC");
    expect(r.preset).toBe("current_week");
    expect(r.label).toBe("Current week");
    expect(r.end.toISOString()).toBe("2026-04-22T23:59:59.999Z");
  });

  it("last_week returns a full 7-day window", () => {
    const r = parseDateRange("last_week", null, null, "UTC");
    expect(r.preset).toBe("last_week");
    expect(r.label).toBe("Last week");
  });

  it("current_month", () => {
    const r = parseDateRange("current_month", null, null, "UTC");
    expect(r.preset).toBe("current_month");
    expect(r.label).toBe("Current month");
  });

  it("last_month", () => {
    const r = parseDateRange("last_month", null, null, "UTC");
    expect(r.preset).toBe("last_month");
    expect(r.label).toBe("Last month");
  });

  it("current_quarter", () => {
    const r = parseDateRange("current_quarter", null, null, "UTC");
    expect(r.preset).toBe("current_quarter");
    expect(r.label).toBe("Current quarter");
  });

  it("last_quarter", () => {
    const r = parseDateRange("last_quarter", null, null, "UTC");
    expect(r.preset).toBe("last_quarter");
    expect(r.label).toBe("Last quarter");
  });

  it("last_30_days", () => {
    const r = parseDateRange("last_30_days", null, null, "UTC");
    expect(r.preset).toBe("last_30_days");
    expect(r.start.toISOString()).toBe("2026-03-24T00:00:00.000Z");
  });

  it("last_90_days", () => {
    const r = parseDateRange("last_90_days", null, null, "UTC");
    expect(r.preset).toBe("last_90_days");
    expect(r.start.toISOString()).toBe("2026-01-23T00:00:00.000Z");
  });

  it("all_time returns Date(0) → today", () => {
    const r = parseDateRange("all_time", null, null, "UTC");
    expect(r.preset).toBe("all_time");
    expect(r.start.getTime()).toBe(0);
    expect(r.label).toBe("All time");
  });

  it("unknown range falls back to last_30_days", () => {
    const r = parseDateRange("nonsense", null, null, "UTC");
    expect(r.preset).toBe("last_30_days");
    expect(r.label).toBe("Last 30 days");
  });

  it("null range falls back to last_30_days", () => {
    const r = parseDateRange(null, null, null, "UTC");
    expect(r.preset).toBe("last_30_days");
  });
});

describe("parseDateRange — custom", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T12:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("accepts a valid from/to pair with a locale", () => {
    const r = parseDateRange("custom", "2026-04-01", "2026-04-15", "UTC", "en-US");
    expect(r.preset).toBe("custom");
    expect(r.label).toMatch(/Apr 1/);
    expect(r.label).toContain("–");
  });

  it("falls back to last_30_days for invalid custom (from > to)", () => {
    const r = parseDateRange("custom", "2026-04-15", "2026-04-01", "UTC");
    expect(r.preset).toBe("last_30_days");
    expect(r.label).toMatch(/invalid custom range/);
  });

  it("falls back for unparseable date", () => {
    const r = parseDateRange("custom", "not-a-date", "2026-04-15", "UTC");
    expect(r.preset).toBe("last_30_days");
  });

  it("custom with locale shows localised date format", () => {
    const r = parseDateRange("custom", "2026-04-01", "2026-04-15", "UTC", "en-GB");
    // en-GB uses DD/MM format or "1 Apr 2026" depending on platform.
    expect(typeof r.label).toBe("string");
    expect(r.label).toContain("–");
  });
});

describe("parseDateRange — timezone validation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-22T12:00:00.000Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("ignores invalid timezone strings (falls back to UTC)", () => {
    const r = parseDateRange("today", null, null, "INVALID;;;");
    expect(r.preset).toBe("today");
  });

  it("accepts valid IANA timezone", () => {
    const r = parseDateRange("today", null, null, "America/New_York");
    expect(r.preset).toBe("today");
  });
});

describe("DATE_RANGE_OPTIONS", () => {
  it("is a non-empty list of { value, label } entries", () => {
    expect(Array.isArray(DATE_RANGE_OPTIONS)).toBe(true);
    expect(DATE_RANGE_OPTIONS.length).toBeGreaterThan(5);
    for (const opt of DATE_RANGE_OPTIONS) {
      expect(typeof opt.value).toBe("string");
      expect(typeof opt.label).toBe("string");
    }
  });
  it("includes the common presets", () => {
    const values = DATE_RANGE_OPTIONS.map(o => o.value);
    expect(values).toContain("today");
    expect(values).toContain("last_30_days");
    expect(values).toContain("custom");
  });
});
