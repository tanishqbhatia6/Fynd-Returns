import * as React from "react";

/**
 * Floating, auto-dismissing notification. Used for transient feedback
 * after an action ("Bulk approved 3 returns", "Saved", "Copied to
 * clipboard"). Distinct from <Banner /> which is in-page and persistent.
 *
 * Usage:
 *   const [toast, setToast] = useState<{ tone: ToastTone; message: string } | null>(null);
 *   ...
 *   {toast && <Toast tone={toast.tone} onDismiss={() => setToast(null)}>{toast.message}</Toast>}
 *
 * Auto-dismisses after 4s by default; respects user motion-preference
 * (skips slide animation when prefers-reduced-motion is set).
 */
export type ToastTone = "info" | "success" | "warning" | "critical";

export interface ToastProps {
  tone?: ToastTone;
  children: React.ReactNode;
  onDismiss: () => void;
  /** Auto-dismiss delay in ms. Set to 0 to keep the toast until manually dismissed. */
  duration?: number;
}

const TONE_BG: Record<ToastTone, string> = {
  info: "#1e40af",
  success: "#065f46",
  warning: "#92400e",
  critical: "#991b1b",
};

export function Toast({ tone = "success", children, onDismiss, duration = 4000 }: ToastProps) {
  React.useEffect(() => {
    if (duration <= 0) return;
    const t = setTimeout(onDismiss, duration);
    return () => clearTimeout(t);
  }, [onDismiss, duration]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="app-toast"
      style={{
        position: "fixed",
        top: 20,
        right: 20,
        zIndex: 10000,
        padding: "12px 16px",
        borderRadius: 12,
        fontSize: 14,
        fontWeight: 500,
        color: "#fff",
        background: TONE_BG[tone],
        boxShadow: "0 10px 30px rgba(0,0,0,0.15)",
        display: "flex",
        alignItems: "center",
        gap: 10,
        maxWidth: 420,
      }}
    >
      <span style={{ flex: 1, lineHeight: 1.4 }}>{children}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss"
        style={{
          background: "transparent",
          border: 0,
          color: "inherit",
          cursor: "pointer",
          opacity: 0.85,
          padding: 2,
          lineHeight: 0,
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
}
