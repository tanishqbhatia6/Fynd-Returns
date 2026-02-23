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

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function endOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
}

function startOfWeek(d: Date): Date {
  const x = new Date(d);
  const day = x.getDay();
  const diff = x.getDate() - day + (day === 0 ? -6 : 1);
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
  to: string | null
): DateRangeResult {
  const now = new Date();
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);

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
    return {
      start,
      end,
      label: `${start.toLocaleDateString()} – ${end.toLocaleDateString()}`,
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
        start: startOfDay(y),
        end: endOfDay(y),
        label: "Yesterday",
        preset: "yesterday",
      };
    }
    case "last_7_days": {
      const d7 = new Date(now);
      d7.setDate(d7.getDate() - 6);
      return {
        start: startOfDay(d7),
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
        start: startOfDay(d30),
        end: todayEnd,
        label: "Last 30 days",
        preset: "last_30_days",
      };
    }
    case "last_90_days": {
      const d90 = new Date(now);
      d90.setDate(d90.getDate() - 89);
      return {
        start: startOfDay(d90),
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
        start: startOfDay(new Date(now.getTime() - 29 * 24 * 60 * 60 * 1000)),
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
