/**
 * Timezone-aware date range tests.
 *
 * Validates that "today" / "last 7 days" anchor on the merchant's local day
 * boundary, not the server's UTC clock. Without this, a merchant in
 * Asia/Kolkata (UTC+5:30) saw "today" as the UTC day, which is off by 5.5
 * hours — returns created late at night locally were missing from the dashboard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parseDateRange } from "../dashboard-date-utils";

describe("parseDateRange with timezone", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("today at 09:00 IST anchors to midnight IST", () => {
    vi.setSystemTime(new Date("2026-04-22T03:30:00.000Z")); // 09:00 IST
    const r = parseDateRange("today", null, null, "Asia/Kolkata");
    // Midnight IST 2026-04-22 == 2026-04-21T18:30:00Z
    expect(r.start.toISOString()).toBe("2026-04-21T18:30:00.000Z");
    expect(r.end.toISOString()).toBe("2026-04-22T18:29:59.999Z");
  });

  it("today in UTC matches today in UTC (no offset)", () => {
    vi.setSystemTime(new Date("2026-04-22T12:00:00.000Z"));
    const r = parseDateRange("today", null, null, "UTC");
    expect(r.start.toISOString()).toBe("2026-04-22T00:00:00.000Z");
    expect(r.end.toISOString()).toBe("2026-04-22T23:59:59.999Z");
  });

  it("invalid timezone string falls back to server-local silently", () => {
    vi.setSystemTime(new Date("2026-04-22T12:00:00.000Z"));
    // Contains a quote — fails our regex, treated as undefined → server-local time.
    // We just assert it doesn't crash and returns a plausible window. (The exact
    // values depend on the server tz, which we can't pin in this test.)
    const r = parseDateRange("today", null, null, "Asia/Kolkata'; DROP TABLE--");
    expect(r.start).toBeInstanceOf(Date);
    expect(r.end).toBeInstanceOf(Date);
    expect(r.end.getTime()).toBeGreaterThan(r.start.getTime());
  });

  it("last_7_days uses tz-anchored start", () => {
    vi.setSystemTime(new Date("2026-04-22T03:30:00.000Z")); // 09:00 IST
    const r = parseDateRange("last_7_days", null, null, "Asia/Kolkata");
    // start = midnight IST six days before 2026-04-22 = midnight IST 2026-04-16
    expect(r.start.toISOString()).toBe("2026-04-15T18:30:00.000Z");
  });

  it("New York DST transition — March spring forward", () => {
    // 2026-03-08 02:00 EST → 03:00 EDT. Test that "today" boundary still resolves.
    vi.setSystemTime(new Date("2026-03-08T15:00:00.000Z")); // 11:00 EDT same day
    const r = parseDateRange("today", null, null, "America/New_York");
    // Midnight EDT 2026-03-08 == 05:00 UTC (already DST-shifted).
    expect(r.start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
  });
});
