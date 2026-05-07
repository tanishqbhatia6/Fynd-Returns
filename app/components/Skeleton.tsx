import * as React from "react";

/**
 * Skeleton placeholder for content that's loading.
 *
 * Why skeletons over spinners: they preserve layout, prevent the
 * "jumping page" effect during data fetches, and are perceptibly
 * faster (the user sees structure first, content second). Pages
 * use them while the loader/fetcher state is "loading" so admins
 * never stare at a blank screen.
 */
export interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  borderRadius?: number | string;
  /** Inline-block by default; set "block" for full-width row placeholders. */
  display?: "inline-block" | "block";
  className?: string;
  style?: React.CSSProperties;
  ariaLabel?: string;
}

export function Skeleton({
  width = "100%",
  height = 16,
  borderRadius = 6,
  display = "block",
  className,
  style,
  ariaLabel,
}: SkeletonProps) {
  if (ariaLabel) {
    return (
      <span
        role="status"
        aria-label={ariaLabel}
        className={`app-skeleton${className ? ` ${className}` : ""}`}
        style={{ display, width, height, borderRadius, ...style }}
      />
    );
  }
  return (
    <span
      aria-hidden="true"
      className={`app-skeleton${className ? ` ${className}` : ""}`}
      style={{
        display,
        width,
        height,
        borderRadius,
        ...style,
      }}
    />
  );
}

/** Convenience: a stack of N <Skeleton /> rows for table loading states. */
export function SkeletonRows({
  rows = 5,
  rowHeight = 16,
  gap = 12,
}: {
  rows?: number;
  rowHeight?: number;
  gap?: number;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap }}>
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton
          key={i}
          height={rowHeight}
          width={`${85 - (i % 4) * 5}%`}
          ariaLabel={i === 0 ? "Loading" : undefined}
        />
      ))}
    </div>
  );
}
