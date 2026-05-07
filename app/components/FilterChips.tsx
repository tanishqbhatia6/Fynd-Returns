import * as React from "react";

/**
 * Removable filter chips for list/index pages. Each active filter is
 * shown as a pill with an "X" button; clicking the X invokes onRemove
 * with that filter's key. A "Clear all" link appears when multiple
 * filters are active.
 *
 * Pure UI component — caller owns the URL/state model. Pass the
 * already-formatted display label for each chip (so callers can
 * humanize values like "approved" → "Status: Approved" themselves).
 */
export interface FilterChip {
  /** Stable key used by the parent to identify which filter to remove. */
  key: string;
  /** Human-readable text shown on the chip ("Status: Approved"). */
  label: string;
}

export interface FilterChipsProps {
  chips: FilterChip[];
  onRemove: (key: string) => void;
  /** Optional handler to clear all filters at once; renders the Clear-all
   *  link when present and 2+ chips are active. */
  onClearAll?: () => void;
  className?: string;
}

export function FilterChips({ chips, onRemove, onClearAll, className }: FilterChipsProps) {
  if (chips.length === 0) return null;
  return (
    <div
      className={`app-filter-chips${className ? ` ${className}` : ""}`}
      role="region"
      aria-label="Active filters"
      style={{
        display: "flex",
        flexWrap: "wrap",
        gap: 8,
        alignItems: "center",
        padding: "8px 0",
        marginBottom: 12,
      }}
    >
      <span
        style={{
          fontSize: 12,
          fontWeight: 600,
          color: "var(--rpm-text-muted, #64748b)",
          marginRight: 4,
        }}
      >
        Filters
      </span>
      {chips.map((chip) => (
        <span
          key={chip.key}
          className="app-filter-chip"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "4px 4px 4px 10px",
            background: "#eff6ff",
            border: "1px solid #bfdbfe",
            color: "#1e40af",
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 500,
            whiteSpace: "nowrap",
          }}
        >
          {chip.label}
          <button
            type="button"
            onClick={() => onRemove(chip.key)}
            aria-label={`Remove filter ${chip.label}`}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 18,
              height: 18,
              padding: 0,
              border: 0,
              background: "transparent",
              color: "inherit",
              cursor: "pointer",
              opacity: 0.7,
              borderRadius: "50%",
            }}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </span>
      ))}
      {onClearAll && chips.length >= 2 && (
        <button
          type="button"
          onClick={onClearAll}
          className="app-filter-chips__clear"
          style={{
            border: 0,
            background: "transparent",
            color: "var(--rpm-text-muted, #64748b)",
            fontSize: 12,
            fontWeight: 500,
            cursor: "pointer",
            padding: "4px 8px",
            textDecoration: "underline",
          }}
        >
          Clear all
        </button>
      )}
    </div>
  );
}
