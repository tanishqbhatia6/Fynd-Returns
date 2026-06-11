import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { AppPage } from "../AppPage";

function renderPage(path: string, props: Partial<React.ComponentProps<typeof AppPage>> = {}) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppPage heading="Settings child" {...props}>
        <div>Body</div>
      </AppPage>
    </MemoryRouter>,
  );
}

describe("AppPage", () => {
  it("automatically renders a back link for nested settings routes", () => {
    const { container } = renderPage("/app/settings/return-settings");
    const backLink = container.querySelector("a.app-page-back");
    expect(backLink?.getAttribute("href")).toBe("/app/settings");
  });

  it("does not render an automatic back link on the settings index", () => {
    const { container } = renderPage("/app/settings");
    expect(container.querySelector("a.app-page-back")).toBeNull();
  });

  it("uses an explicit backHref when provided", () => {
    const { container } = renderPage("/app/returns/ret_1", { backHref: "/app/returns" });
    const backLink = container.querySelector("a.app-page-back");
    expect(backLink?.getAttribute("href")).toBe("/app/returns");
  });
});
