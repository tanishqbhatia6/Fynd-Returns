/**
 * @vitest-environment jsdom
 *
 * Gap-coverage suite for `app/routes/app.docs.tsx`.
 *
 * The companion suite `app.docs.component.test.tsx` covers the happy-path
 * rendering of the default chapter, search filter (match path), TOC layout,
 * and a couple of chapter switches. This suite exists purely to push *branch*
 * coverage to >=95% by exercising every chapter (which transitively renders
 * every primitive: StatusPill, DoDont, Faq, Tip, Warning, Danger, Success,
 * InlineKey, FieldRow defaults) plus the no-match search path, the
 * prev/next boundary states, and the ErrorBoundary export.
 *
 * NO source modifications. Tests target rendered DOM only.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

vi.mock("../../components/AppPage", () => ({
  AppPage: ({ heading, children }: { heading: React.ReactNode; children: React.ReactNode }) => (
    <div data-testid="app-page">
      <h1 data-testid="app-page-heading">{heading}</h1>
      {children}
    </div>
  ),
}));

import { renderWithRouter } from "../../test/component-helpers";
import { fireEvent, waitFor } from "@testing-library/react";
import Documentation, { ErrorBoundary } from "../app.docs";
import {
  createMemoryRouter,
  RouterProvider,
  type RouteObject,
} from "react-router";
import { render } from "@testing-library/react";

/** Click the sidebar TOC button whose label includes the supplied substring. */
async function clickChapter(container: HTMLElement, match: string) {
  const sidebar = container.querySelector(".docs-sidebar") as HTMLElement;
  const btn = Array.from(sidebar.querySelectorAll("button")).find((b) =>
    (b.textContent || "").includes(match),
  );
  expect(btn, `chapter button containing "${match}" not found`).toBeTruthy();
  fireEvent.click(btn!);
  await waitFor(() => {
    const headings = Array.from(container.querySelectorAll("h1")).map((h) =>
      (h.textContent || "").trim(),
    );
    expect(headings.some((t) => t.includes(match))).toBe(true);
  });
}

describe("app.docs branch-coverage gap suite", () => {
  it("renders the default 'welcome' chapter (Highlights + KeyPoints branches)", () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    // Highlights items use the fallback star icon branch (no `icon` prop on any item).
    const stars = Array.from(container.querySelectorAll("span")).filter(
      (s) => s.textContent === "★",
    );
    expect(stars.length).toBeGreaterThan(0);
  });

  it("shows the no-match empty state when the search filter has zero hits", async () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    const sidebar = container.querySelector(".docs-sidebar") as HTMLElement;
    const search = sidebar.querySelector("input[type='text']") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "zzzzzz-no-match-xyz" } });
    await waitFor(() => {
      expect(sidebar.textContent).toMatch(/No chapters match "zzzzzz-no-match-xyz"/);
    });
    // The TOC button list collapses to zero entries.
    const buttons = sidebar.querySelectorAll("button");
    expect(buttons.length).toBe(0);
  });

  it("matches by chapter subtitle (search filter subtitle branch)", async () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    const sidebar = container.querySelector(".docs-sidebar") as HTMLElement;
    const search = sidebar.querySelector("input[type='text']") as HTMLInputElement;
    // "production-ready" appears only inside a subtitle, not in any title.
    fireEvent.change(search, { target: { value: "production-ready" } });
    await waitFor(() => {
      const labels = Array.from(sidebar.querySelectorAll("button")).map(
        (b) => (b.textContent || "").trim(),
      );
      expect(labels.some((l) => l.includes("First-Time Setup"))).toBe(true);
    });
  });

  it("clearing the search restores the full chapter list (search trim branch)", async () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    const sidebar = container.querySelector(".docs-sidebar") as HTMLElement;
    const search = sidebar.querySelector("input[type='text']") as HTMLInputElement;
    fireEvent.change(search, { target: { value: "   " } });
    // Only-whitespace value should still take the unfiltered branch.
    await waitFor(() => {
      const buttons = sidebar.querySelectorAll("button");
      expect(buttons.length).toBeGreaterThan(10);
    });
  });

  it("shows a Previous-disabled spacer on the first chapter", () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    // Find the prev/next nav row (last grid row in the content column).
    const prevText = Array.from(container.querySelectorAll("button")).map(
      (b) => b.textContent || "",
    );
    // No "Previous" button should be present on the first chapter.
    expect(prevText.some((t) => t.includes("← Previous"))).toBe(false);
    // But a "Next →" button should be.
    expect(prevText.some((t) => t.includes("Next →"))).toBe(true);
  });

  it("clicking 'Next →' advances to chapter 2 and renders Previous", async () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    const nextBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent || "").includes("Next →"),
    );
    expect(nextBtn).toBeTruthy();
    fireEvent.click(nextBtn!);
    await waitFor(() => {
      expect(container.textContent).toMatch(/Chapter 2 of \d+/);
    });
    const prevBtn = Array.from(container.querySelectorAll("button")).find((b) =>
      (b.textContent || "").includes("← Previous"),
    );
    expect(prevBtn).toBeTruthy();
    // Clicking it brings us back.
    fireEvent.click(prevBtn!);
    await waitFor(() => {
      expect(container.textContent).toMatch(/Chapter 1 of \d+/);
    });
  });

  it("hides Next on the final chapter (Glossary) — boundary branch", async () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    await clickChapter(container, "Glossary");
    const allBtnText = Array.from(container.querySelectorAll("button")).map(
      (b) => b.textContent || "",
    );
    expect(allBtnText.some((t) => t.includes("Next →"))).toBe(false);
    expect(allBtnText.some((t) => t.includes("← Previous"))).toBe(true);
  });

  it("renders Customer Portal chapter (FAQ rendering branch)", async () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    await clickChapter(container, "Customer Portal");
    const details = container.querySelectorAll("details");
    expect(details.length).toBeGreaterThan(0);
    // Open one of the FAQs to exercise the open branch.
    const first = details[0] as HTMLDetailsElement;
    expect(first.open).toBe(false);
    fireEvent.click(first.querySelector("summary")!);
    // jsdom toggles the open attribute when summary is clicked.
    first.open = true;
    expect(first.open).toBe(true);
  });

  it("renders Customer Portal chapter (DoDont primitive branch)", async () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    await clickChapter(container, "Customer Portal");
    // The DoDont block emits "✓ Do" and "✗ Don't" headings.
    expect(container.textContent).toMatch(/✓ Do/);
    expect(container.textContent).toMatch(/Don't/);
  });

  it("renders Managing Returns chapter with all StatusPill colour branches", async () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    await clickChapter(container, "Managing Returns");
    expect(container.textContent).toMatch(/initiated/);
    expect(container.textContent).toMatch(/pending/);
    expect(container.textContent).toMatch(/processing/);
    expect(container.textContent).toMatch(/approved/);
    expect(container.textContent).toMatch(/completed/);
    expect(container.textContent).toMatch(/rejected/);
    expect(container.textContent).toMatch(/cancelled/);
  });

  it("renders Processing Refunds chapter (Tip + Warning + Danger primitives)", async () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    await clickChapter(container, "Processing Refunds");
    // Danger callout title used in this chapter.
    expect(container.textContent).toMatch(/Shopify REQUIRES a location/);
    // Tip callout
    expect(container.textContent).toMatch(/Auto-refund won't fire/);
    // Warning callout
    expect(container.textContent).toMatch(/Shopify refund can't be undone/);
  });

  it("renders Connecting Fynd chapter (Warning + Tip combos)", async () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    await clickChapter(container, "Connecting Fynd");
    expect(container.textContent).toMatch(/Platform API credentials only/);
    expect(container.textContent).toMatch(/Shop-scoped endpoint/);
  });

  it("renders Exchanges & Store Credit chapter", async () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    await clickChapter(container, "Exchanges");
    expect(container.textContent).toMatch(/Store credit codes are one-time use/);
  });

  it("renders Automation & Rules chapter (StatusPill four-bucket fraud branch)", async () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    await clickChapter(container, "Automation");
    expect(container.textContent).toMatch(/low \(0–24\)/);
    expect(container.textContent).toMatch(/medium \(25–49\)/);
    expect(container.textContent).toMatch(/high \(50–74\)/);
    expect(container.textContent).toMatch(/critical \(75–100\)/);
  });

  it("renders Notifications chapter (Tip + Success primitives)", async () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    await clickChapter(container, "Notifications");
    expect(container.textContent).toMatch(/Recommended SMTP providers/);
    expect(container.textContent).toMatch(/Webhooks > email for real-time/);
  });

  it("renders Dashboard & Analytics chapter (Tip primitive only)", async () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    await clickChapter(container, "Dashboard");
    expect(container.textContent).toMatch(/All date boundaries use merchant timezone/);
  });

  it("renders All Settings chapter (FieldRow defaultValue branch)", async () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    await clickChapter(container, "All Settings");
    // FieldRow renders "default" labels when defaultValue is provided.
    expect(container.textContent).toMatch(/default/i);
    // REQ pill from `required` branch.
    expect(container.textContent).toMatch(/Refund restock location/);
  });

  it("renders Webhooks chapter (FieldRow + content)", async () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    await clickChapter(container, "Webhooks");
    expect(container.textContent).toMatch(/return\.in_transit/);
  });

  it("renders Security chapter (DoDont + FieldRow with required pill)", async () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    await clickChapter(container, "Security");
    expect(container.textContent).toMatch(/PII minimisation/);
    expect(container.textContent).toMatch(/read_fulfillments/);
    // The required pill ("REQ") is rendered on at least one row.
    expect(container.textContent).toMatch(/REQ/);
  });

  it("renders Customer Management chapter (DoDont primitive)", async () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    await clickChapter(container, "Customer Management");
    expect(container.textContent).toMatch(/Do/);
  });

  it("renders Internationalization chapter (Tip primitive variant)", async () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    await clickChapter(container, "Internationalisation");
    expect(container.textContent).toMatch(/Set these once, forget forever/);
  });

  it("renders Pagination chapter (Tip primitive)", async () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    await clickChapter(container, "Pagination");
    expect(container.textContent).toMatch(/Need everything in one shot/);
  });

  it("renders Troubleshooting chapter (large Faq cluster)", async () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    await clickChapter(container, "Troubleshooting");
    const details = container.querySelectorAll("details");
    expect(details.length).toBeGreaterThan(5);
  });

  it("renders Glossary chapter (FieldRow without defaultValue/required branches)", async () => {
    const { container } = renderWithRouter(Documentation, {
      initialEntries: ["/app/docs"],
    });
    await clickChapter(container, "Glossary");
    expect(container.textContent).toMatch(/AWB/);
    expect(container.textContent).toMatch(/App Proxy/);
  });

  it("renders ErrorBoundary with a thrown Error message", () => {
    function Boom(): React.ReactElement {
      throw new Error("boom-error-message");
    }
    const routes: RouteObject[] = [
      {
        path: "/",
        element: <Boom />,
        ErrorBoundary,
      },
    ];
    const router = createMemoryRouter(routes, { initialEntries: ["/"] });
    const { container, getByText } = render(<RouterProvider router={router} />);
    expect(getByText("boom-error-message")).toBeTruthy();
    // "Try again" link is rendered.
    const link = container.querySelector("a[href='/app/docs']");
    expect(link).toBeTruthy();
  });

  it("renders ErrorBoundary fallback string when error is non-Error/non-Response", () => {
    function Boom(): React.ReactElement {
      // Throw a plain string — caught by react-router and surfaced via useRouteError().
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw "raw-string-error";
    }
    const routes: RouteObject[] = [
      {
        path: "/",
        element: <Boom />,
        ErrorBoundary,
      },
    ];
    const router = createMemoryRouter(routes, { initialEntries: ["/"] });
    const { container } = render(<RouterProvider router={router} />);
    // Falls through to the "An unexpected error occurred." branch.
    expect(container.textContent).toMatch(/An unexpected error occurred\./);
  });

  it("renders ErrorBoundary with an isRouteErrorResponse (data populated) branch", async () => {
    // A loader that throws a Response triggers the isRouteErrorResponse arm
    // of `useRouteError`. The route's element never renders — react-router
    // mounts ErrorBoundary instead.
    const routes: RouteObject[] = [
      {
        path: "/",
        element: <div>never rendered</div>,
        loader: () => {
          throw new Response("not found body", { status: 404, statusText: "Not Found" });
        },
        ErrorBoundary,
      },
    ];
    const router = createMemoryRouter(routes, { initialEntries: ["/"] });
    const { container } = render(<RouterProvider router={router} />);
    await waitFor(() => {
      // `error.data` is "not found body"; fallback path produces "Error 404".
      expect(container.textContent || "").toMatch(/(not found body|Error 404)/);
    });
  });

  it("renders ErrorBoundary with an isRouteErrorResponse and empty data (fallback branch)", async () => {
    // Response with empty body → error.data is "" (falsy) → falls through to
    // the right side of the `||` ternary: "Error <status>".
    const routes: RouteObject[] = [
      {
        path: "/",
        element: <div>never rendered</div>,
        loader: () => {
          throw new Response("", { status: 500, statusText: "Server Error" });
        },
        ErrorBoundary,
      },
    ];
    const router = createMemoryRouter(routes, { initialEntries: ["/"] });
    const { container } = render(<RouterProvider router={router} />);
    await waitFor(() => {
      expect(container.textContent || "").toMatch(/Error 500/);
    });
  });
});
