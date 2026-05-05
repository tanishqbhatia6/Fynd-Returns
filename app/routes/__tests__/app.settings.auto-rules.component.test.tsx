/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Mocks for module-top-level imports in app/routes/app.settings.auto-rules.tsx ──
// The component imports authenticate / prisma / lib helpers purely for its
// loader + action. Stub those modules so importing the component in jsdom
// doesn't crash on Node-only deps.
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

vi.mock("../lib/auto-approve.server", () => ({
  parseAutoApproveRules: vi.fn(() => []),
}));

// shopifyApp() is invoked when app/shopify.server.ts is evaluated — vitest
// still resolves nested deps in some cases. Provide a stub factory so the
// import never throws.
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
import AutoApproveRulesSettings from "../app.settings.auto-rules";

type LoaderData = {
  rules: Array<{
    field: string;
    operator: string;
    value: string;
    action: string;
  }>;
  autoApproveEnabled: boolean;
};

const emptyLoader: LoaderData = {
  rules: [],
  autoApproveEnabled: true,
};

const populatedLoader: LoaderData = {
  rules: [
    {
      field: "orderValue",
      operator: "lte",
      value: "50",
      action: "approve",
    },
    {
      field: "fraudRiskScore",
      operator: "gte",
      value: "80",
      action: "manual_review",
    },
  ],
  autoApproveEnabled: false,
};

describe("app.settings.auto-rules component (default export)", () => {
  it("renders the page heading 'Auto-Approve Rules'", async () => {
    const { container } = renderWithRouter(AutoApproveRulesSettings, {
      initialEntries: ["/app/settings/auto-rules"],
      loaderData: emptyLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Auto-Approve Rules");
    });
  });

  it("renders the empty-state message and rules count of 0 when no rules exist", async () => {
    const { container } = renderWithRouter(AutoApproveRulesSettings, {
      initialEntries: ["/app/settings/auto-rules"],
      loaderData: emptyLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Rules (0)");
    });
    expect(container.textContent).toContain("No rules configured");
  });

  it("does not show the disabled-warning banner when autoApproveEnabled is true", async () => {
    const { container } = renderWithRouter(AutoApproveRulesSettings, {
      initialEntries: ["/app/settings/auto-rules"],
      loaderData: emptyLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Auto-Approve Rules");
    });
    expect(container.textContent).not.toContain(
      "Auto-approve is currently disabled",
    );
  });

  it("shows the disabled-warning banner when autoApproveEnabled is false", async () => {
    const { container } = renderWithRouter(AutoApproveRulesSettings, {
      initialEntries: ["/app/settings/auto-rules"],
      loaderData: populatedLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain(
        "Auto-approve is currently disabled",
      );
    });
    const warningLink = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "/app/settings/return-settings",
    );
    expect(warningLink?.textContent).toMatch(/Return Settings/i);
  });

  it("renders one row per rule and reflects the rule count in the section header", async () => {
    const { container } = renderWithRouter(AutoApproveRulesSettings, {
      initialEntries: ["/app/settings/auto-rules"],
      loaderData: populatedLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Rules (2)");
    });
    // One Remove button per rule row
    const removeButtons = Array.from(
      container.querySelectorAll("button"),
    ).filter((b) => b.textContent?.trim() === "Remove");
    expect(removeButtons.length).toBe(2);
    // Each rule has 3 selects (field, operator, action)
    const selects = container.querySelectorAll("select");
    expect(selects.length).toBe(2 * 3);
  });

  it("populates select/input values from the loader rules", async () => {
    const { container } = renderWithRouter(AutoApproveRulesSettings, {
      initialEntries: ["/app/settings/auto-rules"],
      loaderData: populatedLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Rules (2)");
    });
    const selects = Array.from(
      container.querySelectorAll("select"),
    ) as HTMLSelectElement[];
    const inputs = Array.from(
      container.querySelectorAll("input"),
    ) as HTMLInputElement[];
    // First rule: orderValue / lte / approve
    expect(selects[0].value).toBe("orderValue");
    expect(selects[1].value).toBe("lte");
    expect(selects[2].value).toBe("approve");
    expect(inputs[0].value).toBe("50");
    // Second rule: fraudRiskScore / gte / manual_review
    expect(selects[3].value).toBe("fraudRiskScore");
    expect(selects[4].value).toBe("gte");
    expect(selects[5].value).toBe("manual_review");
    expect(inputs[1].value).toBe("80");
  });

  it("appends a new draft rule when the '+ Add rule' button is clicked", async () => {
    const { container } = renderWithRouter(AutoApproveRulesSettings, {
      initialEntries: ["/app/settings/auto-rules"],
      loaderData: emptyLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Rules (0)");
    });
    const addBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.includes("Add rule"),
    );
    expect(addBtn).toBeTruthy();
    fireEvent.click(addBtn!);
    await waitFor(() => {
      expect(container.textContent).toContain("Rules (1)");
    });
    expect(container.textContent).not.toContain("No rules configured");
  });

  it("removes a rule when its 'Remove' button is clicked", async () => {
    const { container } = renderWithRouter(AutoApproveRulesSettings, {
      initialEntries: ["/app/settings/auto-rules"],
      loaderData: populatedLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Rules (2)");
    });
    const removeButtons = Array.from(
      container.querySelectorAll("button"),
    ).filter((b) => b.textContent?.trim() === "Remove");
    fireEvent.click(removeButtons[0]);
    await waitFor(() => {
      expect(container.textContent).toContain("Rules (1)");
    });
  });

  it("renders the Rule preview section only when there are rules", async () => {
    const { container: emptyContainer } = renderWithRouter(
      AutoApproveRulesSettings,
      {
        initialEntries: ["/app/settings/auto-rules"],
        loaderData: emptyLoader,
      },
    );
    await waitFor(() => {
      expect(emptyContainer.textContent).toContain("Rules (0)");
    });
    expect(emptyContainer.textContent).not.toContain("Rule preview");

    const { container: populatedContainer } = renderWithRouter(
      AutoApproveRulesSettings,
      {
        initialEntries: ["/app/settings/auto-rules"],
        loaderData: populatedLoader,
      },
    );
    await waitFor(() => {
      expect(populatedContainer.textContent).toContain("Rule preview");
    });
    // "Otherwise:" footer reflects the autoApproveEnabled=false branch
    expect(populatedContainer.textContent).toContain(
      "submit for review (auto-approve disabled)",
    );
  });
});
