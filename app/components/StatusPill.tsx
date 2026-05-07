import * as React from "react";
import { getStatusColor, getStatusBg } from "../lib/status-colors";

/**
 * Single source of truth for return-status visual rendering across
 * every admin surface. Replaces 6+ ad-hoc inline-styled pill divs that
 * had drifted in padding/font-size/border across pages.
 *
 * Tone is derived from the status string via lib/status-colors so
 * "approved" / "Approved" / "APPROVED" all render the same.
 */
export interface StatusPillProps {
  status: string;
  /** Display label override. Falls back to a Title Cased version of status. */
  label?: string;
  /** Pill size — tight rows can pass "small" to reduce vertical footprint. */
  size?: "small" | "base";
}

function titleCase(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, " ").toLowerCase();
}

export function StatusPill({ status, label, size = "base" }: StatusPillProps) {
  const color = getStatusColor(status);
  const bg = getStatusBg(status);
  const display = label ?? titleCase(status);
  const isSmall = size === "small";
  return (
    <span
      className="app-status-pill"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: isSmall ? "2px 8px" : "4px 10px",
        borderRadius: 999,
        fontSize: isSmall ? 11 : 12,
        fontWeight: 600,
        lineHeight: 1.4,
        color,
        background: bg,
        border: `1px solid ${color}33`,
        whiteSpace: "nowrap",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: isSmall ? 6 : 7,
          height: isSmall ? 6 : 7,
          borderRadius: "50%",
          background: color,
          display: "inline-block",
        }}
      />
      {display}
    </span>
  );
}
