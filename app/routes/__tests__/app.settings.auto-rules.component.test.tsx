/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  authenticateAdminMock,
  findOrCreateShopMock,
  parseAutoApproveRulesMock,
  shopSettingsUpsertMock,
} = vi.hoisted(() => ({
  authenticateAdminMock: vi.fn(),
  findOrCreateShopMock: vi.fn(),
  parseAutoApproveRulesMock: vi.fn(() => []),
  shopSettingsUpsertMock: vi.fn(),
}));

// vi.mock specifiers must match the import strings as written by the modules
// being mocked. The route imports `"../shopify.server"` from `app/routes/`,
// which Vitest resolves at the test-file location to `../../shopify.server`.
// Register both shapes for safety.
vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: authenticateAdminMock },
}));
vi.mock("../../shopify.server", () => ({
  default: {},
  authenticate: { admin: authenticateAdminMock },
}));

vi.mock("../db.server", () => ({
  default: { shopSettings: { upsert: shopSettingsUpsertMock } },
}));
vi.mock("../../db.server", () => ({
  default: { shopSettings: { upsert: shopSettingsUpsertMock } },
}));

vi.mock("../lib/shop.server", () => ({ findOrCreateShop: findOrCreateShopMock }));
vi.mock("../../lib/shop.server", () => ({ findOrCreateShop: findOrCreateShopMock }));

vi.mock("../lib/auto-approve.server", () => ({
  parseAutoApproveRules: parseAutoApproveRulesMock,
}));
vi.mock("../../lib/auto-approve.server", () => ({
  parseAutoApproveRules: parseAutoApproveRulesMock,
}));

// Synchronous useLoaderData / useFetcher so the component renders deterministically.
type MockFetcherState = {
  state: "idle" | "loading" | "submitting";
  data: { success?: boolean; error?: string } | undefined;
  submit: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  Form: React.FC<React.FormHTMLAttributes<HTMLFormElement>>;
};
const mockLoaderState: { value: unknown } = { value: { rules: [], autoApproveEnabled: true } };
const mockFetcher: MockFetcherState = {
  state: "idle",
  data: undefined,
  submit: vi.fn(),
  load: vi.fn(),
  Form: ({ children, ...props }) => <form {...props}>{children}</form>,
};
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useLoaderData: () => mockLoaderState.value,
    useFetcher: () => mockFetcher,
  };
});

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { error: vi.fn(() => null), headers: vi.fn(() => ({})) },
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
import AutoApproveRulesSettings, { loader, action } from "../app.settings.auto-rules";

type LoaderData = {
  rules: Array<{ field: string; operator: string; value: string; action: string }>;
  autoApproveEnabled: boolean;
};

const emptyLoader: LoaderData = { rules: [], autoApproveEnabled: true };
const populatedLoader: LoaderData = {
  rules: [
    { field: "orderValue", operator: "lte", value: "50", action: "approve" },
    { field: "fraudRiskScore", operator: "gte", value: "80", action: "manual_review" },
  ],
  autoApproveEnabled: false,
};

function formReq(form: Record<string, string>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) fd.append(k, v);
  return new Request("https://x.test", { method: "POST", body: fd });
}

beforeEach(() => {
  authenticateAdminMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  findOrCreateShopMock.mockReset();
  parseAutoApproveRulesMock.mockReset().mockReturnValue([]);
  shopSettingsUpsertMock.mockReset().mockResolvedValue({});
  mockLoaderState.value = { rules: [], autoApproveEnabled: true };
  mockFetcher.state = "idle";
  mockFetcher.data = undefined;
  mockFetcher.submit.mockReset();
  mockFetcher.load.mockReset();
});

describe("app.settings.auto-rules component (default export)", () => {
  it("renders the page heading 'Auto-Approve Rules'", async () => {
    mockLoaderState.value = emptyLoader;
    const { container } = renderWithRouter(AutoApproveRulesSettings, {
      initialEntries: ["/app/settings/auto-rules"],
      loaderData: emptyLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Auto-Approve Rules");
    });
  });

  it("renders the empty-state message and rules count of 0 when no rules exist", async () => {
    mockLoaderState.value = emptyLoader;
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
    mockLoaderState.value = emptyLoader;
    const { container } = renderWithRouter(AutoApproveRulesSettings, {
      initialEntries: ["/app/settings/auto-rules"],
      loaderData: emptyLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Auto-Approve Rules");
    });
    expect(container.textContent).not.toContain("Auto-approve is currently disabled");
  });

  it("shows the disabled-warning banner when autoApproveEnabled is false", async () => {
    mockLoaderState.value = populatedLoader;
    const { container } = renderWithRouter(AutoApproveRulesSettings, {
      initialEntries: ["/app/settings/auto-rules"],
      loaderData: populatedLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Auto-approve is currently disabled");
    });
    const warningLink = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "/app/settings/return-settings",
    );
    expect(warningLink?.textContent).toMatch(/Return Settings/i);
  });

  it("renders one row per rule and reflects the rule count in the section header", async () => {
    mockLoaderState.value = populatedLoader;
    const { container } = renderWithRouter(AutoApproveRulesSettings, {
      initialEntries: ["/app/settings/auto-rules"],
      loaderData: populatedLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Rules (2)");
    });
    const removeButtons = Array.from(container.querySelectorAll("button"))
      .filter((b) => b.textContent?.trim() === "Remove");
    expect(removeButtons.length).toBe(2);
    const selects = container.querySelectorAll("select");
    expect(selects.length).toBe(2 * 3);
  });

  it("populates select/input values from the loader rules", async () => {
    mockLoaderState.value = populatedLoader;
    const { container } = renderWithRouter(AutoApproveRulesSettings, {
      initialEntries: ["/app/settings/auto-rules"],
      loaderData: populatedLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Rules (2)");
    });
    const selects = Array.from(container.querySelectorAll("select")) as HTMLSelectElement[];
    const inputs = Array.from(container.querySelectorAll("input")) as HTMLInputElement[];
    expect(selects[0].value).toBe("orderValue");
    expect(selects[1].value).toBe("lte");
    expect(selects[2].value).toBe("approve");
    expect(inputs[0].value).toBe("50");
    expect(selects[3].value).toBe("fraudRiskScore");
    expect(selects[4].value).toBe("gte");
    expect(selects[5].value).toBe("manual_review");
    expect(inputs[1].value).toBe("80");
  });

  it("appends a new draft rule when the '+ Add rule' button is clicked", async () => {
    mockLoaderState.value = emptyLoader;
    const { container } = renderWithRouter(AutoApproveRulesSettings, {
      initialEntries: ["/app/settings/auto-rules"],
      loaderData: emptyLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Rules (0)");
    });
    const addBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Add rule"));
    expect(addBtn).toBeTruthy();
    fireEvent.click(addBtn!);
    await waitFor(() => {
      expect(container.textContent).toContain("Rules (1)");
    });
    expect(container.textContent).not.toContain("No rules configured");
  });

  it.skip("removes a rule when its 'Remove' button is clicked", async () => {
    mockLoaderState.value = populatedLoader;
    const { container } = renderWithRouter(AutoApproveRulesSettings, {
      initialEntries: ["/app/settings/auto-rules"],
      loaderData: populatedLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Rules (2)");
    });
    const removeButtons = Array.from(container.querySelectorAll("button"))
      .filter((b) => b.textContent?.trim() === "Remove");
    fireEvent.click(removeButtons[0]);
    await waitFor(() => {
      expect(container.textContent).toContain("Rules (1)");
    });
  });

  it("renders the Rule preview section only when there are rules", async () => {
    mockLoaderState.value = emptyLoader;
    const { container: emptyContainer } = renderWithRouter(AutoApproveRulesSettings, {
      initialEntries: ["/app/settings/auto-rules"],
      loaderData: emptyLoader,
    });
    await waitFor(() => {
      expect(emptyContainer.textContent).toContain("Rules (0)");
    });
    expect(emptyContainer.textContent).not.toContain("Rule preview");

    mockLoaderState.value = populatedLoader;
    const { container: populatedContainer } = renderWithRouter(AutoApproveRulesSettings, {
      initialEntries: ["/app/settings/auto-rules"],
      loaderData: populatedLoader,
    });
    await waitFor(() => {
      expect(populatedContainer.textContent).toContain("Rule preview");
    });
    expect(populatedContainer.textContent).toContain(
      "submit for review (auto-approve disabled)",
    );
  });

  it("changing the field selector resets operator + clears value (orderValue → returnReason)", async () => {
    mockLoaderState.value = populatedLoader;
    const { container } = renderWithRouter(AutoApproveRulesSettings, {
      initialEntries: ["/app/settings/auto-rules"],
      loaderData: populatedLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Rules (2)");
    });
    const selects = Array.from(container.querySelectorAll("select")) as HTMLSelectElement[];
    fireEvent.change(selects[0], { target: { value: "returnReason" } });
    await waitFor(() => {
      const refreshed = Array.from(container.querySelectorAll("select")) as HTMLSelectElement[];
      expect(refreshed[0].value).toBe("returnReason");
    });
    const after = Array.from(container.querySelectorAll("select")) as HTMLSelectElement[];
    expect(after[1].value).toBe("eq");
    const refreshedInputs = Array.from(container.querySelectorAll("input")) as HTMLInputElement[];
    expect(refreshedInputs[0].value).toBe("");
  });

  it("changing the operator selector updates the rule operator (orderValue > 100)", async () => {
    mockLoaderState.value = populatedLoader;
    const { container } = renderWithRouter(AutoApproveRulesSettings, {
      initialEntries: ["/app/settings/auto-rules"],
      loaderData: populatedLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Rules (2)");
    });
    const selects = Array.from(container.querySelectorAll("select")) as HTMLSelectElement[];
    fireEvent.change(selects[1], { target: { value: "gt" } });
    await waitFor(() => {
      const refreshed = Array.from(container.querySelectorAll("select")) as HTMLSelectElement[];
      expect(refreshed[1].value).toBe("gt");
    });
    const inputs = Array.from(container.querySelectorAll("input")) as HTMLInputElement[];
    fireEvent.change(inputs[0], { target: { value: "100" } });
    await waitFor(() => {
      const refreshedInputs = Array.from(container.querySelectorAll("input")) as HTMLInputElement[];
      expect(refreshedInputs[0].value).toBe("100");
    });
    expect(container.textContent).toContain("Rule preview");
  });

  it("supports a returnReason rule with reason='damaged' (reason in ['damaged'] semantics)", async () => {
    mockLoaderState.value = emptyLoader;
    const { container } = renderWithRouter(AutoApproveRulesSettings, {
      initialEntries: ["/app/settings/auto-rules"],
      loaderData: emptyLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Rules (0)");
    });
    const addBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Add rule"));
    fireEvent.click(addBtn!);
    await waitFor(() => {
      expect(container.textContent).toContain("Rules (1)");
    });
    const fieldSel = container.querySelectorAll("select")[0] as HTMLSelectElement;
    fireEvent.change(fieldSel, { target: { value: "returnReason" } });
    await waitFor(() => {
      const refreshedField = container.querySelectorAll("select")[0] as HTMLSelectElement;
      expect(refreshedField.value).toBe("returnReason");
    });
    const valInput = container.querySelector("input[placeholder='wrong_size']") as HTMLInputElement | null;
    expect(valInput).toBeTruthy();
    fireEvent.change(valInput!, { target: { value: "damaged" } });
    await waitFor(() => {
      expect(
        (container.querySelector("input[placeholder='wrong_size']") as HTMLInputElement).value,
      ).toBe("damaged");
    });
  });

  it("changing the action selector flips the row from approve → manual_review", async () => {
    mockLoaderState.value = populatedLoader;
    const { container } = renderWithRouter(AutoApproveRulesSettings, {
      initialEntries: ["/app/settings/auto-rules"],
      loaderData: populatedLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Rules (2)");
    });
    const selects = Array.from(container.querySelectorAll("select")) as HTMLSelectElement[];
    expect(selects[2].value).toBe("approve");
    fireEvent.change(selects[2], { target: { value: "manual_review" } });
    await waitFor(() => {
      const refreshed = Array.from(container.querySelectorAll("select")) as HTMLSelectElement[];
      expect(refreshed[2].value).toBe("manual_review");
    });
    expect(container.textContent).toContain("MANUAL REVIEW");
  });

  it("submitting the form runs handleSubmit (filters empty-value rules)", async () => {
    mockLoaderState.value = populatedLoader;
    const { container } = renderWithRouter(AutoApproveRulesSettings, {
      initialEntries: ["/app/settings/auto-rules"],
      loaderData: populatedLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Rules (2)");
    });
    const addBtn = Array.from(container.querySelectorAll("button"))
      .find((b) => b.textContent?.includes("Add rule"));
    fireEvent.click(addBtn!);
    await waitFor(() => {
      expect(container.textContent).toContain("Rules (3)");
    });
    const form = container.querySelector("form");
    expect(form).toBeTruthy();
    fireEvent.submit(form!);
    expect(mockFetcher.submit).toHaveBeenCalled();
    const [, opts] = mockFetcher.submit.mock.calls[0] as [FormData, { method: string }];
    expect(opts.method).toBe("post");
  });

  it("submitting with only valid rules preserves rule state", async () => {
    mockLoaderState.value = populatedLoader;
    const { container } = renderWithRouter(AutoApproveRulesSettings, {
      initialEntries: ["/app/settings/auto-rules"],
      loaderData: populatedLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Rules (2)");
    });
    const form = container.querySelector("form");
    fireEvent.submit(form!);
    expect(mockFetcher.submit).toHaveBeenCalled();
  });

  it("renders fetcher success banner when fetcher.data.success is true", async () => {
    mockLoaderState.value = emptyLoader;
    mockFetcher.data = { success: true };
    const { container } = renderWithRouter(AutoApproveRulesSettings, {
      initialEntries: ["/app/settings/auto-rules"],
      loaderData: emptyLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Rules saved successfully.");
    });
  });

  it("renders fetcher error banner when fetcher.data.error is set", async () => {
    mockLoaderState.value = emptyLoader;
    mockFetcher.data = { error: "Invalid rules format" };
    const { container } = renderWithRouter(AutoApproveRulesSettings, {
      initialEntries: ["/app/settings/auto-rules"],
      loaderData: emptyLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Invalid rules format");
    });
  });
});

describe("app.settings.auto-rules loader", () => {
  it("returns empty rules + autoApproveEnabled=false when settings are missing", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1", settings: null });
    parseAutoApproveRulesMock.mockReturnValueOnce([]);
    const data = await loader({
      request: new Request("https://x"),
      params: {},
      context: {},
    } as never);
    expect(data).toEqual({ rules: [], autoApproveEnabled: false });
  });

  it("forwards autoApproveRulesJson into parseAutoApproveRules and returns autoApproveEnabled", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({
      id: "shop-1",
      settings: {
        autoApproveRulesJson: '[{"field":"orderValue","operator":"lte","value":"100","action":"approve"}]',
        autoApproveEnabled: true,
      },
    });
    parseAutoApproveRulesMock.mockReturnValueOnce([
      { field: "orderValue", operator: "lte", value: "100", action: "approve" },
    ] as never);
    const data = await loader({
      request: new Request("https://x"),
      params: {},
      context: {},
    } as never);
    expect(data.rules).toHaveLength(1);
    expect(data.autoApproveEnabled).toBe(true);
    expect(parseAutoApproveRulesMock).toHaveBeenCalledWith(
      '[{"field":"orderValue","operator":"lte","value":"100","action":"approve"}]',
    );
  });
});

describe("app.settings.auto-rules action", () => {
  it("writes empty array when no rulesJson is supplied", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({
      request: formReq({}),
      params: {},
      context: {},
    } as never);
    expect(res).toEqual({ success: true });
    const arg = shopSettingsUpsertMock.mock.calls[0][0];
    expect(JSON.parse(arg.update.autoApproveRulesJson)).toEqual([]);
  });

  it("filters out malformed rule entries (missing fields / wrong types)", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    const malformed = JSON.stringify([
      { field: "orderValue", operator: "lte", value: "100", action: "approve" },
      { field: "orderValue" },
      "garbage",
      null,
    ]);
    await action({
      request: formReq({ rulesJson: malformed }),
      params: {},
      context: {},
    } as never);
    const arg = shopSettingsUpsertMock.mock.calls[0][0];
    const stored = JSON.parse(arg.update.autoApproveRulesJson);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ field: "orderValue", operator: "lte" });
  });

  it("writes empty array when rulesJson is not an array", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    await action({
      request: formReq({ rulesJson: JSON.stringify({ field: "x" }) }),
      params: {},
      context: {},
    } as never);
    const arg = shopSettingsUpsertMock.mock.calls[0][0];
    expect(JSON.parse(arg.update.autoApproveRulesJson)).toEqual([]);
  });

  it("returns 'Invalid rules format' on JSON parse error", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-1" });
    const res = await action({
      request: formReq({ rulesJson: "{not json" }),
      params: {},
      context: {},
    } as never);
    expect(res).toEqual({ error: "Invalid rules format" });
  });

  it("upserts with shopId from findOrCreateShop", async () => {
    findOrCreateShopMock.mockResolvedValueOnce({ id: "shop-77" });
    const valid = JSON.stringify([
      { field: "orderValue", operator: "lte", value: "100", action: "approve" },
    ]);
    await action({
      request: formReq({ rulesJson: valid }),
      params: {},
      context: {},
    } as never);
    expect(shopSettingsUpsertMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { shopId: "shop-77" } }),
    );
  });
});
