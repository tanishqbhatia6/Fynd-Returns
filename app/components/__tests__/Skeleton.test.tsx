/** @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { Skeleton, SkeletonRows } from "../Skeleton";

describe("<Skeleton />", () => {
  it("renders aria-hidden=true when no aria-label is supplied", () => {
    const { container } = render(<Skeleton />);
    const span = container.querySelector(".app-skeleton") as HTMLElement;
    expect(span.getAttribute("aria-hidden")).toBe("true");
  });

  it("renders role=status when ariaLabel is supplied", () => {
    const { container } = render(<Skeleton ariaLabel="Loading data" />);
    const span = container.querySelector(".app-skeleton") as HTMLElement;
    expect(span.getAttribute("role")).toBe("status");
    expect(span.getAttribute("aria-label")).toBe("Loading data");
  });

  it("respects custom width / height", () => {
    const { container } = render(<Skeleton width={120} height={20} />);
    const span = container.querySelector(".app-skeleton") as HTMLElement;
    expect(span.style.width).toBe("120px");
    expect(span.style.height).toBe("20px");
  });
});

describe("<SkeletonRows />", () => {
  it("renders the requested number of rows", () => {
    const { container } = render(<SkeletonRows rows={4} />);
    expect(container.querySelectorAll(".app-skeleton")).toHaveLength(4);
  });

  it("defaults to 5 rows", () => {
    const { container } = render(<SkeletonRows />);
    expect(container.querySelectorAll(".app-skeleton")).toHaveLength(5);
  });
});
