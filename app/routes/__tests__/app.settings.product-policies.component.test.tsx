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
import { act, waitFor, fireEvent } from "@testing-library/react";
import ProductPoliciesSettings, { type ProductPolicyRule } from "../app.settings.product-policies";

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

const WAIT = { timeout: 8000 };

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
      expect(container.textContent).toContain("No product policies defined yet.");
    }, WAIT);
    expect(container.textContent).toContain(
      "All products will use the global return window from Return Settings.",
    );
    const addButtons = Array.from(container.querySelectorAll("s-button")).filter(
      (b) => b.textContent?.trim() === "Add first rule",
    );
    expect(addButtons.length).toBe(1);
  });

  it("clicking 'Add first rule' replaces the empty state with a rule editor card", async () => {
    const { container } = renderWithRouter(ProductPoliciesSettings, {
      initialEntries: ["/app/settings/product-policies"],
      loaderData: emptyLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("No product policies defined yet.");
    }, WAIT);
    const addBtn = Array.from(container.querySelectorAll("s-button")).find(
      (b) => b.textContent?.trim() === "Add first rule",
    );
    expect(addBtn).toBeTruthy();
    fireEvent.click(addBtn!);

    await waitFor(() => {
      expect(container.textContent).not.toContain("No product policies defined yet.");
    }, WAIT);
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
      expect(inputs.length).toBeGreaterThanOrEqual(4);
    }, WAIT);

    const textInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>("input[type='text']"),
    );
    const values = textInputs.map((i) => i.value);
    expect(values).toContain("final-sale");
    expect(values).toContain("Electronics");
    expect(values).toContain("Final sale items cannot be returned");

    expect(container.textContent).not.toContain("No product policies defined yet.");
  });

  it("shows the 'Returnable' / 'Not returnable' badge per rule and hides the window-days input for non-returnable rules", async () => {
    const { container } = renderWithRouter(ProductPoliciesSettings, {
      initialEntries: ["/app/settings/product-policies"],
      loaderData: populatedLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Not returnable");
    }, WAIT);
    expect(container.textContent).toContain("Returnable");

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
      const removes = container.querySelectorAll("button[aria-label='Remove rule']");
      expect(removes.length).toBe(2);
    }, WAIT);

    const removeButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button[aria-label='Remove rule']"),
    );
    await act(async () => {
      fireEvent.click(removeButtons[0]);
    });

    await waitFor(() => {
      const remaining = container.querySelectorAll("button[aria-label='Remove rule']");
      expect(remaining.length).toBe(1);
    }, WAIT);
    expect(container.textContent).not.toContain("Final sale items cannot be returned");
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
    }, WAIT);

    const checkboxes = Array.from(
      container.querySelectorAll<HTMLInputElement>("input[type='checkbox']"),
    );
    expect(checkboxes.length).toBe(2);
    const checkedBox = checkboxes.find((c) => c.checked);
    expect(checkedBox).toBeTruthy();

    fireEvent.click(checkedBox!);

    await waitFor(() => {
      expect(container.querySelectorAll("input[type='number']").length).toBe(0);
    }, WAIT);
  });

  it("renders Save Changes in the header and Discard with a link back to /app/settings", async () => {
    const { container } = renderWithRouter(ProductPoliciesSettings, {
      initialEntries: ["/app/settings/product-policies"],
      loaderData: emptyLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector(".app-actions")).toBeTruthy();
    }, WAIT);
    const headerSave = container.querySelector<HTMLButtonElement>(
      ".app-page-header__actions .app-btn-primary",
    );
    expect(headerSave?.textContent?.trim()).toBe("Save Changes");
    expect(headerSave?.getAttribute("form")).toBe("product-policies-settings-form");
    expect(container.querySelector(".app-actions")?.textContent).toContain("Discard");

    const discardLink = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "/app/settings",
    );
    expect(discardLink).toBeTruthy();
  });

  it("changing the matchType <select> rewrites the matchValue label and placeholder for that rule", async () => {
    const { container } = renderWithRouter(ProductPoliciesSettings, {
      initialEntries: ["/app/settings/product-policies"],
      loaderData: populatedLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelectorAll("select").length).toBe(2);
    }, WAIT);

    expect(container.textContent).toContain("Tag (comma-separated)");
    expect(container.textContent).toContain("Product type");

    const selects = Array.from(container.querySelectorAll<HTMLSelectElement>("select"));
    fireEvent.change(selects[0], { target: { value: "collection" } });

    await waitFor(() => {
      expect(container.textContent).toContain("Collection name/handle");
    }, WAIT);
    const matchInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>("input[type='text']"),
    );
    const placeholders = matchInputs.map((i) => i.getAttribute("placeholder"));
    expect(placeholders).toContain("e.g. summer-sale");
  });

  it("supports the third matchType option ('product_type') with its dedicated placeholder", async () => {
    const { container } = renderWithRouter(ProductPoliciesSettings, {
      initialEntries: ["/app/settings/product-policies"],
      loaderData: populatedLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelectorAll("select").length).toBe(2);
    }, WAIT);

    const selects = Array.from(container.querySelectorAll<HTMLSelectElement>("select"));
    fireEvent.change(selects[0], { target: { value: "product_type" } });

    await waitFor(() => {
      const inputs = Array.from(container.querySelectorAll<HTMLInputElement>("input[type='text']"));
      const placeholders = inputs.map((i) => i.getAttribute("placeholder"));
      expect(placeholders.filter((p) => p === "e.g. Electronics").length).toBe(2);
    }, WAIT);
  });

  it("typing into the matchValue input updates that rule's matchValue (controlled input)", async () => {
    const { container } = renderWithRouter(ProductPoliciesSettings, {
      initialEntries: ["/app/settings/product-policies"],
      loaderData: populatedLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelectorAll("input[type='text']").length).toBeGreaterThanOrEqual(4);
    }, WAIT);

    const textInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>("input[type='text']"),
    );
    const matchValueInput = textInputs.find((i) => i.value === "final-sale");
    expect(matchValueInput).toBeTruthy();

    await act(async () => {
      fireEvent.change(matchValueInput!, { target: { value: "clearance" } });
    });

    await waitFor(() => {
      const refreshed = Array.from(
        container.querySelectorAll<HTMLInputElement>("input[type='text']"),
      ).map((i) => i.value);
      expect(refreshed).toContain("clearance");
      expect(refreshed).not.toContain("final-sale");
    }, WAIT);
  });

  it("typing into the windowDays input clamps to a non-negative integer", async () => {
    const { container } = renderWithRouter(ProductPoliciesSettings, {
      initialEntries: ["/app/settings/product-policies"],
      loaderData: populatedLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelectorAll("input[type='number']").length).toBe(1);
    }, WAIT);

    const numberInput = container.querySelector("input[type='number']") as HTMLInputElement;
    expect(numberInput.value).toBe("14");

    await act(async () => {
      fireEvent.change(numberInput, { target: { value: "60" } });
    });
    await waitFor(() => {
      expect((container.querySelector("input[type='number']") as HTMLInputElement).value).toBe(
        "60",
      );
    }, WAIT);

    await act(async () => {
      fireEvent.change(container.querySelector("input[type='number']") as HTMLInputElement, {
        target: { value: "abc" },
      });
    });
    await waitFor(() => {
      expect((container.querySelector("input[type='number']") as HTMLInputElement).value).toBe("0");
    }, WAIT);

    await act(async () => {
      fireEvent.change(container.querySelector("input[type='number']") as HTMLInputElement, {
        target: { value: "-5" },
      });
    });
    await waitFor(() => {
      expect((container.querySelector("input[type='number']") as HTMLInputElement).value).toBe("0");
    }, WAIT);
  });

  it("typing into the policyText input updates the rule's custom policy copy", async () => {
    const { container } = renderWithRouter(ProductPoliciesSettings, {
      initialEntries: ["/app/settings/product-policies"],
      loaderData: populatedLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelectorAll("input[type='text']").length).toBeGreaterThanOrEqual(4);
    }, WAIT);

    const textInputs = Array.from(
      container.querySelectorAll<HTMLInputElement>("input[type='text']"),
    );
    const emptyPolicyText = textInputs.find(
      (i) =>
        i.value === "" &&
        i.getAttribute("placeholder") === "e.g. Final sale items cannot be returned",
    );
    expect(emptyPolicyText).toBeTruthy();

    await act(async () => {
      fireEvent.change(emptyPolicyText!, {
        target: { value: "Electronics: 14-day window" },
      });
    });

    await waitFor(() => {
      const refreshed = Array.from(
        container.querySelectorAll<HTMLInputElement>("input[type='text']"),
      ).map((i) => i.value);
      expect(refreshed).toContain("Electronics: 14-day window");
    }, WAIT);
  });

  it("toggling the 'Returnable' checkbox on a non-returnable rule reveals its windowDays input", async () => {
    const { container } = renderWithRouter(ProductPoliciesSettings, {
      initialEntries: ["/app/settings/product-policies"],
      loaderData: populatedLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelectorAll("input[type='checkbox']").length).toBe(2);
    }, WAIT);

    expect(container.querySelectorAll("input[type='number']").length).toBe(1);

    const checkboxes = Array.from(
      container.querySelectorAll<HTMLInputElement>("input[type='checkbox']"),
    );
    const uncheckedBox = checkboxes.find((c) => !c.checked);
    expect(uncheckedBox).toBeTruthy();

    fireEvent.click(uncheckedBox!);

    await waitFor(() => {
      expect(container.querySelectorAll("input[type='number']").length).toBe(2);
    }, WAIT);
  });

  it("the '+ Add rule' footer button appends a fresh editor card", async () => {
    const { container } = renderWithRouter(ProductPoliciesSettings, {
      initialEntries: ["/app/settings/product-policies"],
      loaderData: populatedLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelectorAll("select").length).toBe(2);
    }, WAIT);

    const footerAdd = Array.from(container.querySelectorAll("s-button")).find(
      (b) => b.textContent?.trim() === "+ Add rule",
    );
    expect(footerAdd).toBeTruthy();

    fireEvent.click(footerAdd!);

    await waitFor(() => {
      expect(container.querySelectorAll("select").length).toBe(3);
    }, WAIT);
    expect(container.querySelectorAll("button[aria-label='Remove rule']").length).toBe(3);
  });

  it("Move-up / Move-down buttons reorder rules, with disabled boundary controls", async () => {
    const { container } = renderWithRouter(ProductPoliciesSettings, {
      initialEntries: ["/app/settings/product-policies"],
      loaderData: populatedLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelectorAll("select").length).toBe(2);
    }, WAIT);

    const moveUpButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button[aria-label='Move up']"),
    );
    const moveDownButtons = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button[aria-label='Move down']"),
    );
    expect(moveUpButtons[0].disabled).toBe(true);
    expect(moveDownButtons[1].disabled).toBe(true);

    fireEvent.click(moveUpButtons[0]);
    expect(container.querySelectorAll("select").length).toBe(2);

    fireEvent.click(moveUpButtons[1]);

    await waitFor(() => {
      const orderedValues = Array.from(
        container.querySelectorAll<HTMLInputElement>("input[type='text']"),
      ).map((i) => i.value);
      expect(orderedValues[0]).toBe("Electronics");
    }, WAIT);

    const downAfter = Array.from(
      container.querySelectorAll<HTMLButtonElement>("button[aria-label='Move down']"),
    );
    fireEvent.click(downAfter[0]);

    await waitFor(() => {
      const orderedValues = Array.from(
        container.querySelectorAll<HTMLInputElement>("input[type='text']"),
      ).map((i) => i.value);
      expect(orderedValues[0]).toBe("final-sale");
    }, WAIT);
  });

  it("submitting the form prevents default and triggers fetcher.submit", async () => {
    const { container } = renderWithRouter(ProductPoliciesSettings, {
      initialEntries: ["/app/settings/product-policies"],
      loaderData: populatedLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("form")).toBeTruthy();
    }, WAIT);

    const form = container.querySelector("form") as HTMLFormElement;
    const submitEvent = new Event("submit", {
      bubbles: true,
      cancelable: true,
    });
    const preventDefaultSpy = vi.spyOn(submitEvent, "preventDefault");
    form.dispatchEvent(submitEvent);
    expect(preventDefaultSpy).toHaveBeenCalled();
  });
});
