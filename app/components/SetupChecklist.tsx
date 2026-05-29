import * as React from "react";
import { Link } from "react-router";

/**
 * Setup-progress checklist for the dashboard.
 *
 * Renders a card listing the merchant's onboarding steps with a progress
 * meter. Steps are derived from existing settings state — no separate
 * "have I completed onboarding" flag is needed (so no schema migration);
 * a step is "done" when the relevant settings field is populated.
 *
 * The component is presentational. The dashboard loader computes the
 * step list from the Shop / ShopSettings rows; this component just
 * renders.
 */
export interface SetupStep {
  /** Stable identifier for the step (used as React key). */
  key: string;
  /** Short human-readable title. */
  title: string;
  /** One-line description shown under the title. */
  description: string;
  /** True when the step has been completed (settings populated). */
  done: boolean;
  /** URL to the relevant settings page; clicking the step navigates here. */
  href: string;
  /** Display the step's CTA copy (e.g. "Configure", "Test send"). */
  ctaLabel?: string;
}

export interface SetupChecklistProps {
  steps: SetupStep[];
  /** Optional headline override. */
  heading?: React.ReactNode;
  /** Optional dismiss handler — when set, a small × is rendered top-right
   *  so merchants who've outgrown the checklist can hide it. */
  onDismiss?: () => void;
}

export function SetupChecklist({
  steps,
  heading = "Finish setting up",
  onDismiss,
}: SetupChecklistProps) {
  const total = steps.length;
  const done = steps.filter((s) => s.done).length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  // Hide the checklist entirely when there are no steps OR every step
  // is done — nothing for the merchant to do.
  if (total === 0 || done === total) return null;

  return (
    <div
      className="app-setup-checklist"
      style={{
        background: "#fff",
        border: "1px solid var(--rpm-border-color, #e2e8f0)",
        borderRadius: 12,
        padding: 24,
        marginBottom: 24,
        position: "relative",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 14,
        }}
      >
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: "#0f172a" }}>{heading}</div>
          <div style={{ fontSize: 13, color: "#64748b", marginTop: 2 }}>
            {done} of {total} complete · {pct}%
          </div>
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss setup checklist"
            style={{
              border: 0,
              background: "transparent",
              color: "#94a3b8",
              cursor: "pointer",
              padding: 4,
              lineHeight: 0,
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      <div
        aria-hidden="true"
        style={{
          height: 6,
          background: "#e2e8f0",
          borderRadius: 999,
          overflow: "hidden",
          marginBottom: 18,
        }}
      >
        <div
          style={{
            height: "100%",
            width: `${pct}%`,
            background: "#10b981",
            transition: "width 0.3s ease",
          }}
        />
      </div>

      <ol style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {steps.map((s) => (
          <li
            key={s.key}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "10px 0",
              borderTop: "1px solid #f1f5f9",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: 24,
                height: 24,
                borderRadius: "50%",
                background: s.done ? "#10b981" : "#fff",
                border: s.done ? "1px solid #10b981" : "1.5px solid #cbd5e1",
                color: s.done ? "#fff" : "#94a3b8",
                fontSize: 12,
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {s.done ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : null}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div
                style={{
                  fontSize: 14,
                  fontWeight: 600,
                  color: s.done ? "#64748b" : "#0f172a",
                  textDecoration: s.done ? "line-through" : "none",
                }}
              >
                {s.title}
              </div>
              <div style={{ fontSize: 12, color: "#64748b" }}>{s.description}</div>
            </div>
            {!s.done && (
              <Link
                to={s.href}
                style={{
                  padding: "6px 14px",
                  background: "#0f172a",
                  color: "#fff",
                  borderRadius: 8,
                  fontSize: 12,
                  fontWeight: 600,
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                }}
              >
                {s.ctaLabel ?? "Configure"}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
