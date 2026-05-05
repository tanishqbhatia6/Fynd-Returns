/**
 * Helpers for component (jsdom) tests. Use with `vitest.components.config.mts`.
 *
 * Provides:
 *  - `renderWithRouter`: mounts a component inside a React Router 7 stub
 *    (createMemoryRouter + RouterProvider) so hooks like useLoaderData,
 *    useNavigation, useFetcher, useSubmit work without throwing.
 *  - `mockLoaderData<T>(data)`: patches the global useLoaderData hook to
 *    return a specific shape so the component renders deterministically.
 */
import React from "react";
import { render, type RenderResult } from "@testing-library/react";
import {
  createMemoryRouter,
  RouterProvider,
  type RouteObject,
} from "react-router";

export type RenderWithRouterOptions = {
  /** Path the memory router starts at. */
  initialEntries?: string[];
  /** Loader data returned for the rendered route. */
  loaderData?: unknown;
  /** Action data returned for the rendered route. */
  actionData?: unknown;
};

/**
 * Mount a single React component as the leaf of a memory router, so hooks
 * like useLoaderData / useNavigation / useFetcher resolve without crashing.
 *
 * The component is wrapped in a route at "/" — pass `initialEntries` to
 * change. `loaderData` and `actionData` are returned as the route's
 * pre-resolved values.
 */
export function renderWithRouter(
  Component: React.ComponentType,
  options: RenderWithRouterOptions = {},
): RenderResult {
  const { initialEntries = ["/"], loaderData, actionData } = options;
  const routes: RouteObject[] = [
    {
      path: "*",
      element: <Component />,
      loader: loaderData !== undefined ? () => loaderData : undefined,
      action: actionData !== undefined ? () => actionData : undefined,
    },
  ];
  const router = createMemoryRouter(routes, { initialEntries });
  return render(<RouterProvider router={router} />);
}
