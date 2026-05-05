/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Mocks for module-top-level imports in app.settings.product-policies.tsx ──
// The route pulls in shopify.server / db.server / lib/shop.server purely for
// the loader/action and transitive module evaluation. Stub them so the
// component imports cleanly in jsdom.
vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../db.server", () => ({
  default: {
    shopSettings: { upsert: vi.fn() },
  },
}));
vi.mock("../lib/shop.server", () => ({
  findOrCreateShop: vi.fn(),
}));

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
import { waitFor, fireEvent } from "@testing-library/react";
import ProductPoliciesSettings, {
  type ProductPolicyRule,
} from "../app.settings.product-policies";

const emptyLoaderData: { rules: ProductPolicyRule[] } = { rules: [] };

const populatedLoaderData: { rules: ProductPolicyRule[] } = {
  rules: [
    {
      id: "rule-1",
      matchType: "tags",
      matchValue: "final-sale",
      windowDays: 0,
      policyText: "Final sale items cannot be returned",
      returnable: false,
    },
    {
      id: "rule-2",
      matchType: "product_type",
      matchValue: "Electronics",
      windowDays: 14,
      policyText: "",
      returnable: true,
    },
  ],
};

describe("ProductPoliciesSettings (default export)", () => {
  it("renders the page heading", async () => {
    const { findByText } = renderWithRouter(ProductPoliciesSettings, {
      initialEntries: ["/app/settings/product-policies"],
      loaderData: emptyLoaderData,
    });
    expect(await findByText("Product-Level Return Policies")).toBeTruthy();
  });

  it("shows the empty state with an 'Add first rule' CTA when no rules exist", async () => {
    const { container } = renderWithRouter(ProductPoliciesSettings, {
      initialEntries: ["/app/settings/product-policies"],
      loaderData: emptyLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain(
        "No product policies defined yet.",
      );
    });
    expect(container.textContent).toContain(
      "All products will use the global return window from Return Settings.",
    );
    const addButtons = Array.from(
      container.querySelectorAll("s-button"),
    ).filter((b) => b.textContent?.trim() === "Add first rule");
    expect(addButtons.length).toBe(1);
  });

  it("clicking 'Add first rule' replaces the empty state with a rule editor card", async () => {
    const { container } = renderWithRouter(ProductPoliciesSettings, {
      initialEntries: ["/app/settings/product-policies"],
      loaderData: emptyLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain(
        "No product policies defined yet.",
      );
    });
    const addBtn = Array.from(container.querySelectorAll("s-button")).find(
      (b) => b.textContent?.trim() === "Add first rule",
    );
    expect(addBtn).toBeTruthy();
    fireEvent.click(addBtn!);

    await waitFor(() => {
      expect(container.textContent).not.toContain(
        "No product policies defined yet.",
      );
    });
    // A new rule renders the Match-by select and the "+ Add rule" footer btn.
    expect(container.querySelector("select")).toBeTruthy();
    const footerAdd = Array.from(container.querySelectorAll("s-button")).find(
      (b) => b.textContent?.trim() === "+ Add rule",
    );
    expect(footerAdd).toBeTruthy();
  });

  it("renders one editor card per rule with the correct match values when populated", async () => {
    const { container } = renderWithRouter(ProductPoliciesSettings, {
      initialEntries: ["/app/settings/product-policies"],
      loaderData: populatedLoaderData,
    });
    await waitFor(() => {
      const inputs = container.querySelectorAll("input[type='text']");
      // Each rule has 2 text inputs (matchValue + policyText) → 4 total.
      expect(inputs.length).toBeGreaterThanOrEqual(4);
    });

    const textInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>("input[type='text']"),
    );
    const values = textInputs.map((i) => i.value);
    expect(values).toContain("final-sale");
    expect(values).toContain("Electronics");
    expect(values).toContain("Final sale items cannot be returned");

    // Empty-state copy should be gone.
    expect(container.textContent).not.toContain(
      "No product policies defined yet.",
    );
  });

  it("shows the 'Returnable' / 'Not returnable' badge per rule and hides the window-days input for non-returnable rules", async () => {
    const { container } = renderWithRouter(ProductPoliciesSettings, {
      initialEntries: ["/app/settings/product-policies"],
      loaderData: populatedLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Not returnable");
    });
    expect(container.textContent).toContain("Returnable");

    // Only one number input should be present, since rule-1 is not returnable.
    const numberInputs = container.querySelectorAll("input[type='number']");
    expect(numberInputs.length).toBe(1);
    expect((numberInputs[0] as HTMLInputElement).value).toBe("14");
  });

  it("removing a rule via the trash icon reduces the rendered card count", async () => {
    const { container } = renderWithRouter(ProductPoliciesSettings, {
      initialEntries: ["/app/settings/product-policies"],
      loaderData: populatedLoaderData,
    });
    await waitFor(() => {
      const removes = container.querySelectorAll(
        "button[aria-label='Remove rule']",
      );
      expect(removes.length).toBe(2);
    });

    const removeButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(
        "button[aria-label='Remove rule']",
      ),
    );
    fireEvent.click(removeButtons[0]);

    await waitFor(() => {
      const remaining = container.querySelectorAll(
        "button[aria-label='Remove rule']",
      );
      expect(remaining.length).toBe(1);
    });
    // The "final-sale" rule is gone (its policyText is in DOM textContent),
    // and "Electronics" remains as the matchValue input on the surviving card.
    expect(container.textContent).not.toContain(
      "Final sale items cannot be returned",
    );
    const surviving = Array.from(
      container.querySelectorAll<HTMLInputElement>("input[type='text']"),
    ).map((i) => i.value);
    expect(surviving).toContain("Electronics");
    expect(surviving).not.toContain("final-sale");
  });

  it("toggles the windowDays input visibility when 'Returnable' checkbox flips", async () => {
    const { container } = renderWithRouter(ProductPoliciesSettings, {
      initialEntries: ["/app/settings/product-policies"],
      loaderData: populatedLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelectorAll("input[type='number']").length).toBe(1);
    });

    // Find the returnable checkbox for rule-2 (currently checked).
    const checkboxes = Array.from(
      container.querySelectorAll<HTMLInputElement>("input[type='checkbox']"),
    );
    expect(checkboxes.length).toBe(2);
    const checkedBox = checkboxes.find((c) => c.checked);
    expect(checkedBox).toBeTruthy();

    fireEvent.click(checkedBox!);

    await waitFor(() => {
      // Now no rule is returnable → no window-days input visible.
      expect(container.querySelectorAll("input[type='number']").length).toBe(0);
    });
  });

  it("renders Save and Discard buttons with a link back to /app/settings", async () => {
    const { container } = renderWithRouter(ProductPoliciesSettings, {
      initialEntries: ["/app/settings/product-policies"],
      loaderData: emptyLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector(".app-actions")).toBeTruthy();
    });
    const actionButtons = Array.from(
      container.querySelectorAll(".app-actions s-button"),
    ).map((b) => b.textContent?.trim());
    expect(actionButtons).toContain("Save");
    expect(actionButtons).toContain("Discard");

    const discardLink = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "/app/settings",
    );
    expect(discardLink).toBeTruthy();
  });
});
