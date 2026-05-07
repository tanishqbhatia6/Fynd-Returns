import * as React from "react";

/**
 * Download CTA for a Fynd-hosted document (return label, invoice, QR
 * code). Fynd already generates and serves these PDFs — we don't
 * regenerate them, we just surface the URL with a proper button-shaped
 * call-to-action so admins can find them at a glance.
 *
 * Renders as a button-styled `<a download>` so the browser starts a
 * download (or new-tab open if Fynd serves with `Content-Disposition:
 * inline`). Applies `target=_blank` + `rel=noopener noreferrer` for
 * link-safety.
 */
export type DocumentKind = "label" | "invoice" | "qr" | "tracking" | "other";

const ICON_BY_KIND: Record<DocumentKind, React.ReactNode> = {
  label: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="9" x2="15" y2="9" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="13" y2="17" />
    </svg>
  ),
  invoice: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="9" y1="13" x2="15" y2="13" />
      <line x1="9" y1="17" x2="15" y2="17" />
    </svg>
  ),
  qr: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <line x1="14" y1="14" x2="21" y2="14" />
      <line x1="14" y1="18" x2="18" y2="18" />
      <line x1="14" y1="21" x2="21" y2="21" />
    </svg>
  ),
  tracking: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M16 3h5v5" />
      <path d="M8 3H3v5" />
      <path d="M3 16v5h5" />
      <path d="M21 16v5h-5" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ),
  other: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  ),
};

const LABEL_BY_KIND: Record<DocumentKind, string> = {
  label: "Return label",
  invoice: "Invoice",
  qr: "QR code",
  tracking: "Tracking",
  other: "Document",
};

export interface DocumentDownloadProps {
  url: string;
  kind?: DocumentKind;
  /** Display label override; falls back to standard kind label. */
  label?: string;
  /** Subtitle (file size, format, etc.) shown below the label. */
  hint?: string;
  /** Tone: "primary" for brand-coloured, "neutral" for greyscale. */
  tone?: "primary" | "neutral";
}

export function DocumentDownload({
  url,
  kind = "other",
  label,
  hint,
  tone = "primary",
}: DocumentDownloadProps) {
  const display = label ?? LABEL_BY_KIND[kind];
  const isPrimary = tone === "primary";
  const fg = isPrimary ? "#0f172a" : "#475569";
  const accent = isPrimary ? "#059669" : "#64748b";
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      download
      className="app-document-download"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 10,
        padding: "9px 14px",
        background: "#fff",
        border: `1px solid ${isPrimary ? "#d1fae5" : "#e2e8f0"}`,
        borderRadius: 10,
        textDecoration: "none",
        color: fg,
        fontSize: 13,
        fontWeight: 500,
        transition: "border-color 0.15s ease, transform 0.15s ease",
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          borderRadius: 8,
          background: isPrimary ? "#ecfdf5" : "#f1f5f9",
          color: accent,
        }}
      >
        {ICON_BY_KIND[kind]}
      </span>
      <span style={{ display: "flex", flexDirection: "column", lineHeight: 1.3 }}>
        <span style={{ fontWeight: 600 }}>{display}</span>
        {hint && <span style={{ color: "#64748b", fontSize: 11 }}>{hint}</span>}
      </span>
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
        style={{ marginLeft: 4, color: accent }}
      >
        <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
        <polyline points="7 10 12 15 17 10" />
        <line x1="12" y1="15" x2="12" y2="3" />
      </svg>
    </a>
  );
}

/**
 * Group of DocumentDownload buttons with a sectioned heading and an
 * empty-state when nothing is available yet (e.g. before Fynd has
 * generated the label).
 */
export interface DocumentDownloadGroupProps {
  heading?: React.ReactNode;
  documents: Array<{
    url: string;
    kind: DocumentKind;
    label?: string;
    hint?: string;
  } | null>;
  emptyHint?: React.ReactNode;
}

export function DocumentDownloadGroup({
  heading = "Documents",
  documents,
  emptyHint = "Documents will appear once Fynd has generated them.",
}: DocumentDownloadGroupProps) {
  const list = documents.filter((d): d is NonNullable<typeof d> => d !== null && !!d.url);
  return (
    <div style={{ marginTop: 16 }}>
      {heading && (
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: "#475569",
            textTransform: "uppercase",
            letterSpacing: "0.05em",
            marginBottom: 10,
          }}
        >
          {heading}
        </div>
      )}
      {list.length === 0 ? (
        <div
          style={{
            padding: "14px 16px",
            background: "#f8fafc",
            border: "1px dashed #cbd5e1",
            borderRadius: 10,
            color: "#64748b",
            fontSize: 13,
          }}
        >
          {emptyHint}
        </div>
      ) : (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
          {list.map((d, i) => (
            <DocumentDownload
              key={`${d.kind}-${i}`}
              url={d.url}
              kind={d.kind}
              label={d.label}
              hint={d.hint}
            />
          ))}
        </div>
      )}
    </div>
  );
}
