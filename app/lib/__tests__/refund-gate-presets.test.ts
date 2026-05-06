import { describe, it, expect } from "vitest";
import {
  getStatusesForPreset,
  inferPresetFromStatuses,
  PRESET_LABELS,
  type RefundGatePreset,
} from "../refund-gate-presets";

describe("getStatusesForPreset", () => {
  it("returns null for 'none'", () => {
    expect(getStatusesForPreset("none")).toBe(null);
  });

  it("returns null for 'custom'", () => {
    expect(getStatusesForPreset("custom")).toBe(null);
  });

  it("returns after_pickup statuses including refund flow", () => {
    const statuses = getStatusesForPreset("after_pickup")!;
    expect(statuses).toContain("return_bag_picked");
    expect(statuses).toContain("return_delivered");
    expect(statuses).toContain("return_completed");
    expect(statuses).toContain("refund_initiated"); // refund-flow tail is included
    expect(statuses).toContain("credit_note_generated");
  });

  it("returns after_delivery statuses (narrower than after_pickup)", () => {
    const pickup = new Set(getStatusesForPreset("after_pickup")!);
    const delivery = new Set(getStatusesForPreset("after_delivery")!);
    // Everything in delivery should be in pickup
    for (const s of delivery) {
      expect(pickup.has(s)).toBe(true);
    }
    // But 'return_bag_picked' is only in pickup
    expect(delivery.has("return_bag_picked")).toBe(false);
    expect(pickup.has("return_bag_picked")).toBe(true);
  });

  it("returns after_qc statuses (narrowest)", () => {
    const qc = getStatusesForPreset("after_qc")!;
    expect(qc).toContain("return_accepted");
    expect(qc).toContain("return_completed");
    expect(qc).toContain("refund_initiated");
    expect(qc).not.toContain("return_bag_picked"); // tighter than pickup
  });

  it("all non-trivial presets include the full refund-flow set", () => {
    const refundFlow = [
      "refund_initiated",
      "refund_on_hold",
      "refund_acknowledged",
      "refund_pending",
      "refund_pending_for_approval",
      "beneficiary_awaited",
      "manual_refund",
      "credit_note_generated",
    ];
    for (const preset of ["after_pickup", "after_delivery", "after_qc"] as const) {
      const statuses = getStatusesForPreset(preset)!;
      for (const s of refundFlow) {
        expect(statuses).toContain(s);
      }
    }
  });
});

describe("inferPresetFromStatuses", () => {
  it("returns 'none' for empty array", () => {
    expect(inferPresetFromStatuses([])).toBe("none");
  });

  it("returns 'none' for null/undefined defensively", () => {
    expect(inferPresetFromStatuses(null as unknown as string[])).toBe("none");
    expect(inferPresetFromStatuses(undefined as unknown as string[])).toBe("none");
  });

  it("round-trips: after_pickup → after_pickup", () => {
    const statuses = getStatusesForPreset("after_pickup")!;
    expect(inferPresetFromStatuses(statuses)).toBe("after_pickup");
  });

  it("round-trips: after_delivery", () => {
    const statuses = getStatusesForPreset("after_delivery")!;
    expect(inferPresetFromStatuses(statuses)).toBe("after_delivery");
  });

  it("round-trips: after_qc", () => {
    const statuses = getStatusesForPreset("after_qc")!;
    expect(inferPresetFromStatuses(statuses)).toBe("after_qc");
  });

  it("returns 'custom' for non-matching sets", () => {
    expect(inferPresetFromStatuses(["return_accepted"])).toBe("custom");
    expect(inferPresetFromStatuses(["refund_initiated", "something_else"])).toBe("custom");
  });

  it("returns 'custom' when length matches but contents differ", () => {
    const after_qc = getStatusesForPreset("after_qc")!;
    const tampered = [...after_qc.slice(0, -1), "not_a_real_status"];
    expect(inferPresetFromStatuses(tampered)).toBe("custom");
  });
});

describe("PRESET_LABELS", () => {
  const presets: RefundGatePreset[] = [
    "none",
    "after_pickup",
    "after_delivery",
    "after_qc",
    "custom",
  ];

  it("has a label + description for every preset", () => {
    for (const p of presets) {
      expect(PRESET_LABELS[p].label.length).toBeGreaterThan(0);
      expect(PRESET_LABELS[p].description.length).toBeGreaterThan(0);
    }
  });

  it("none is described as unrestricted", () => {
    expect(PRESET_LABELS.none.description.toLowerCase()).toContain("regardless");
  });
});
