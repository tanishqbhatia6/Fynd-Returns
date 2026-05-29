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
    <section className="app-setup-checklist" aria-label="Setup checklist">
      <div className="app-setup-checklist__header">
        <div>
          <h2 className="app-setup-checklist__title">{heading}</h2>
          <div className="app-setup-checklist__meta">
            {done} of {total} complete · {pct}%
          </div>
        </div>
        {onDismiss && (
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss setup checklist"
            className="app-setup-checklist__dismiss"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>

      <div className="app-setup-checklist__progress" aria-hidden="true">
        <div className="app-setup-checklist__progress-fill" style={{ width: `${pct}%` }} />
      </div>

      <ol className="app-setup-checklist__list">
        {steps.map((s) => (
          <li key={s.key} className="app-setup-checklist__item">
            <span
              aria-hidden="true"
              className={`app-setup-checklist__step${s.done ? " app-setup-checklist__step--done" : ""}`}
            >
              {s.done ? (
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : null}
            </span>
            <div className="app-setup-checklist__copy">
              <div
                className={`app-setup-checklist__step-title${
                  s.done ? " app-setup-checklist__step-title--done" : ""
                }`}
              >
                {s.title}
              </div>
              <div className="app-setup-checklist__description">{s.description}</div>
            </div>
            {!s.done && (
              <Link to={s.href} className="app-setup-checklist__cta">
                {s.ctaLabel ?? "Configure"}
              </Link>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}
