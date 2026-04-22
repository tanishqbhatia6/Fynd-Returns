/**
 * Shared status color definitions used across admin UI.
 * Single source of truth — avoids inconsistent color values.
 *
 * Foreground / background pairs are picked to meet WCAG AA (≥ 4.5:1 for normal
 * text). Previous values failed for `pending`, `initiated`, and `approved` —
 * they used vivid brand colors on near-white backgrounds, hovering around
 * 3.0–3.5:1. Darkening the text fixes the contrast without changing the visual
 * language. (P2 a11y finding from QA audit.)
 */

export const STATUS_COLORS: Record<string, string> = {
  pending: "#b45309",      // amber-700 — was amber-600 (failed AA on amber-50 bg)
  processing: "#1d4ed8",   // blue-700  — was blue-500 (marginal)
  "in progress": "#1d4ed8",
  approved: "#047857",     // emerald-700 — was emerald-600 (failed AA)
  completed: "#1d4ed8",
  rejected: "#b91c1c",     // red-700 — was red-600 (marginally above 4.5:1; bump for safety)
  cancelled: "#475569",    // slate-600 — was slate-500
  initiated: "#b45309",    // same as pending — was amber-500 (failed AA)
};

export const STATUS_BG: Record<string, string> = {
  pending: "#fffbeb",
  processing: "#eff6ff",
  "in progress": "#eff6ff",
  approved: "#ecfdf5",
  completed: "#eff6ff",
  rejected: "#fef2f2",
  cancelled: "#f8fafc",
  initiated: "#fffbeb",
};

export const STATUS_LABELS: Record<string, string> = {
  pending: "Pending",
  processing: "Processing",
  "in progress": "In Progress",
  completed: "Completed",
  approved: "Approved",
  rejected: "Rejected",
  cancelled: "Cancelled",
  initiated: "Initiated",
};

export function getStatusColor(status: string): string {
  return STATUS_COLORS[status.toLowerCase().replace(/\s+/g, " ")] ?? "#64748b";
}

export function getStatusBg(status: string): string {
  return STATUS_BG[status.toLowerCase()] ?? "#f8fafc";
}
