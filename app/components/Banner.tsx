import * as React from "react";

/**
 * Inline banner for in-page notices (alerts, success messages, errors).
 * Wraps the existing .app-alert / .app-alert-{tone} CSS so every
 * surface in the admin gets the same visual treatment without each
 * caller needing to repeat 30 lines of inline styles.
 *
 * Use Toast (separate component) for ephemeral floating messages.
 * Use Banner here for persistent in-page state (form errors, page-level
 * info, audit-state warnings).
 */
export type BannerTone = "info" | "success" | "warning" | "critical";

export interface BannerProps {
  tone?: BannerTone;
  title?: React.ReactNode;
  children?: React.ReactNode;
  onDismiss?: () => void;
  /** Optional right-side action node (button, link). */
  action?: React.ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

const ICON_BY_TONE: Record<BannerTone, React.ReactNode> = {
  info: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  ),
  success: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  ),
  warning: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  ),
  critical: (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="8" x2="12" y2="12" />
      <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
  ),
};

const TONE_CLASS: Record<BannerTone, string> = {
  info: "app-alert-info",
  success: "app-alert-success",
  warning: "app-alert-warning",
  critical: "app-alert-error",
};

export function Banner({
  tone = "info",
  title,
  children,
  onDismiss,
  action,
  className,
  style,
}: BannerProps) {
  const cls = `app-alert ${TONE_CLASS[tone]}${className ? ` ${className}` : ""}`;
  return (
    <div className={cls} role={tone === "critical" ? "alert" : "status"} style={style}>
      <span className="app-alert__icon" aria-hidden="true">
        {ICON_BY_TONE[tone]}
      </span>
      <div className="app-alert__body" style={{ flex: 1, minWidth: 0 }}>
        {title && <strong style={{ display: "block", marginBottom: children ? 4 : 0 }}>{title}</strong>}
        {children && <div className="app-alert__content">{children}</div>}
      </div>
      {action && <div className="app-alert__action">{action}</div>}
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="app-alert__dismiss"
          style={{
            background: "transparent",
            border: 0,
            color: "inherit",
            cursor: "pointer",
            padding: 4,
            lineHeight: 0,
            opacity: 0.6,
          }}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </div>
  );
}
