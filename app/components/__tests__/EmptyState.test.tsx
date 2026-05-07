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

  it("compact variant + icon uses 8px margin instead of 16px (line 48 branch)", () => {
    const { container } = render(
      <EmptyState
        variant="compact"
        icon={<svg data-testid="ic" width="16" height="16" />}
        title="x"
      />,
    );
    const iconWrap = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(iconWrap.style.marginBottom).toBe("8px");
  });

  it("compact + description uses 13px font and skips bottom margin without action", () => {
    const { container } = render(
      <EmptyState variant="compact" title="t" description="lorem" />,
    );
    const desc = container.querySelector("div > div:nth-child(2)") as HTMLElement;
    expect(desc.style.fontSize).toBe("13px");
    expect(desc.style.marginBottom).toBe("0px");
  });

  it("compact + description + action uses 12px bottom margin on description (line 70 compact branch)", () => {
    const { getByText } = render(
      <EmptyState
        variant="compact"
        title="title-x"
        description="description-y"
        action={<button type="button">go</button>}
      />,
    );
    const desc = getByText("description-y") as HTMLElement;
    expect(desc.style.marginBottom).toBe("12px");
  });

  it("default + description + action uses 20px bottom margin on description", () => {
    const { getByText } = render(
      <EmptyState
        title="title-x"
        description="description-y"
        action={<button type="button">go</button>}
      />,
    );
    const desc = getByText("description-y") as HTMLElement;
    expect(desc.style.marginBottom).toBe("20px");
  });

  it("compact + action uses 12px top margin on action", () => {
    const { container } = render(
      <EmptyState variant="compact" title="t" action={<button type="button">go</button>} />,
    );
    const action = container.querySelector("button")!.parentElement as HTMLElement;
    expect(action.style.marginTop).toBe("12px");
  });
});
