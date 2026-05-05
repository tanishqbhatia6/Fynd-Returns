/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// app/routes/app.docs.tsx is a pure documentation component — no loader,
// no server-side imports. The only thing worth stubbing is AppPage, which
// in real use renders inside the embedded admin chrome. Replace with a
// passthrough that surfaces the heading so we can target it from tests.
vi.mock("../../components/AppPage", () => ({
  AppPage: ({ heading, children }: { heading: React.ReactNode; children: React.ReactNode }) => (
    <div data-testid="app-page">
      <h1 data-testid="app-page-heading">{heading}</h1>
      {children}
    </div>
  ),
}));

import { renderWithRouter } from "../../test/component-helpers";
import { fireEvent, waitFor, within } from "@testing-library/react";
import Documentation from "../app.docs";

describe("app.docs (Documentation component)", () => {
  it("renders the AppPage heading 'Documentation'", () => {
    const { getByTestId } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    expect(getByTestId("app-page-heading").textContent).toBe("Documentation");
  });

  it("renders the default chapter title as an h1 with 'Welcome to Fynd Returns'", () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    const h1s = Array.from(container.querySelectorAll("h1"));
    const titles = h1s.map((h) => h.textContent?.trim());
    // First h1 is the AppPage heading, second is the chapter title
    expect(titles).toContain("Welcome to Fynd Returns");
  });

  it("renders the chapter index header (Chapter 1 of N)", () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    expect(container.textContent).toMatch(/Chapter 1 of \d+/);
  });

  it("renders a table-of-contents sidebar with multiple chapter buttons", () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    const sidebar = container.querySelector(".docs-sidebar");
    expect(sidebar).toBeTruthy();
    const chapterButtons = sidebar?.querySelectorAll("button") ?? [];
    // The full doc has many chapters; we only need to confirm the TOC isn't empty.
    expect(chapterButtons.length).toBeGreaterThan(5);
    const labels = Array.from(chapterButtons).map((b) => b.textContent?.trim() || "");
    expect(labels.some((l) => l.includes("Welcome to Fynd Returns"))).toBe(true);
    expect(labels.some((l) => l.includes("First-Time Setup"))).toBe(true);
  });

  it("renders the Quick links navigation block with router <Link> elements", () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    const sidebar = container.querySelector(".docs-sidebar");
    expect(sidebar).toBeTruthy();
    const anchors = Array.from(sidebar!.querySelectorAll("a"));
    const hrefs = anchors.map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(
      expect.arrayContaining([
        "/app",
        "/app/returns",
        "/app/settings",
        "/app/api-docs",
      ]),
    );
  });

  it("filters the sidebar via the search input", async () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    const sidebar = container.querySelector(".docs-sidebar") as HTMLElement;
    const search = sidebar.querySelector("input[type='text']") as HTMLInputElement;
    expect(search).toBeTruthy();

    fireEvent.change(search, { target: { value: "First-Time" } });

    await waitFor(() => {
      const buttons = sidebar.querySelectorAll("button");
      const labels = Array.from(buttons).map((b) => b.textContent?.trim() || "");
      expect(labels.some((l) => l.includes("First-Time Setup"))).toBe(true);
      expect(labels.some((l) => l.includes("Welcome to Fynd Returns"))).toBe(false);
    });
  });

  it("switches the chapter when a sidebar button is clicked", async () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    const sidebar = container.querySelector(".docs-sidebar") as HTMLElement;
    const buttons = Array.from(sidebar.querySelectorAll("button"));
    const setupBtn = buttons.find((b) =>
      (b.textContent || "").includes("First-Time Setup"),
    );
    expect(setupBtn).toBeTruthy();

    fireEvent.click(setupBtn!);

    await waitFor(() => {
      const h1s = Array.from(container.querySelectorAll("h1")).map((h) =>
        h.textContent?.trim(),
      );
      expect(h1s).toContain("First-Time Setup");
    });
  });

  it("renders code samples (<pre>) when navigating to the API chapter", async () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    const sidebar = container.querySelector(".docs-sidebar") as HTMLElement;
    const apiBtn = Array.from(sidebar.querySelectorAll("button")).find((b) =>
      /API/i.test(b.textContent || ""),
    );
    expect(apiBtn).toBeTruthy();

    fireEvent.click(apiBtn!);

    await waitFor(() => {
      const pres = container.querySelectorAll("pre");
      expect(pres.length).toBeGreaterThan(0);
      // The bash example begins with a curl invocation that uses X-Api-Key.
      const codeText = Array.from(pres)
        .map((p) => p.textContent || "")
        .join("\n");
      expect(codeText).toMatch(/curl/);
      expect(codeText).toMatch(/X-Api-Key/);
    });
  });

  it("renders inline <code> elements in the default chapter content", () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    // Welcome chapter mentions the ReturnEvent code token inline.
    const codeEls = Array.from(container.querySelectorAll("code"));
    const codeText = codeEls.map((c) => c.textContent || "").join("|");
    expect(codeEls.length).toBeGreaterThan(0);
    expect(codeText).toMatch(/ReturnEvent/);
    // Sanity-check that within the body of the page the ReturnEvent term is reachable.
    const body = within(container);
    expect(body.getByText("ReturnEvent")).toBeTruthy();
  });
});
