/** @vitest-environment jsdom */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { FilterChips } from "../FilterChips";

describe("<FilterChips />", () => {
  it("renders nothing when there are no active filters", () => {
    const { container } = render(<FilterChips chips={[]} onRemove={() => {}} />);
    expect(container.querySelector(".app-filter-chips")).toBeNull();
  });

  it("renders one chip per active filter with its label", () => {
    render(
      <FilterChips
        chips={[
          { key: "status", label: "Status: Approved" },
          { key: "channel", label: "Channel: POS" },
        ]}
        onRemove={() => {}}
      />,
    );
    expect(screen.getByText("Status: Approved")).toBeTruthy();
    expect(screen.getByText("Channel: POS")).toBeTruthy();
  });

  it("calls onRemove with the chip key when its X button is clicked", () => {
    const onRemove = vi.fn();
    const { container } = render(
      <FilterChips
        chips={[
          { key: "status", label: "Status: Approved" },
          { key: "channel", label: "Channel: POS" },
        ]}
        onRemove={onRemove}
      />,
    );
    const buttons = container.querySelectorAll('button[aria-label^="Remove filter"]');
    fireEvent.click(buttons[1]);
    expect(onRemove).toHaveBeenCalledWith("channel");
  });

  it("does not show Clear all when only one chip is active", () => {
    const onClearAll = vi.fn();
    render(
      <FilterChips
        chips={[{ key: "status", label: "Status: Approved" }]}
        onRemove={() => {}}
        onClearAll={onClearAll}
      />,
    );
    expect(screen.queryByText("Clear all")).toBeNull();
  });

  it("shows Clear all and triggers callback when 2+ chips are active", () => {
    const onClearAll = vi.fn();
    render(
      <FilterChips
        chips={[
          { key: "status", label: "Status: Approved" },
          { key: "channel", label: "Channel: POS" },
        ]}
        onRemove={() => {}}
        onClearAll={onClearAll}
      />,
    );
    fireEvent.click(screen.getByText("Clear all"));
    expect(onClearAll).toHaveBeenCalledTimes(1);
  });

  it("does not show Clear all when onClearAll is not provided (even with multiple chips)", () => {
    render(
      <FilterChips
        chips={[
          { key: "status", label: "Status: Approved" },
          { key: "channel", label: "Channel: POS" },
        ]}
        onRemove={() => {}}
      />,
    );
    expect(screen.queryByText("Clear all")).toBeNull();
  });

  it("uses a region role + aria-label for screen readers", () => {
    const { container } = render(
      <FilterChips
        chips={[{ key: "status", label: "Status: Approved" }]}
        onRemove={() => {}}
      />,
    );
    const region = container.querySelector('[role="region"]');
    expect(region?.getAttribute("aria-label")).toBe("Active filters");
  });
});
