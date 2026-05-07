/** @vitest-environment jsdom */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { Banner } from "../Banner";

describe("<Banner />", () => {
  it("renders title + body and applies the info tone class by default", () => {
    const { container } = render(<Banner title="Heads up">Body text</Banner>);
    expect(container.querySelector(".app-alert.app-alert-info")).toBeTruthy();
    expect(screen.getByText("Heads up")).toBeTruthy();
    expect(screen.getByText("Body text")).toBeTruthy();
  });

  it("uses role=alert for critical tone and role=status otherwise", () => {
    const { rerender, container } = render(<Banner tone="critical">x</Banner>);
    expect(container.querySelector('[role="alert"]')).toBeTruthy();
    rerender(<Banner tone="success">x</Banner>);
    expect(container.querySelector('[role="status"]')).toBeTruthy();
  });

  it.each(["info", "success", "warning", "critical"] as const)(
    "applies the correct CSS class for tone %s",
    (tone) => {
      const map = {
        info: "app-alert-info",
        success: "app-alert-success",
        warning: "app-alert-warning",
        critical: "app-alert-error",
      };
      const { container } = render(<Banner tone={tone}>m</Banner>);
      expect(container.querySelector(`.${map[tone]}`)).toBeTruthy();
    },
  );

  it("renders dismiss button only when onDismiss is provided and triggers the callback", () => {
    const onDismiss = vi.fn();
    const { rerender, container } = render(<Banner>m</Banner>);
    expect(container.querySelector('[aria-label="Dismiss"]')).toBeFalsy();
    rerender(<Banner onDismiss={onDismiss}>m</Banner>);
    const btn = container.querySelector('[aria-label="Dismiss"]');
    expect(btn).toBeTruthy();
    fireEvent.click(btn!);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders an action node when provided", () => {
    render(<Banner action={<button type="button">Retry</button>}>m</Banner>);
    expect(screen.getByText("Retry")).toBeTruthy();
  });
});
