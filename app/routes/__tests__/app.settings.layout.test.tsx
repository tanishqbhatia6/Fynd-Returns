/**
 * @vitest-environment jsdom
 *
 * Coverage test for app/routes/app.settings.tsx — a tiny pass-through layout
 * route that simply renders <Outlet />. The component has no loader, no
 * imports beyond `react-router`, and only one executable line.
 *
 * The goal is to push statement coverage from 0% → 100% by mounting the
 * component inside a memory router whose child route renders a sentinel
 * element. If <Outlet /> works, the sentinel is rendered.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import {
  createMemoryRouter,
  RouterProvider,
  type RouteObject,
} from "react-router";

// Defensive mocks. The settings layout itself only imports react-router,
// but other files in this directory's test suite mock these globally; we
// add them here too so the test runs in any vitest order.
vi.mock("../../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../../db.server", () => ({
  default: {},
}));
vi.mock("@shopify/shopify-app-react-router/react", () => ({
  AppProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-provider">{children}</div>
  ),
}));

import SettingsLayout from "../app.settings";

describe("app.settings layout", () => {
  it("renders an <Outlet /> that mounts the matching child route", () => {
    const ChildSentinel = () => (
      <div data-testid="settings-child">child-rendered</div>
    );
    const routes: RouteObject[] = [
      {
        path: "/app/settings",
        element: <SettingsLayout />,
        children: [
          {
            index: true,
            element: <ChildSentinel />,
          },
        ],
      },
    ];
    const router = createMemoryRouter(routes, {
      initialEntries: ["/app/settings"],
    });
    const { getByTestId } = render(<RouterProvider router={router} />);
    // If the layout's <Outlet /> works, the child route's sentinel renders.
    expect(getByTestId("settings-child").textContent).toBe("child-rendered");
  });

  it("is a function component (default export) with no own DOM markup", () => {
    // Ensure the default export is a usable component reference.
    expect(typeof SettingsLayout).toBe("function");
    // Render with no children: <Outlet /> renders nothing on its own.
    const routes: RouteObject[] = [
      {
        path: "/app/settings",
        element: <SettingsLayout />,
      },
    ];
    const router = createMemoryRouter(routes, {
      initialEntries: ["/app/settings"],
    });
    const { container } = render(<RouterProvider router={router} />);
    // No child route → Outlet renders nothing, container should be empty.
    expect(container.textContent).toBe("");
  });
});
