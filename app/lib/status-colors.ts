/**
 * Shared status color definitions used across admin UI.
 * Single source of truth — avoids inconsistent color values.
 */

export const STATUS_COLORS: Record<string, string> = {
  pending: "#d97706",
  processing: "#3b82f6",
  "in progress": "#3b82f6",
  completed: "#059669",
  approved: "#059669",
  rejected: "#dc2626",
  cancelled: "#64748b",
  initiated: "#f59e0b",
};

export const STATUS_BG: Record<string, string> = {
  pending: "#fffbeb",
  processing: "#eff6ff",
  "in progress": "#eff6ff",
  approved: "#ecfdf5",
  completed: "#ecfdf5",
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
