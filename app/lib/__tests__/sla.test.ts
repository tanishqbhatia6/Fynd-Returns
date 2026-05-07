/**
 * Returns SLA computation — pure module, deterministic with `now` injected.
 */
import { describe, it, expect } from "vitest";
import {
  computeSlaBreaches,
  worstSlaLevel,
  describeSlaBreach,
  slaStageLabel,
  DEFAULT_SLA_HOURS,
  type ReturnCaseSlaInput,
} from "../sla.server";

const HOUR = 60 * 60 * 1000;

const baseInput = (overrides: Partial<ReturnCaseSlaInput> = {}): ReturnCaseSlaInput => ({
  status: "pending",
  resolutionType: "refund",
  createdAt: new Date("2026-05-01T00:00:00Z"),
  now: new Date("2026-05-01T01:00:00Z"),
  ...overrides,
});

describe("computeSlaBreaches — approval stage", () => {
  it("returns no breach when within window", () => {
    const r = computeSlaBreaches(baseInput({ now: new Date("2026-05-01T05:00:00Z") }));
    expect(r).toHaveLength(1);
    expect(r[0].stage).toBe("approval");
    expect(r[0].level).toBe("ok");
    expect(r[0].thresholdHours).toBe(DEFAULT_SLA_HOURS.approval);
  });

  it("flips to warning at 80% of threshold", () => {
    // 80% of 48h = 38.4h
    const r = computeSlaBreaches(
      baseInput({ now: new Date("2026-05-02T15:00:00Z") /* 39h elapsed */ }),
    );
    expect(r[0].level).toBe("warning");
  });

  it("flips to breached at threshold", () => {
    // 50h elapsed > 48h
    const r = computeSlaBreaches(
      baseInput({ now: new Date("2026-05-03T02:00:00Z") }),
    );
    expect(r[0].level).toBe("breached");
  });

  it("disappears once approvedAt is set", () => {
    const r = computeSlaBreaches(
      baseInput({
        approvedAt: new Date("2026-05-01T00:30:00Z"),
        now: new Date("2026-05-03T00:00:00Z"),
      }),
    );
    expect(r.find((s) => s.stage === "approval")).toBeUndefined();
  });

  it("disappears once status is terminal (rejected)", () => {
    const r = computeSlaBreaches(
      baseInput({ status: "rejected", now: new Date("2026-05-10T00:00:00Z") }),
    );
    expect(r).toEqual([]);
  });
});

describe("computeSlaBreaches — pickup stage", () => {
  const approvedInput = (overrides: Partial<ReturnCaseSlaInput> = {}): ReturnCaseSlaInput => ({
    status: "approved",
    resolutionType: "refund",
    createdAt: new Date("2026-05-01T00:00:00Z"),
    approvedAt: new Date("2026-05-01T01:00:00Z"),
    now: new Date("2026-05-01T05:00:00Z"),
    ...overrides,
  });

  it("appears after approval, before pickup", () => {
    const r = computeSlaBreaches(approvedInput());
    expect(r.map((b) => b.stage).sort()).toEqual(["pickup", "refund"]);
  });

  it("does NOT appear for store_credit (no physical pickup)", () => {
    const r = computeSlaBreaches(approvedInput({ resolutionType: "store_credit" }));
    expect(r.find((s) => s.stage === "pickup")).toBeUndefined();
  });

  it("disappears once pickedUpAt is set", () => {
    const r = computeSlaBreaches(
      approvedInput({
        pickedUpAt: new Date("2026-05-01T03:00:00Z"),
      }),
    );
    expect(r.find((s) => s.stage === "pickup")).toBeUndefined();
  });

  it("breached at 80h after approval (threshold 72h)", () => {
    const r = computeSlaBreaches(
      approvedInput({ now: new Date("2026-05-04T09:00:00Z") /* 80h after approval */ }),
    );
    const pickup = r.find((s) => s.stage === "pickup")!;
    expect(pickup.level).toBe("breached");
  });
});

describe("computeSlaBreaches — refund stage", () => {
  it("appears after approval and before refund completion", () => {
    const r = computeSlaBreaches({
      status: "approved",
      resolutionType: "refund",
      createdAt: new Date("2026-05-01T00:00:00Z"),
      approvedAt: new Date("2026-05-01T01:00:00Z"),
      now: new Date("2026-05-02T00:00:00Z"),
    });
    const refund = r.find((b) => b.stage === "refund")!;
    expect(refund).toBeTruthy();
    expect(refund.level).toBe("ok");
  });

  it("disappears once refundedAt is set", () => {
    const r = computeSlaBreaches({
      status: "completed",
      resolutionType: "refund",
      createdAt: new Date("2026-05-01T00:00:00Z"),
      approvedAt: new Date("2026-05-01T01:00:00Z"),
      refundedAt: new Date("2026-05-02T00:00:00Z"),
      now: new Date("2026-05-10T00:00:00Z"),
    });
    expect(r).toEqual([]);
  });
});

describe("config overrides", () => {
  it("respects shop-level SLA override", () => {
    const r = computeSlaBreaches(
      baseInput({ now: new Date("2026-05-01T13:00:00Z") /* 13h elapsed */ }),
      { approval: 12 }, // tighter SLA
    );
    expect(r[0].level).toBe("breached");
  });
});

describe("worstSlaLevel", () => {
  it("returns 'breached' when any stage breached", () => {
    expect(
      worstSlaLevel([
        { stage: "approval", level: "ok", elapsedHours: 1, thresholdHours: 48, breachAt: null },
        { stage: "pickup", level: "breached", elapsedHours: 80, thresholdHours: 72, breachAt: null },
      ]),
    ).toBe("breached");
  });

  it("returns 'warning' when only warnings present", () => {
    expect(
      worstSlaLevel([
        { stage: "approval", level: "warning", elapsedHours: 40, thresholdHours: 48, breachAt: null },
      ]),
    ).toBe("warning");
  });

  it("returns 'ok' for empty list", () => {
    expect(worstSlaLevel([])).toBe("ok");
  });
});

describe("describeSlaBreach", () => {
  it("formats hours-overdue when under 24h overdue", () => {
    expect(
      describeSlaBreach({
        stage: "approval",
        level: "breached",
        elapsedHours: 54,
        thresholdHours: 48,
        breachAt: null,
      }),
    ).toBe("Overdue by 6h");
  });

  it("formats days-overdue when 24h+ overdue", () => {
    expect(
      describeSlaBreach({
        stage: "refund",
        level: "breached",
        elapsedHours: 240,
        thresholdHours: 120,
        breachAt: null,
      }),
    ).toBe("Overdue by 5d");
  });

  it("formats remaining-hours for non-breached stages", () => {
    expect(
      describeSlaBreach({
        stage: "approval",
        level: "warning",
        elapsedHours: 40,
        thresholdHours: 48,
        breachAt: null,
      }),
    ).toBe("Due in 8h");
  });

  it("formats remaining-days when 24h+ remain", () => {
    expect(
      describeSlaBreach({
        stage: "refund",
        level: "ok",
        elapsedHours: 24,
        thresholdHours: 120,
        breachAt: null,
      }),
    ).toBe("Due in 4d");
  });
});

describe("input handling — defensive branches", () => {
  it("uses current time when `now` is omitted", () => {
    // Stale createdAt → some breach should fire when now defaults
    const r = computeSlaBreaches({
      status: "pending",
      resolutionType: "refund",
      createdAt: new Date("2020-01-01T00:00:00Z"), // very old
    });
    expect(r[0].level).toBe("breached");
  });

  it("treats string-typed createdAt the same as Date", () => {
    const r = computeSlaBreaches({
      status: "pending",
      resolutionType: "refund",
      createdAt: "2026-05-01T00:00:00Z",
      now: new Date("2026-05-01T05:00:00Z"),
    });
    expect(r).toHaveLength(1);
    expect(r[0].stage).toBe("approval");
  });

  it("ignores invalid date strings (returns no breach when createdAt is unparseable)", () => {
    const r = computeSlaBreaches({
      status: "pending",
      resolutionType: "refund",
      createdAt: "not a date",
      now: new Date("2026-05-10T00:00:00Z"),
    });
    expect(r).toEqual([]);
  });

  it("handles empty status / resolutionType strings gracefully", () => {
    const r = computeSlaBreaches({
      status: "",
      resolutionType: "",
      createdAt: new Date("2026-05-01T00:00:00Z"),
      now: new Date("2026-05-01T05:00:00Z"),
    });
    expect(r[0].stage).toBe("approval");
  });

  it("handles undefined resolutionType (falls into pickup-required default)", () => {
    const r = computeSlaBreaches({
      status: "approved",
      resolutionType: undefined,
      createdAt: new Date("2026-05-01T00:00:00Z"),
      approvedAt: new Date("2026-05-01T01:00:00Z"),
      now: new Date("2026-05-01T05:00:00Z"),
    });
    // Pickup applies when resolution is undefined / "" (treated as physical return)
    expect(r.find((b) => b.stage === "pickup")).toBeTruthy();
  });
});

describe("slaStageLabel", () => {
  it("returns human label per stage", () => {
    expect(slaStageLabel("approval")).toBe("Approval");
    expect(slaStageLabel("pickup")).toBe("Pickup");
    expect(slaStageLabel("refund")).toBe("Refund");
  });
});
