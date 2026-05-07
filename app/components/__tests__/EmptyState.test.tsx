/** @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { EmptyState } from "../EmptyState";

describe("<EmptyState />", () => {
  it("renders title only when description and action absent", () => {
    render(<EmptyState title="No returns yet" />);
    expect(screen.getByText("No returns yet")).toBeTruthy();
  });

  it("renders title, description, and action together", () => {
    render(
      <EmptyState
        title="No returns"
        description="Customers can request returns from your storefront once enabled."
        action={<button type="button">Enable returns</button>}
      />,
    );
    expect(screen.getByText("No returns")).toBeTruthy();
    expect(screen.getByText(/Customers can request returns/)).toBeTruthy();
    expect(screen.getByText("Enable returns")).toBeTruthy();
  });

  it("renders the icon when provided", () => {
    render(
      <EmptyState
        icon={<svg data-testid="empty-icon" width="24" height="24" />}
        title="Empty"
      />,
    );
    expect(screen.getByTestId("empty-icon")).toBeTruthy();
  });

  it("uses compact padding when variant=compact", () => {
    const { container } = render(<EmptyState title="x" variant="compact" />);
    const root = container.querySelector(".app-empty-state") as HTMLElement;
    expect(root.style.padding).toBe("24px 16px");
  });

  it("uses default padding otherwise", () => {
    const { container } = render(<EmptyState title="x" />);
    const root = container.querySelector(".app-empty-state") as HTMLElement;
    expect(root.style.padding).toBe("56px 32px");
  });
});
