/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";
import { Toast } from "../Toast";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("<Toast />", () => {
  it("auto-dismisses after the default 4s", () => {
    const onDismiss = vi.fn();
    render(<Toast onDismiss={onDismiss}>Saved</Toast>);
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(4000));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("respects a custom duration", () => {
    const onDismiss = vi.fn();
    render(
      <Toast onDismiss={onDismiss} duration={1500}>
        Saved
      </Toast>,
    );
    act(() => vi.advanceTimersByTime(1499));
    expect(onDismiss).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does not auto-dismiss when duration is 0", () => {
    const onDismiss = vi.fn();
    render(
      <Toast onDismiss={onDismiss} duration={0}>
        Sticky
      </Toast>,
    );
    act(() => vi.advanceTimersByTime(60_000));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("dismisses on click of the close button", () => {
    const onDismiss = vi.fn();
    const { container } = render(<Toast onDismiss={onDismiss}>Saved</Toast>);
    const btn = container.querySelector('[aria-label="Dismiss"]')!;
    fireEvent.click(btn);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("renders the message content", () => {
    const onDismiss = vi.fn();
    render(<Toast onDismiss={onDismiss}>Bulk approved 3 returns</Toast>);
    expect(screen.getByText(/Bulk approved 3 returns/)).toBeTruthy();
  });
});
