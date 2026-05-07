import * as React from "react";

/**
 * Unified empty-state component. Replaces ad-hoc empty messaging that
 * varied per page. Used when a list/table has no rows, when search
 * returns nothing, or when a feature isn't yet configured.
 *
 * Pass `icon` for a hero illustration (svg/emoji), `title` for the
 * one-line summary, `description` for the explanatory paragraph, and
 * optional `action` for the recommended next step (typically a
 * primary button).
 */
export interface EmptyStateProps {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  /** Set to "compact" for inline empty states inside cards (smaller padding). */
  variant?: "default" | "compact";
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  variant = "default",
}: EmptyStateProps) {
  const isCompact = variant === "compact";
  return (
    <div
      className="app-empty-state"
      style={{
        textAlign: "center",
        padding: isCompact ? "24px 16px" : "56px 32px",
        background: "var(--rpm-surface-subtle, #f8fafc)",
        border: "1px dashed var(--rpm-border-color, #e2e8f0)",
        borderRadius: "var(--rpm-radius-lg, 14px)",
      }}
    >
      {icon && (
        <div
          aria-hidden="true"
          style={{
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            marginBottom: isCompact ? 8 : 16,
            color: "var(--rpm-text-muted, #64748b)",
          }}
        >
          {icon}
        </div>
      )}
      <div
        style={{
          fontSize: isCompact ? 15 : 18,
          fontWeight: 600,
          color: "var(--rpm-text, #0f172a)",
          marginBottom: description ? 6 : 0,
        }}
      >
        {title}
      </div>
      {description && (
        <div
          style={{
            fontSize: isCompact ? 13 : 14,
            color: "var(--rpm-text-muted, #64748b)",
            maxWidth: 460,
            marginInline: "auto",
            marginBottom: action ? (isCompact ? 12 : 20) : 0,
            lineHeight: 1.55,
          }}
        >
          {description}
        </div>
      )}
      {action && <div style={{ marginTop: isCompact ? 12 : 16 }}>{action}</div>}
    </div>
  );
}
