/** @vitest-environment jsdom */
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { SetupChecklist, type SetupStep } from "../SetupChecklist";

const STEP = (over: Partial<SetupStep> = {}): SetupStep => ({
  key: "smtp",
  title: "Configure email",
  description: "Add SMTP credentials so customers receive notifications",
  done: false,
  href: "/app/settings/notifications",
  ...over,
});

describe("<SetupChecklist />", () => {
  it("renders the heading and progress meter for an in-flight checklist", () => {
    const steps: SetupStep[] = [
      STEP({ key: "a", done: true }),
      STEP({ key: "b", done: false }),
      STEP({ key: "c", done: false }),
    ];
    render(<SetupChecklist steps={steps} />);
    expect(screen.getByText("Finish setting up")).toBeTruthy();
    expect(screen.getByText("1 of 3 complete · 33%")).toBeTruthy();
  });

  it("returns null (renders nothing) when every step is done", () => {
    const { container } = render(
      <SetupChecklist steps={[STEP({ done: true }), STEP({ key: "b", done: true })]} />,
    );
    expect(container.querySelector(".app-setup-checklist")).toBeNull();
  });

  it("renders nothing when steps list is empty", () => {
    const { container } = render(<SetupChecklist steps={[]} />);
    // empty checklist still has zero progress; we explicitly return null when total===0 and done===total
    // (0 of 0 = 100%); component returns null
    expect(container.querySelector(".app-setup-checklist")).toBeNull();
  });

  it("strikes through completed steps", () => {
    // Need at least one pending step so the checklist renders at all.
    render(
      <SetupChecklist
        steps={[
          STEP({ key: "a", done: true, title: "Done step" }),
          STEP({ key: "b", done: false, title: "Pending step" }),
        ]}
      />,
    );
    const title = screen.getByText("Done step") as HTMLElement;
    expect(title.style.textDecoration).toBe("line-through");
  });

  it("hides CTA on completed steps and shows it on pending", () => {
    const { container } = render(
      <SetupChecklist
        steps={[
          STEP({ key: "a", done: true, title: "Done" }),
          STEP({ key: "b", done: false, title: "Pending" }),
        ]}
      />,
    );
    const ctas = container.querySelectorAll("a");
    expect(ctas).toHaveLength(1);
    expect(ctas[0].textContent).toBe("Configure");
  });

  it("respects ctaLabel override per step", () => {
    render(
      <SetupChecklist
        steps={[STEP({ ctaLabel: "Send test email" })]}
      />,
    );
    expect(screen.getByText("Send test email")).toBeTruthy();
  });

  it("links each pending step's CTA to its href", () => {
    const { container } = render(
      <SetupChecklist steps={[STEP({ href: "/app/settings/portal" })]} />,
    );
    const a = container.querySelector("a")!;
    expect(a.getAttribute("href")).toBe("/app/settings/portal");
  });

  it("shows the dismiss button only when onDismiss is provided", () => {
    const { rerender, container } = render(<SetupChecklist steps={[STEP()]} />);
    expect(container.querySelector('[aria-label="Dismiss setup checklist"]')).toBeNull();
    rerender(<SetupChecklist steps={[STEP()]} onDismiss={() => {}} />);
    expect(container.querySelector('[aria-label="Dismiss setup checklist"]')).toBeTruthy();
  });

  it("calls onDismiss when the X is clicked", () => {
    const onDismiss = vi.fn();
    const { container } = render(<SetupChecklist steps={[STEP()]} onDismiss={onDismiss} />);
    fireEvent.click(container.querySelector('[aria-label="Dismiss setup checklist"]')!);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("respects a heading override", () => {
    render(<SetupChecklist steps={[STEP()]} heading="Welcome — get started" />);
    expect(screen.getByText("Welcome — get started")).toBeTruthy();
  });
});
