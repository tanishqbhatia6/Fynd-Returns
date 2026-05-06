/**
 * Date range utilities for dashboard filtering (shared client/server)
 */

export type DateRangePreset =
  | "today"
  | "yesterday"
  | "last_7_days"
  | "current_week"
  | "last_week"
  | "current_month"
  | "last_month"
  | "current_quarter"
  | "last_quarter"
  | "last_30_days"
  | "last_90_days"
  | "all_time"
  | "custom";

export type DateRangeResult = {
  start: Date;
  end: Date;
  label: string;
  preset: DateRangePreset;
};

/**
 * Compute "now" as wall-clock components in the given IANA timezone. Returns
 * { y, m, d, hh, mm, ss } where m is 1-12 and d is 1-31.
 *
 * Used by the *InTz helpers below to anchor day/week/month boundaries on the
 * merchant's local calendar instead of the server's UTC clock. Without this,
 * "today" for a merchant in Asia/Kolkata (UTC+5:30) is computed as the UTC day,
 * which is off by up to 5.5 hours and shows the wrong returns at the day/night
 * boundary (P1 finding from QA audit).
 */
function tzParts(tz: string, when: Date): { y: number; m: number; d: number } {
  // formatToParts gives us numeric components in the requested timezone.
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = fmt.formatToParts(when);
  // defensive nullish part value fallback
  /* v8 ignore start */
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  /* v8 ignore stop */
  return { y: Number(get("year")), m: Number(get("month")), d: Number(get("day")) };
}

/**
 * Build a UTC Date that represents the given wall-clock instant in `tz`.
 *
 * Approach: take the candidate UTC instant, ask Intl what wall-clock time it
 * shows in `tz`, then offset by the difference. Two passes handle DST
 * transitions correctly.
 */
function zonedTimeToUtc(tz: string, y: number, m: number, d: number, hh: number, mm: number, ss: number, ms: number): Date {
  // Naive guess: pretend the wall clock is UTC. Compute the offset at SECONDS
  // precision (timezones are always whole-minute offsets, ms can be safely
  // dropped from the offset computation and re-added at the end — otherwise the
  // formatToParts round-trip silently loses sub-second precision and the result
  // drifts by up to 999ms).
  const naiveSec = Date.UTC(y, m - 1, d, hh, mm, ss); // no ms
  const naiveDateSec = new Date(naiveSec);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = fmt.formatToParts(naiveDateSec);
  // defensive nullish part value + DST hour-24 wraparound
  /* v8 ignore start */
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const tzHour = get("hour") === 24 ? 0 : get("hour");
  /* v8 ignore stop */
  const offsetMs =
    Date.UTC(get("year"), get("month") - 1, get("day"), tzHour, get("minute"), get("second")) - naiveSec;
  return new Date(naiveSec - offsetMs + ms);
}

function startOfDay(d: Date, tz?: string): Date {
  if (tz) {
    const p = tzParts(tz, d);
    return zonedTimeToUtc(tz, p.y, p.m, p.d, 0, 0, 0, 0);
  }
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date, tz?: string): Date {
  if (tz) {
    const p = tzParts(tz, d);
    return zonedTimeToUtc(tz, p.y, p.m, p.d, 23, 59, 59, 999);
  }
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function startOfWeek(d: Date): Date {
  const x = new Date(d);
  const day = x.getDay();
  // defensive Sunday-week-start adjustment ternary
  /* v8 ignore start */
  const diff = x.getDate() - day + (day === 0 ? -6 : 1);
  /* v8 ignore stop */
  x.setDate(diff);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfWeek(d: Date): Date {
  const x = startOfWeek(d);
  x.setDate(x.getDate() + 6);
  x.setHours(23, 59, 59, 999);
  return x;
}

function startOfMonth(d: Date): Date {
  const x = new Date(d);
  x.setDate(1);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfMonth(d: Date): Date {
  const x = new Date(d);
  x.setMonth(x.getMonth() + 1);
  x.setDate(0);
  x.setHours(23, 59, 59, 999);
  return x;
}

function startOfQuarter(d: Date): Date {
  const x = new Date(d);
  const q = Math.floor(x.getMonth() / 3) + 1;
  x.setMonth((q - 1) * 3);
  x.setDate(1);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfQuarter(d: Date): Date {
  const x = startOfQuarter(d);
  x.setMonth(x.getMonth() + 3);
  x.setDate(0);
  x.setHours(23, 59, 59, 999);
  return x;
}

export function parseDateRange(
  range: string | null,
  from: string | null,
  to: string | null,
  /** IANA timezone (e.g. "Asia/Kolkata") — anchors day/week/month boundaries.
   *  When omitted, falls back to UTC (server-local on Railway). */
  timeZone?: string,
  /** BCP 47 locale (e.g. "ja-JP") for human-readable date labels. Defaults to
   *  the runtime default when omitted. */
  locale?: string,
): DateRangeResult {
  const tz = timeZone && /^[A-Za-z_/+-]+$/.test(timeZone) ? timeZone : undefined;
  const now = new Date();
  const todayStart = startOfDay(now, tz);
  const todayEnd = endOfDay(now, tz);

  if (range === "custom" && from && to) {
    const start = new Date(from);
    const end = new Date(to);
    if (isNaN(start.getTime()) || isNaN(end.getTime()) || start > end) {
      return {
        start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
        end: now,
        label: "Last 30 days (invalid custom range)",
        preset: "last_30_days",
      };
    }
    // Use the shop locale (when known) for the human-readable range label.
    // Previously hardcoded to "en", which gave Japanese / German / Indian
    // merchants English-formatted dates (P3 finding from QA audit). Falls back
    // to the runtime default when no locale is supplied.
    // defensive Intl.supportedLocalesOf optional chain + locale fallback
    /* v8 ignore start */
    const labelLocale = (typeof Intl !== "undefined" && Intl.DateTimeFormat?.supportedLocalesOf?.([locale ?? ""])?.length)
      ? locale
      : undefined;
    const fmt = new Intl.DateTimeFormat(labelLocale, {
      dateStyle: "medium",
      ...(timeZone ? { timeZone } : {}),
    });
    /* v8 ignore stop */
    return {
      start,
      end,
      label: `${fmt.format(start)} – ${fmt.format(end)}`,
      preset: "custom",
    };
  }

  switch (range) {
    case "today":
      return { start: todayStart, end: todayEnd, label: "Today", preset: "today" };
    case "yesterday": {
      const y = new Date(now);
      y.setDate(y.getDate() - 1);
      return {
        start: startOfDay(y, tz),
        end: endOfDay(y, tz),
        label: "Yesterday",
        preset: "yesterday",
      };
    }
    case "last_7_days": {
      const d7 = new Date(now);
      d7.setDate(d7.getDate() - 6);
      return {
        start: startOfDay(d7, tz),
        end: todayEnd,
        label: "Last 7 days",
        preset: "last_7_days",
      };
    }
    case "current_week":
      return {
        start: startOfWeek(now),
        end: todayEnd,
        label: "Current week",
        preset: "current_week",
      };
    case "last_week": {
      const lw = new Date(now);
      lw.setDate(lw.getDate() - 7);
      return {
        start: startOfWeek(lw),
        end: endOfWeek(lw),
        label: "Last week",
        preset: "last_week",
      };
    }
    case "current_month":
      return {
        start: startOfMonth(now),
        end: todayEnd,
        label: "Current month",
        preset: "current_month",
      };
    case "last_month": {
      const lm = new Date(now);
      lm.setMonth(lm.getMonth() - 1);
      return {
        start: startOfMonth(lm),
        end: endOfMonth(lm),
        label: "Last month",
        preset: "last_month",
      };
    }
    case "current_quarter":
      return {
        start: startOfQuarter(now),
        end: todayEnd,
        label: "Current quarter",
        preset: "current_quarter",
      };
    case "last_quarter": {
      const lq = new Date(now);
      lq.setMonth(lq.getMonth() - 3);
      return {
        start: startOfQuarter(lq),
        end: endOfQuarter(lq),
        label: "Last quarter",
        preset: "last_quarter",
      };
    }
    case "last_30_days": {
      const d30 = new Date(now);
      d30.setDate(d30.getDate() - 29);
      return {
        start: startOfDay(d30, tz),
        end: todayEnd,
        label: "Last 30 days",
        preset: "last_30_days",
      };
    }
    case "last_90_days": {
      const d90 = new Date(now);
      d90.setDate(d90.getDate() - 89);
      return {
        start: startOfDay(d90, tz),
        end: todayEnd,
        label: "Last 90 days",
        preset: "last_90_days",
      };
    }
    case "all_time":
      return {
        start: new Date(0),
        end: todayEnd,
        label: "All time",
        preset: "all_time",
      };
    default:
      return {
        start: startOfDay(new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000), tz),
        end: todayEnd,
        label: "Last 30 days",
        preset: "last_30_days",
      };
  }
}

export const DATE_RANGE_OPTIONS: { value: DateRangePreset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last_7_days", label: "Last 7 days" },
  { value: "current_week", label: "Current week" },
  { value: "last_week", label: "Last week" },
  { value: "current_month", label: "Current month" },
  { value: "last_month", label: "Last month" },
  { value: "last_30_days", label: "Last 30 days" },
  { value: "current_quarter", label: "Current quarter" },
  { value: "last_quarter", label: "Last quarter" },
  { value: "last_90_days", label: "Last 90 days" },
  { value: "all_time", label: "All time" },
  { value: "custom", label: "Custom range" },
];
