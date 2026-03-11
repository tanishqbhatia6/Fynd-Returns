import { describe, it, expect } from "vitest";
import {
  STATUS_COLORS,
  STATUS_BG,
  STATUS_LABELS,
  getStatusColor,
  getStatusBg,
} from "../status-colors";

describe("STATUS_COLORS", () => {
  it("has a color defined for all expected statuses", () => {
    const expectedStatuses = [
      "pending",
      "processing",
      "in progress",
      "approved",
      "completed",
      "rejected",
      "cancelled",
      "initiated",
    ];
    for (const status of expectedStatuses) {
      expect(STATUS_COLORS[status]).toBeDefined();
      expect(STATUS_COLORS[status]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("maps processing and in progress to the same color", () => {
    expect(STATUS_COLORS["processing"]).toBe(STATUS_COLORS["in progress"]);
  });
});

describe("STATUS_BG", () => {
  it("has a background color defined for all expected statuses", () => {
    const expectedStatuses = [
      "pending",
      "processing",
      "in progress",
      "approved",
      "completed",
      "rejected",
      "cancelled",
      "initiated",
    ];
    for (const status of expectedStatuses) {
      expect(STATUS_BG[status]).toBeDefined();
      expect(STATUS_BG[status]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("STATUS_LABELS", () => {
  it("has properly capitalized labels for all statuses", () => {
    expect(STATUS_LABELS["pending"]).toBe("Pending");
    expect(STATUS_LABELS["processing"]).toBe("Processing");
    expect(STATUS_LABELS["in progress"]).toBe("In Progress");
    expect(STATUS_LABELS["completed"]).toBe("Completed");
    expect(STATUS_LABELS["approved"]).toBe("Approved");
    expect(STATUS_LABELS["rejected"]).toBe("Rejected");
    expect(STATUS_LABELS["cancelled"]).toBe("Cancelled");
    expect(STATUS_LABELS["initiated"]).toBe("Initiated");
  });
});

describe("getStatusColor", () => {
  it("returns the correct color for a known lowercase status", () => {
    expect(getStatusColor("pending")).toBe("#d97706");
    expect(getStatusColor("approved")).toBe("#059669");
    expect(getStatusColor("rejected")).toBe("#dc2626");
  });

  it("handles mixed case input", () => {
    expect(getStatusColor("Pending")).toBe("#d97706");
    expect(getStatusColor("APPROVED")).toBe("#059669");
    expect(getStatusColor("Rejected")).toBe("#dc2626");
  });

  it("normalizes extra whitespace to single space for 'in progress'", () => {
    expect(getStatusColor("in  progress")).toBe("#3b82f6");
    expect(getStatusColor("In Progress")).toBe("#3b82f6");
    expect(getStatusColor("IN  PROGRESS")).toBe("#3b82f6");
  });

  it("returns default grey color for unknown status", () => {
    expect(getStatusColor("unknown")).toBe("#64748b");
    expect(getStatusColor("something-random")).toBe("#64748b");
  });

  it("returns default color for empty string", () => {
    expect(getStatusColor("")).toBe("#64748b");
  });
});

describe("getStatusBg", () => {
  it("returns the correct background color for known statuses", () => {
    expect(getStatusBg("pending")).toBe("#fffbeb");
    expect(getStatusBg("approved")).toBe("#ecfdf5");
    expect(getStatusBg("rejected")).toBe("#fef2f2");
    expect(getStatusBg("completed")).toBe("#eff6ff");
  });

  it("handles mixed case input", () => {
    expect(getStatusBg("Pending")).toBe("#fffbeb");
    expect(getStatusBg("REJECTED")).toBe("#fef2f2");
  });

  it("returns default background for unknown status", () => {
    expect(getStatusBg("nonexistent")).toBe("#f8fafc");
  });

  it("returns default background for empty string", () => {
    expect(getStatusBg("")).toBe("#f8fafc");
  });
});
