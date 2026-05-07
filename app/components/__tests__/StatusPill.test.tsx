/** @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { StatusPill } from "../StatusPill";

describe("<StatusPill />", () => {
  it("renders title-cased status when no label override is provided", () => {
    render(<StatusPill status="approved" />);
    expect(screen.getByText("Approved")).toBeTruthy();
  });

  it("preserves a label override when given", () => {
    render(<StatusPill status="approved" label="Auto-approved" />);
    expect(screen.getByText("Auto-approved")).toBeTruthy();
  });

  it("converts snake_case status tokens to spaced labels", () => {
    render(<StatusPill status="in_progress" />);
    expect(screen.getByText("In progress")).toBeTruthy();
  });

  it("renders a small variant with reduced font size", () => {
    const { container } = render(<StatusPill status="pending" size="small" />);
    const span = container.querySelector(".app-status-pill") as HTMLElement;
    expect(span.style.fontSize).toBe("11px");
  });

  it("includes a dot indicator alongside the label", () => {
    const { container } = render(<StatusPill status="approved" />);
    const dot = container.querySelector('span[aria-hidden="true"]');
    expect(dot).toBeTruthy();
  });

  it("returns the empty-string status unchanged from titleCase (line 21 guard)", () => {
    const { container } = render(<StatusPill status="" />);
    // The pill renders the empty status without crashing; label text is empty
    const span = container.querySelector(".app-status-pill") as HTMLElement;
    expect(span).toBeTruthy();
  });
});
