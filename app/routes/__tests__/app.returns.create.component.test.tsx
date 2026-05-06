/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Mocks for module-top-level imports in app/routes/app.returns.create.tsx ──
// The component imports `authenticate` from app/shopify.server purely for the
// loader. Stub that module so importing the component in jsdom doesn't blow
// up on Node-only deps.
vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));

// app/shopify.server.ts (which is what the route imports) calls shopifyApp()
// at module load. Even though we mock that file above, vitest still resolves
// nested deps in some cases — provide a stub factory so the import never
// throws.
vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: {
    error: vi.fn(() => null),
    headers: vi.fn(() => ({})),
  },
  shopifyApp: vi.fn(() => ({
    addDocumentResponseHeaders: vi.fn(),
    authenticate: { admin: vi.fn() },
    unauthenticated: {},
    login: vi.fn(),
    registerWebhooks: vi.fn(),
    sessionStorage: {},
  })),
  ApiVersion: { January25: "2025-01" },
  AppDistribution: { AppStore: "app_store" },
  DeliveryMethod: { Http: "http" },
}));

import { renderWithRouter } from "../../test/component-helpers";
import { waitFor, fireEvent, act } from "@testing-library/react";
import CreateReturn from "../app.returns.create";

const baseLoaderData = {
  shopDomain: "test-shop.myshopify.com",
};

describe("app.returns.create component (default export)", () => {
  it("renders the page heading and step badge for step 1", async () => {
    const { container } = renderWithRouter(CreateReturn, {
      initialEntries: ["/app/returns/create"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      const h1 = container.querySelector("h1");
      expect(h1?.textContent).toBe("Create Return");
    });
    expect(container.textContent).toContain("Step 1 of 4");
  });

  it("renders the order-number input and Search button on step 1", async () => {
    const { container } = renderWithRouter(CreateReturn, {
      initialEntries: ["/app/returns/create"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      const input = container.querySelector(
        'input[placeholder="e.g. 1042, #1042"]',
      ) as HTMLInputElement | null;
      expect(input).toBeTruthy();
      expect(input?.type).toBe("text");
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const searchBtn = buttons.find((b) => /Search/i.test(b.textContent || ""));
    expect(searchBtn).toBeTruthy();
  });

  it("renders the 'Look up Order' section title and subtitle", async () => {
    const { findByText, container } = renderWithRouter(CreateReturn, {
      initialEntries: ["/app/returns/create"],
      loaderData: baseLoaderData,
    });
    expect(await findByText("Look up Order")).toBeTruthy();
    expect(container.textContent).toContain(
      "Enter the Shopify order number to load items for the return.",
    );
  });

  it("renders all four step labels in the stepper", async () => {
    const { container } = renderWithRouter(CreateReturn, {
      initialEntries: ["/app/returns/create"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Order Lookup");
    });
    expect(container.textContent).toContain("Select Items");
    expect(container.textContent).toContain("Customer & CRM");
    expect(container.textContent).toContain("Review & Submit");
  });

  it("renders the breadcrumb back-link to /app/returns", async () => {
    const { container } = renderWithRouter(CreateReturn, {
      initialEntries: ["/app/returns/create"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      const backLink = container.querySelector('a[href="/app/returns"]');
      expect(backLink).toBeTruthy();
      expect(backLink?.textContent).toContain("Returns");
    });
  });

  it("shows a validation error when Search is clicked with an empty input", async () => {
    const { container } = renderWithRouter(CreateReturn, {
      initialEntries: ["/app/returns/create"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(
        container.querySelector('input[placeholder="e.g. 1042, #1042"]'),
      ).toBeTruthy();
    });
    const buttons = Array.from(container.querySelectorAll("button"));
    const searchBtn = buttons.find((b) =>
      /Search/i.test(b.textContent || ""),
    ) as HTMLButtonElement;
    fireEvent.click(searchBtn);
    await waitFor(() => {
      expect(container.textContent).toContain(
        "Please enter an order number.",
      );
    });
  });

  it("updates the order input value on change", async () => {
    const { container } = renderWithRouter(CreateReturn, {
      initialEntries: ["/app/returns/create"],
      loaderData: baseLoaderData,
    });
    let input: HTMLInputElement | null = null;
    await waitFor(() => {
      input = container.querySelector(
        'input[placeholder="e.g. 1042, #1042"]',
      ) as HTMLInputElement | null;
      expect(input).toBeTruthy();
    });
    await act(async () => { fireEvent.change(input!, { target: { value: "1042" } }); });
    await waitFor(() => { expect(input!.value).toBe("1042"); });
  });

  it("does not render step 2/3/4 sections initially", async () => {
    const { container } = renderWithRouter(CreateReturn, {
      initialEntries: ["/app/returns/create"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Look up Order");
    });
    expect(container.textContent).not.toContain("Select Items to Return");
    expect(container.textContent).not.toContain("Customer Information");
    expect(container.textContent).not.toContain("Return Items");
  });
});
