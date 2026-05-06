/**
 * @vitest-environment jsdom
 *
 * Coverage tests for app/routes/app.returns.create.tsx — drives the wizard
 * through all 4 steps to exercise the bulk of the previously uncovered
 * branches (lines 4-695 + 795-1563): order picker, line-item selection,
 * qty/reason/condition controls, multi-shipment grouping, customer & CRM
 * forms, resolution radio, override checkbox, review screen, and submit
 * flow with success redirect.
 *
 * useFetcher is partially mocked at the react-router level so we can
 * synchronously inject `data` into orderFetcher / submitFetcher and walk
 * the component through every state without spinning up an MSW server.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Source-level dep mocks ──
vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
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


// ── Mutable fetcher state — driven by per-test setup ──
// The component calls useFetcher() twice per render (orderFetcher first,
// submitFetcher second). We track call index modulo 2 and return shared
// state objects whose `data` / `state` fields are mutated in tests.
const orderFetcherShared = {
  state: "idle" as "idle" | "loading" | "submitting",
  data: undefined as unknown,
  load: vi.fn(),
  submit: vi.fn(),
  Form: (props: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, props.children),
};

const submitFetcherShared = {
  state: "idle" as "idle" | "loading" | "submitting",
  data: undefined as unknown,
  load: vi.fn(),
  submit: vi.fn(),
  Form: (props: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, props.children),
};

const navigateMock = vi.fn();

let useFetcherCalls = 0;

vi.mock("react-router", async () => {
  const actual =
    await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useFetcher: () => {
      const fetcher =
        useFetcherCalls % 2 === 0 ? orderFetcherShared : submitFetcherShared;
      useFetcherCalls += 1;
      return fetcher;
    },
    // Override useNavigate so the success-redirect useEffect can be asserted.
    useNavigate: () => navigateMock,
  };
});

import { renderWithRouter } from "../../test/component-helpers";
import { waitFor, fireEvent, act } from "@testing-library/react";
import CreateReturn from "../app.returns.create";

const baseLoaderData = { shopDomain: "test-shop.myshopify.com" };

// ── Helpers ──
function resetFetcherMocks() {
  useFetcherCalls = 0;
  orderFetcherShared.state = "idle";
  orderFetcherShared.data = undefined;
  orderFetcherShared.load.mockReset();
  orderFetcherShared.submit.mockReset();
  submitFetcherShared.state = "idle";
  submitFetcherShared.data = undefined;
  submitFetcherShared.load.mockReset();
  submitFetcherShared.submit.mockReset();
  navigateMock.mockReset();
}

const sampleOrder = {
  id: "gid://shopify/Order/1",
  name: "#1042",
  createdAt: "2026-01-01T00:00:00Z",
  email: "buyer@example.com",
  phone: "+15551234567",
  currencyCode: "USD",
  shippingAddress: {
    firstName: "Jane",
    lastName: "Doe",
    address1: "1 Test St",
    address2: "Apt 2",
    city: "Testville",
    province: "CA",
    zip: "90210",
    country: "US",
    landmark: "Near park",
  },
  lineItems: [
    {
      id: "li-1",
      title: "Test T-Shirt",
      variantTitle: "Medium",
      sku: "TS-M-001",
      quantity: 3,
      price: "29.99",
      imageUrl: "https://example.com/img.png",
    },
    {
      id: "li-2",
      title: "Test Hoodie",
      variantTitle: null,
      sku: null,
      quantity: 1,
      price: { amount: 49.5 },
      imageUrl: null,
    },
  ],
};

const multiShipmentData = [
  {
    shipmentId: "ship-1",
    shipmentStatus: "delivered_to_customer",
    eligible: true,
    items: [
      {
        id: "li-3",
        title: "Item A",
        variantTitle: "Red",
        sku: "A-1",
        quantity: 2,
        price: "10.00",
        imageUrl: null,
        bagId: "bag-A",
        fyndArticleId: "art-A",
        fyndAffiliateLineId: "aff-A",
        fyndSellerIdentifier: "sel-A",
        fyndItemId: "item-A",
        fyndQuantityAvailable: 2,
        fyndPriceEffective: "10.00",
        fyndSize: "M",
      },
    ],
  },
  {
    shipmentId: "ship-2",
    shipmentStatus: "in_transit",
    eligible: false,
    items: [
      {
        id: "li-4",
        title: "Item B",
        variantTitle: null,
        sku: "B-1",
        quantity: 1,
        price: "20.00",
        imageUrl: null,
      },
    ],
  },
];

/**
 * Mount the component, waiting for step 1 to render.
 */
async function mount() {
  const result = renderWithRouter(CreateReturn, {
    initialEntries: ["/app/returns/create"],
    loaderData: baseLoaderData,
  });
  await waitFor(
    () => {
      expect(result.container.textContent).toContain("Look up Order");
    },
    { timeout: 5000 },
  );
  return result;
}

/**
 * Mount the component WITH order data already populated on the orderFetcher
 * mock. The component's auto-advance useEffect transitions to step 2 on
 * first commit — at which point we wait for the step 2 markup to appear.
 *
 * We pre-populate `orderFetcherShared.data` before mounting because
 * useFetcher returns the same shared object on every render.
 */
async function mountWithOrder(
  data: { order?: unknown; shipments?: unknown; error?: string } = {
    order: sampleOrder,
  },
) {
  orderFetcherShared.data = data;
  const result = renderWithRouter(CreateReturn, {
    initialEntries: ["/app/returns/create"],
    loaderData: baseLoaderData,
  });
  await waitFor(
    () => {
      expect(result.container.textContent).toContain(
        "Select Items to Return",
      );
    },
    { timeout: 5000 },
  );
  return result;
}

beforeEach(() => {
  resetFetcherMocks();
});

describe("app.returns.create — step 1 lookup", () => {
  it("triggers fetcher.load with trimmed order number when search is clicked", async () => {
    const result = await mount();
    const input = result.container.querySelector(
      'input[placeholder="e.g. 1042, #1042"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  #1042  " } });
    const buttons = Array.from(result.container.querySelectorAll("button"));
    const searchBtn = buttons.find((b) =>
      /Search/i.test(b.textContent || ""),
    ) as HTMLButtonElement;
    await act(async () => { fireEvent.click(searchBtn); });
    await waitFor(() => {
      expect(orderFetcherShared.load).toHaveBeenCalledWith(
        expect.stringContaining("orderNumber=1042"),
      );
    });
  });

  it("submits search via Enter key", async () => {
    const result = await mount();
    const input = result.container.querySelector(
      'input[placeholder="e.g. 1042, #1042"]',
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1042" } });
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    await waitFor(() => { expect(orderFetcherShared.load).toHaveBeenCalled(); });
  });

  it("shows order error from fetcher.data.error", async () => {
    orderFetcherShared.data = { error: "Order not found" };
    const result = await mount();
    expect(result.container.textContent).toContain("Order not found");
  });

  it("disables search button while loading and shows spinner", async () => {
    orderFetcherShared.state = "loading";
    const result = await mount();
    const buttons = Array.from(result.container.querySelectorAll("button"));
    const searchBtn = buttons.find((b) =>
      /Searching/i.test(b.textContent || ""),
    ) as HTMLButtonElement;
    expect(searchBtn.disabled).toBe(true);
  });
});

describe("app.returns.create — step 2 item selection (single shipment)", () => {
  it("auto-advances to step 2 when orderData arrives, prefills customer fields", async () => {
    const result = await mountWithOrder();
    await waitFor(() => {
      expect(result.container.textContent).toContain("Select Items to Return");
    });
    expect(result.container.textContent).toContain("#1042");
    // Customer email pre-filled in state — visible after we navigate to step 3
  });

  it("toggles a line item, edits qty/reason/condition/notes, and validates next", async () => {
    const result = await mountWithOrder();
    await waitFor(() => {
      expect(result.container.textContent).toContain("Select Items to Return");
    });

    // Click the first line-item checkbox
    const checkboxes = result.container.querySelectorAll(
      'input[type="checkbox"]',
    );
    expect(checkboxes.length).toBeGreaterThan(0);
    fireEvent.click(checkboxes[0]);

    // Now expanded — qty/reason/condition + notes appear
    await waitFor(() => {
      const numInput = result.container.querySelector(
        'input[type="number"]',
      ) as HTMLInputElement;
      expect(numInput).toBeTruthy();
    });

    // Change qty (try out-of-range to exercise clamp)
    const qtyInput = result.container.querySelector(
      'input[type="number"]',
    ) as HTMLInputElement;
    fireEvent.change(qtyInput, { target: { value: "99" } });
    fireEvent.change(qtyInput, { target: { value: "0" } });
    fireEvent.change(qtyInput, { target: { value: "2" } });

    // Set reason + condition
    const selects = result.container.querySelectorAll("select");
    expect(selects.length).toBeGreaterThanOrEqual(2);
    fireEvent.change(selects[0], { target: { value: "size_issue" } });
    fireEvent.change(selects[1], { target: { value: "new_with_tags" } });

    // Notes input (text input, not number — pick the last text input in the row)
    const notesInputs = result.container.querySelectorAll(
      'input[type="text"]',
    );
    if (notesInputs.length > 0) {
      fireEvent.change(notesInputs[notesInputs.length - 1], {
        target: { value: "Doesn't fit" },
      });
    }

    // Click Next → should advance to step 3
    const buttons = Array.from(result.container.querySelectorAll("button"));
    const nextBtn = buttons.find(
      (b) => b.textContent?.trim() === "Next",
    ) as HTMLButtonElement;
    fireEvent.click(nextBtn);

    await waitFor(() => {
      expect(result.container.textContent).toContain("Customer Information");
    });
  });

  it("shows validation error when no items are selected", async () => {
    const result = await mountWithOrder();
    await waitFor(() => {
      expect(result.container.textContent).toContain("Select Items to Return");
    });
    const buttons = Array.from(result.container.querySelectorAll("button"));
    const nextBtn = buttons.find(
      (b) => b.textContent?.trim() === "Next",
    ) as HTMLButtonElement;
    fireEvent.click(nextBtn);
    await waitFor(() => {
      expect(result.container.textContent).toContain(
        "Please select at least one item to return.",
      );
    });
  });

  it("shows validation error when reason is missing on a selected item", async () => {
    const result = await mountWithOrder();
    const checkboxes = result.container.querySelectorAll(
      'input[type="checkbox"]',
    );
    fireEvent.click(checkboxes[0]);
    const buttons = Array.from(result.container.querySelectorAll("button"));
    const nextBtn = buttons.find(
      (b) => b.textContent?.trim() === "Next",
    ) as HTMLButtonElement;
    fireEvent.click(nextBtn);
    await waitFor(() => {
      expect(result.container.textContent).toContain(
        "Please select a return reason",
      );
    });
  });

  it("shows validation error when condition is missing", async () => {
    const result = await mountWithOrder();
    const checkboxes = result.container.querySelectorAll(
      'input[type="checkbox"]',
    );
    fireEvent.click(checkboxes[0]);
    const selects = result.container.querySelectorAll("select");
    fireEvent.change(selects[0], { target: { value: "size_issue" } });
    const buttons = Array.from(result.container.querySelectorAll("button"));
    const nextBtn = buttons.find(
      (b) => b.textContent?.trim() === "Next",
    ) as HTMLButtonElement;
    fireEvent.click(nextBtn);
    await waitFor(() => {
      expect(result.container.textContent).toContain(
        "Please select the item condition",
      );
    });
  });

  it("Change Order button returns to step 1", async () => {
    const result = await mountWithOrder();
    await waitFor(() => {
      expect(result.container.textContent).toContain("Select Items to Return");
    });
    const buttons = Array.from(result.container.querySelectorAll("button"));
    const changeBtn = buttons.find((b) =>
      /Change Order/i.test(b.textContent || ""),
    ) as HTMLButtonElement;
    fireEvent.click(changeBtn);
    await waitFor(() => {
      expect(result.container.textContent).toContain("Look up Order");
    });
  });

  it("toggling a checked item removes it from selection", async () => {
    const result = await mountWithOrder();
    const checkboxes = result.container.querySelectorAll(
      'input[type="checkbox"]',
    );
    fireEvent.click(checkboxes[0]);
    await waitFor(() => {
      expect(result.container.textContent).toContain("1 item selected");
    });
    fireEvent.click(checkboxes[0]);
    await waitFor(() => {
      expect(result.container.textContent).toContain("0 items selected");
    });
  });

  it("Back button on step 2 returns to step 1", async () => {
    const result = await mountWithOrder();
    await waitFor(() => {
      expect(result.container.textContent).toContain("Select Items to Return");
    });
    const buttons = Array.from(result.container.querySelectorAll("button"));
    const backBtn = buttons.find(
      (b) => b.textContent?.trim() === "Back",
    ) as HTMLButtonElement;
    fireEvent.click(backBtn);
    await waitFor(() => {
      expect(result.container.textContent).toContain("Look up Order");
    });
  });
});

describe("app.returns.create — step 2 multi-shipment branch", () => {
  it("renders shipment headers and supports selection from eligible shipment", async () => {
    const result = await mountWithOrder({
      order: { ...sampleOrder, lineItems: [] },
      shipments: multiShipmentData,
    });
    await waitFor(() => {
      expect(result.container.textContent).toContain("Shipment 1");
    });
    expect(result.container.textContent).toContain("Shipment 2");
    expect(result.container.textContent).toContain("Eligible for Return");
    expect(result.container.textContent).toContain("Not Eligible");
    expect(result.container.textContent).toContain("Delivered To Customer");

    // Select item from eligible shipment 1
    const checkboxes = result.container.querySelectorAll(
      'input[type="checkbox"]',
    );
    // First checkbox corresponds to li-3 (eligible). Item from ineligible
    // shipment should be disabled.
    const enabled = Array.from(checkboxes).find(
      (cb) => !(cb as HTMLInputElement).disabled,
    ) as HTMLInputElement;
    expect(enabled).toBeTruthy();
    fireEvent.click(enabled);
    await waitFor(() => {
      expect(result.container.textContent).toContain("1 item selected");
    });
  });
});

describe("app.returns.create — step 3 customer & CRM", () => {
  async function advanceToStep3(result: ReturnType<typeof renderWithRouter>) {
    const checkboxes = result.container.querySelectorAll(
      'input[type="checkbox"]',
    );
    fireEvent.click(checkboxes[0]);
    const selects = result.container.querySelectorAll("select");
    fireEvent.change(selects[0], { target: { value: "size_issue" } });
    fireEvent.change(selects[1], { target: { value: "new_with_tags" } });
    const buttons = Array.from(result.container.querySelectorAll("button"));
    const nextBtn = buttons.find(
      (b) => b.textContent?.trim() === "Next",
    ) as HTMLButtonElement;
    fireEvent.click(nextBtn);
    await waitFor(() => {
      expect(result.container.textContent).toContain("Customer Information");
    });
  }

  it("renders customer form with prefilled data", async () => {
    const result = await mountWithOrder();
    await advanceToStep3(result);
    const emailInput = result.container.querySelector(
      'input[type="email"]',
    ) as HTMLInputElement;
    expect(emailInput.value).toBe("buyer@example.com");
  });

  it("edits all customer fields, CRM fields, resolution, and exchange preference", async () => {
    const result = await mountWithOrder();
    await advanceToStep3(result);

    // Edit name (first text input on step 3)
    const textInputs = result.container.querySelectorAll(
      'input[type="text"]',
    );
    if (textInputs[0]) {
      fireEvent.change(textInputs[0], { target: { value: "Jane Updated" } });
    }
    // Phone
    const phoneInput = result.container.querySelector(
      'input[type="tel"]',
    ) as HTMLInputElement;
    fireEvent.change(phoneInput, { target: { value: "+15550000000" } });
    // Email
    const emailInput = result.container.querySelector(
      'input[type="email"]',
    ) as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: "new@example.com" } });

    // Modify several other text fields
    for (let i = 1; i < Math.min(textInputs.length, 8); i++) {
      fireEvent.change(textInputs[i], {
        target: { value: `field-${i}` },
      });
    }

    // Click "Exchange" radio (label-based)
    const labels = Array.from(result.container.querySelectorAll("label"));
    const exchangeLabel = labels.find((l) =>
      /^Exchange$/i.test(l.textContent?.trim() || ""),
    ) as HTMLLabelElement;
    if (exchangeLabel) {
      fireEvent.click(
        exchangeLabel.querySelector('input[type="radio"]') as HTMLInputElement,
      );
    }

    // Exchange preference textarea now appears
    await waitFor(() => {
      const ta = result.container.querySelectorAll("textarea");
      expect(ta.length).toBeGreaterThanOrEqual(2);
    });

    // Toggle override checkbox
    const allCheckboxes = result.container.querySelectorAll(
      'input[type="checkbox"]',
    );
    const overrideCb = allCheckboxes[allCheckboxes.length - 1] as HTMLInputElement;
    await act(async () => { fireEvent.click(overrideCb); });
    await waitFor(() => { expect(overrideCb.checked).toBe(true); });

    // Edit textareas (CRM notes + exchange pref)
    const tas = result.container.querySelectorAll("textarea");
    fireEvent.change(tas[0], { target: { value: "internal notes" } });
    if (tas[1]) {
      fireEvent.change(tas[1], { target: { value: "want red size L" } });
    }

    // Try the other resolution types to flip styles
    const refundLabel = labels.find((l) =>
      /^Refund$/i.test(l.textContent?.trim() || ""),
    ) as HTMLLabelElement;
    if (refundLabel) {
      fireEvent.click(
        refundLabel.querySelector('input[type="radio"]') as HTMLInputElement,
      );
    }
    const storeCreditLabel = labels.find((l) =>
      /^Store Credit$/i.test(l.textContent?.trim() || ""),
    ) as HTMLLabelElement;
    if (storeCreditLabel) {
      fireEvent.click(
        storeCreditLabel.querySelector(
          'input[type="radio"]',
        ) as HTMLInputElement,
      );
    }
    const replaceLabel = labels.find((l) =>
      /^Replacement$/i.test(l.textContent?.trim() || ""),
    ) as HTMLLabelElement;
    if (replaceLabel) {
      fireEvent.click(
        replaceLabel.querySelector('input[type="radio"]') as HTMLInputElement,
      );
    }

    // Pop back to step 2 then forward again
    const buttons = Array.from(result.container.querySelectorAll("button"));
    const backBtn = buttons.find(
      (b) => b.textContent?.trim() === "Back",
    ) as HTMLButtonElement;
    fireEvent.click(backBtn);
    await waitFor(() => {
      expect(result.container.textContent).toContain("Select Items to Return");
    });
  });

  it("blocks Review when email is empty", async () => {
    const result = await mountWithOrder();
    await advanceToStep3(result);
    const emailInput = result.container.querySelector(
      'input[type="email"]',
    ) as HTMLInputElement;
    fireEvent.change(emailInput, { target: { value: "" } });
    const buttons = Array.from(result.container.querySelectorAll("button"));
    const reviewBtn = buttons.find(
      (b) => b.textContent?.trim() === "Review",
    ) as HTMLButtonElement;
    fireEvent.click(reviewBtn);
    await waitFor(() => {
      expect(result.container.textContent).toContain(
        "Customer email is required.",
      );
    });
  });

  it("advances to step 4 review page when valid", async () => {
    const result = await mountWithOrder();
    await advanceToStep3(result);
    const buttons = Array.from(result.container.querySelectorAll("button"));
    const reviewBtn = buttons.find(
      (b) => b.textContent?.trim() === "Review",
    ) as HTMLButtonElement;
    fireEvent.click(reviewBtn);
    await waitFor(() => {
      expect(result.container.textContent).toContain("Return Items");
    });
    expect(result.container.textContent).toContain("Estimated Refund:");
  });
});

describe("app.returns.create — step 4 review & submit", () => {
  async function advanceToStep4(result: ReturnType<typeof renderWithRouter>) {
    // Select item 0 + item 1 (item 1 has null variantTitle/sku)
    const checkboxes = result.container.querySelectorAll(
      'input[type="checkbox"]',
    );
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
    const allSelects = result.container.querySelectorAll("select");
    // Two reason selects + two condition selects (ordered per item)
    fireEvent.change(allSelects[0], { target: { value: "size_issue" } });
    fireEvent.change(allSelects[1], { target: { value: "new_with_tags" } });
    fireEvent.change(allSelects[2], { target: { value: "damaged" } });
    fireEvent.change(allSelects[3], { target: { value: "used_fair" } });
    const step2Buttons = Array.from(
      result.container.querySelectorAll("button"),
    );
    const nextBtn = step2Buttons.find(
      (b) => b.textContent?.trim() === "Next",
    ) as HTMLButtonElement;
    fireEvent.click(nextBtn);
    await waitFor(() => {
      expect(result.container.textContent).toContain("Customer Information");
    });

    // Set crm ticket + notes so the optional review rows render
    const textInputs = result.container.querySelectorAll(
      'input[type="text"]',
    );
    // CRM Ticket field is later in the form; just hit a couple
    if (textInputs.length > 0) {
      fireEvent.change(
        textInputs[textInputs.length - 2] || textInputs[0],
        { target: { value: "TICK-99" } },
      );
    }
    const tas = result.container.querySelectorAll("textarea");
    if (tas[0]) {
      fireEvent.change(tas[0], { target: { value: "Some CRM notes" } });
    }

    // Toggle override
    const allCb = result.container.querySelectorAll('input[type="checkbox"]');
    const overrideCb = allCb[allCb.length - 1] as HTMLInputElement;
    fireEvent.click(overrideCb);

    // Pick exchange to render exchange preference
    const labels = Array.from(result.container.querySelectorAll("label"));
    const exchangeLabel = labels.find((l) =>
      /^Exchange$/i.test(l.textContent?.trim() || ""),
    ) as HTMLLabelElement;
    if (exchangeLabel) {
      fireEvent.click(
        exchangeLabel.querySelector('input[type="radio"]') as HTMLInputElement,
      );
    }
    const tas2 = result.container.querySelectorAll("textarea");
    if (tas2[1]) {
      fireEvent.change(tas2[1], { target: { value: "size L" } });
    }

    const buttons = Array.from(result.container.querySelectorAll("button"));
    const reviewBtn = buttons.find(
      (b) => b.textContent?.trim() === "Review",
    ) as HTMLButtonElement;
    fireEvent.click(reviewBtn);
    await waitFor(() => {
      expect(result.container.textContent).toContain("Return Items");
    });
  }

  it("renders review page summarising items, customer, CRM, and total", async () => {
    const result = await mountWithOrder();
    await advanceToStep4(result);
    expect(result.container.textContent).toContain("Estimated Refund:");
    expect(result.container.textContent).toContain("Customer Information");
    expect(result.container.textContent).toContain("CRM & Resolution");
    expect(result.container.textContent).toContain(
      "Eligibility gates will be overridden",
    );
  });

  it("submit fires submitFetcher.submit with serialised body", async () => {
    const result = await mountWithOrder();
    await advanceToStep4(result);
    const buttons = Array.from(result.container.querySelectorAll("button"));
    const submitBtn = buttons.find((b) =>
      /Submit Return/i.test(b.textContent || ""),
    ) as HTMLButtonElement;
    await act(async () => { fireEvent.click(submitBtn); });
    await waitFor(() => { expect(submitFetcherShared.submit).toHaveBeenCalled(); });
    const [body, opts] = submitFetcherShared.submit.mock.calls[0];
    expect(typeof body).toBe("string");
    const parsed = JSON.parse(body as string);
    expect(parsed.shopifyOrderName).toBe("#1042");
    expect(parsed.items.length).toBeGreaterThan(0);
    expect(opts).toEqual(
      expect.objectContaining({
        method: "POST",
        action: "/api/admin/create-return",
        encType: "application/json",
      }),
    );
  });

  it("Back from step 4 returns to step 3", async () => {
    const result = await mountWithOrder();
    await advanceToStep4(result);
    const buttons = Array.from(result.container.querySelectorAll("button"));
    const backBtn = buttons.find(
      (b) => b.textContent?.trim() === "Back",
    ) as HTMLButtonElement;
    fireEvent.click(backBtn);
    await waitFor(() => {
      expect(result.container.textContent).toContain(
        "CRM & Resolution Details",
      );
    });
  });

  it("renders submitting spinner and disables submit when fetcher state is submitting", async () => {
    submitFetcherShared.state = "submitting";
    const result = await mountWithOrder();
    await advanceToStep4(result);
    const buttons = Array.from(result.container.querySelectorAll("button"));
    const submitBtn = buttons.find((b) =>
      /Submitting/i.test(b.textContent || ""),
    ) as HTMLButtonElement;
    expect(submitBtn).toBeTruthy();
    expect(submitBtn.disabled).toBe(true);
  });

  it("renders submit error from fetcher data", async () => {
    submitFetcherShared.data = { success: false, error: "Submit failed!" };
    const result = await mountWithOrder();
    await advanceToStep4(result);
    expect(result.container.textContent).toContain("Submit failed!");
  });

  it("redirects via navigate when submit succeeds", async () => {
    submitFetcherShared.data = {
      success: true,
      returnCase: { id: "ret-success-1" },
    };
    const result = await mountWithOrder();
    await advanceToStep4(result);
    await waitFor(() => {
      expect(navigateMock).toHaveBeenCalledWith("/app/returns/ret-success-1");
    });
  });
});

describe("app.returns.create — safeCurrencyCode / safePrice helpers via render", () => {
  it("handles object-shaped currencyCode and price gracefully", async () => {
    const result = await mountWithOrder({
      order: {
        ...sampleOrder,
        currencyCode: { currency_code: "EUR" },
        lineItems: [
          {
            ...sampleOrder.lineItems[0],
            price: { amount: 12.5 },
          },
          {
            ...sampleOrder.lineItems[1],
            price: { value: "8.00" },
          },
        ],
      },
    });
    expect(result.container.textContent).toContain("EUR");
  });

  it("handles missing shipping address (null) without crashing", async () => {
    const result = await mountWithOrder({
      order: {
        ...sampleOrder,
        shippingAddress: null,
        email: null,
        phone: null,
      },
    });
    expect(result.container.textContent).toContain("Select Items to Return");
  });
});
