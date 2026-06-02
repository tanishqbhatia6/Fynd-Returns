/**
 * @vitest-environment jsdom
 *
 * Gap-coverage tests for app/routes/app.returns.create.tsx.
 *
 * Targets branches not covered by app.returns.create.uncovered.test.tsx:
 *  - Multi-shipment Condition <select> onChange (line 990)
 *  - Multi-shipment Notes <textarea> onChange (line 997)
 *  - Agent Name <input> onChange (line 1286)
 *  - Validation paths inside multi-shipment flow (qty, reason, condition)
 *  - Step 1 "please enter an order number" empty-trim branch
 *  - Loader-data branch with order containing only "#" prefix orderInput
 *
 * Strategy mirrors the existing uncovered test: stub useFetcher with two
 * shared shells (orderFetcher, submitFetcher), seed data before mount,
 * navigate the wizard, and dispatch DOM events.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

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
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useFetcher: () => {
      const fetcher = useFetcherCalls % 2 === 0 ? orderFetcherShared : submitFetcherShared;
      useFetcherCalls += 1;
      return fetcher;
    },
    useNavigate: () => navigateMock,
  };
});

import { renderWithRouter } from "../../test/component-helpers";
import { waitFor, fireEvent, act } from "@testing-library/react";
import CreateReturn, { loader } from "../app.returns.create";
import { authenticate } from "../../shopify.server";

const baseLoaderData = { shopDomain: "test-shop.myshopify.com" };

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
  id: "gid://shopify/Order/2",
  name: "#2042",
  createdAt: "2026-02-01T00:00:00Z",
  email: "gap@example.com",
  phone: "+15559998888",
  currencyCode: "USD",
  shippingAddress: {
    firstName: "Gap",
    lastName: "Tester",
    address1: "10 Cover St",
    address2: "",
    city: "Cov City",
    province: "NY",
    zip: "10001",
    country: "US",
    landmark: "",
  },
  lineItems: [
    {
      id: "gap-li-1",
      title: "Gap Shirt",
      variantTitle: "L",
      sku: "GS-L",
      quantity: 2,
      price: "15.00",
      imageUrl: "https://example.com/g.png",
    },
  ],
};

const multiShipments = [
  {
    shipmentId: "gship-1",
    shipmentStatus: "delivered_to_customer",
    eligible: true,
    items: [
      {
        id: "gap-ms-1",
        title: "Multi Item One",
        variantTitle: "Blue",
        sku: "MI-1",
        quantity: 4,
        price: "12.00",
        imageUrl: null,
        bagId: "bag-1",
        fyndArticleId: "art-1",
        fyndAffiliateLineId: "aff-1",
        fyndSellerIdentifier: "sel-1",
        fyndItemId: "item-1",
        fyndQuantityAvailable: 4,
        fyndPriceEffective: "12.00",
        fyndSize: "L",
      },
    ],
  },
  {
    shipmentId: "gship-2",
    shipmentStatus: "delivered_to_customer",
    eligible: true,
    items: [
      {
        id: "gap-ms-2",
        title: "Multi Item Two",
        variantTitle: "Red",
        sku: "MI-2",
        quantity: 1,
        price: "8.00",
        imageUrl: null,
      },
    ],
  },
];

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

async function mountWithOrder(
  data: {
    order?: unknown;
    shipments?: unknown;
    error?: string;
    shipmentReturnedQtyMap?: Record<string, Record<string, number>>;
  } = {
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
      expect(result.container.textContent).toContain("Select Items to Return");
    },
    { timeout: 5000 },
  );
  return result;
}

beforeEach(() => {
  resetFetcherMocks();
});

describe("app.returns.create — gap coverage", () => {
  it("shows 'Please enter an order number' when search clicked with empty input", async () => {
    const result = await mount();
    const buttons = Array.from(result.container.querySelectorAll("button"));
    const searchBtn = buttons.find((b) => /Search/i.test(b.textContent || "")) as HTMLButtonElement;
    fireEvent.click(searchBtn);
    await waitFor(() => {
      expect(result.container.textContent).toContain("Please enter an order number.");
    });
    expect(orderFetcherShared.load).not.toHaveBeenCalled();
  });

  it("shows validation error when order input is whitespace+# only", async () => {
    const result = await mount();
    const input = result.container.querySelector(
      'input[placeholder="e.g. 1042, #1042"]',
    ) as HTMLInputElement;
    // Trim+strip leading "#" → empty → triggers same branch
    fireEvent.change(input, { target: { value: "  #  " } });
    const buttons = Array.from(result.container.querySelectorAll("button"));
    const searchBtn = buttons.find((b) => /Search/i.test(b.textContent || "")) as HTMLButtonElement;
    fireEvent.click(searchBtn);
    await waitFor(() => {
      expect(result.container.textContent).toContain("Please enter an order number.");
    });
  });

  it("clears validation error when user resumes typing in step 1 input", async () => {
    const result = await mount();
    const input = result.container.querySelector(
      'input[placeholder="e.g. 1042, #1042"]',
    ) as HTMLInputElement;
    const buttons = Array.from(result.container.querySelectorAll("button"));
    const searchBtn = buttons.find((b) => /Search/i.test(b.textContent || "")) as HTMLButtonElement;
    fireEvent.click(searchBtn);
    await waitFor(() => {
      expect(result.container.textContent).toContain("Please enter an order number.");
    });
    // Typing should clear the validation error
    fireEvent.change(input, { target: { value: "abc" } });
    await waitFor(() => {
      expect(result.container.textContent).not.toContain("Please enter an order number.");
    });
  });

  it("multi-shipment: changes Condition select onChange (line 990)", async () => {
    const result = await mountWithOrder({
      order: { ...sampleOrder, lineItems: [] },
      shipments: multiShipments,
    });
    await waitFor(() => {
      expect(result.container.textContent).toContain("Shipment 1");
    });
    const checkboxes = result.container.querySelectorAll('input[type="checkbox"]');
    const firstEnabled = Array.from(checkboxes).find(
      (cb) => !(cb as HTMLInputElement).disabled,
    ) as HTMLInputElement;
    fireEvent.click(firstEnabled);

    await waitFor(() => {
      const selects = result.container.querySelectorAll("select");
      expect(selects.length).toBeGreaterThanOrEqual(2);
    });

    const selects = result.container.querySelectorAll("select");
    // [0] Reason, [1] Condition for the expanded item
    await act(async () => {
      fireEvent.change(selects[1], { target: { value: "used_like_new" } });
    });
    await waitFor(() => {
      expect((selects[1] as HTMLSelectElement).value).toBe("used_like_new");
    });
  });

  it("multi-shipment: edits Notes textarea onChange (line 997)", async () => {
    const result = await mountWithOrder({
      order: { ...sampleOrder, lineItems: [] },
      shipments: multiShipments,
    });
    await waitFor(() => {
      expect(result.container.textContent).toContain("Shipment 1");
    });
    const checkboxes = result.container.querySelectorAll('input[type="checkbox"]');
    const firstEnabled = Array.from(checkboxes).find(
      (cb) => !(cb as HTMLInputElement).disabled,
    ) as HTMLInputElement;
    fireEvent.click(firstEnabled);

    await waitFor(() => {
      const tas = result.container.querySelectorAll("textarea");
      expect(tas.length).toBeGreaterThanOrEqual(1);
    });
    const tas = result.container.querySelectorAll("textarea");
    await act(async () => {
      fireEvent.change(tas[0], { target: { value: "scratched packaging" } });
    });
    await waitFor(() => {
      expect((tas[0] as HTMLTextAreaElement).value).toBe("scratched packaging");
    });
  });

  it("multi-shipment: edits qty input within shipment row", async () => {
    const result = await mountWithOrder({
      order: { ...sampleOrder, lineItems: [] },
      shipments: multiShipments,
    });
    const checkboxes = result.container.querySelectorAll('input[type="checkbox"]');
    const firstEnabled = Array.from(checkboxes).find(
      (cb) => !(cb as HTMLInputElement).disabled,
    ) as HTMLInputElement;
    fireEvent.click(firstEnabled);

    await waitFor(() => {
      const num = result.container.querySelector('input[type="number"]');
      expect(num).toBeTruthy();
    });
    const qty = result.container.querySelector('input[type="number"]') as HTMLInputElement;
    // Trigger clamps: above max (4) and below min (0) and a regular value
    fireEvent.change(qty, { target: { value: "99" } });
    fireEvent.change(qty, { target: { value: "0" } });
    await act(async () => {
      fireEvent.change(qty, { target: { value: "3" } });
    });
    await waitFor(() => {
      expect(qty.value).toBe("3");
    });
  });

  it("multi-shipment: disables a row when its Fynd bag is already returned", async () => {
    const result = await mountWithOrder({
      order: { ...sampleOrder, lineItems: [] },
      shipments: multiShipments,
      shipmentReturnedQtyMap: {
        "gship-1": {
          "bag-1": 4,
        },
      },
    });

    await waitFor(() => {
      expect(result.container.textContent).toContain("Already returned");
    });
    const checkboxes = result.container.querySelectorAll('input[type="checkbox"]');
    expect((checkboxes[0] as HTMLInputElement).disabled).toBe(true);
    expect((checkboxes[1] as HTMLInputElement).disabled).toBe(false);
  });

  it("multi-shipment: keeps duplicate visible article rows independently selectable", async () => {
    const duplicateArticleShipments = [
      {
        shipmentId: "same-ship",
        shipmentStatus: "delivered_to_customer",
        eligible: true,
        items: [
          {
            id: "same-line",
            title: "RETURN4",
            variantTitle: "L",
            sku: "RETURN4-L",
            quantity: 1,
            price: "200.00",
            imageUrl: null,
          },
          {
            id: "same-line",
            title: "RETURN4",
            variantTitle: "L",
            sku: "RETURN4-L",
            quantity: 1,
            price: "200.00",
            imageUrl: null,
          },
        ],
      },
      {
        shipmentId: "other-ship",
        shipmentStatus: "delivered_to_customer",
        eligible: true,
        items: [
          {
            id: "other-line",
            title: "Different Item",
            variantTitle: "M",
            sku: "OTHER-M",
            quantity: 1,
            price: "100.00",
            imageUrl: null,
          },
        ],
      },
    ];

    const result = await mountWithOrder({
      order: { ...sampleOrder, lineItems: [] },
      shipments: duplicateArticleShipments,
    });

    const checkboxes = result.container.querySelectorAll('input[type="checkbox"]');
    fireEvent.click(checkboxes[0]);

    await waitFor(() => {
      expect((checkboxes[0] as HTMLInputElement).checked).toBe(true);
      expect((checkboxes[1] as HTMLInputElement).checked).toBe(false);
      expect((checkboxes[2] as HTMLInputElement).checked).toBe(false);
      expect(result.container.textContent).toContain("1 item selected");
    });
  });

  it("multi-shipment: edits Reason select onChange", async () => {
    const result = await mountWithOrder({
      order: { ...sampleOrder, lineItems: [] },
      shipments: multiShipments,
    });
    const checkboxes = result.container.querySelectorAll('input[type="checkbox"]');
    const firstEnabled = Array.from(checkboxes).find(
      (cb) => !(cb as HTMLInputElement).disabled,
    ) as HTMLInputElement;
    fireEvent.click(firstEnabled);

    await waitFor(() => {
      const selects = result.container.querySelectorAll("select");
      expect(selects.length).toBeGreaterThanOrEqual(2);
    });
    const selects = result.container.querySelectorAll("select");
    await act(async () => {
      fireEvent.change(selects[0], { target: { value: "damaged" } });
    });
    await waitFor(() => {
      expect((selects[0] as HTMLSelectElement).value).toBe("damaged");
    });
  });

  it("multi-shipment: validateStep2 fails when condition missing on selected item", async () => {
    const result = await mountWithOrder({
      order: { ...sampleOrder, lineItems: [] },
      shipments: multiShipments,
    });
    const checkboxes = result.container.querySelectorAll('input[type="checkbox"]');
    const firstEnabled = Array.from(checkboxes).find(
      (cb) => !(cb as HTMLInputElement).disabled,
    ) as HTMLInputElement;
    fireEvent.click(firstEnabled);

    await waitFor(() => {
      const selects = result.container.querySelectorAll("select");
      expect(selects.length).toBeGreaterThanOrEqual(2);
    });
    const selects = result.container.querySelectorAll("select");
    // Set reason but skip condition
    fireEvent.change(selects[0], { target: { value: "size_issue" } });

    const buttons = Array.from(result.container.querySelectorAll("button"));
    const nextBtn = buttons.find((b) => b.textContent?.trim() === "Next") as HTMLButtonElement;
    fireEvent.click(nextBtn);

    await waitFor(() => {
      expect(result.container.textContent).toContain("Please select the item condition");
    });
  });

  it("step 3: edits Agent Name input (line 1286)", async () => {
    const result = await mountWithOrder();
    // Advance to step 3
    const checkboxes = result.container.querySelectorAll('input[type="checkbox"]');
    fireEvent.click(checkboxes[0]);
    const selects = result.container.querySelectorAll("select");
    fireEvent.change(selects[0], { target: { value: "size_issue" } });
    fireEvent.change(selects[1], { target: { value: "new_with_tags" } });
    const buttons = Array.from(result.container.querySelectorAll("button"));
    const nextBtn = buttons.find((b) => b.textContent?.trim() === "Next") as HTMLButtonElement;
    fireEvent.click(nextBtn);
    await waitFor(() => {
      expect(result.container.textContent).toContain("Customer Information");
    });

    // Locate the Agent Name input by its placeholder.
    const agentInput = result.container.querySelector(
      'input[placeholder="Agent name"]',
    ) as HTMLInputElement;
    expect(agentInput).toBeTruthy();
    // Default value seeded as "Admin"
    expect(agentInput.value).toBe("Admin");
    await act(async () => {
      fireEvent.change(agentInput, { target: { value: "Casey Agent" } });
    });
    await waitFor(() => {
      expect(agentInput.value).toBe("Casey Agent");
    });
  });

  it("step 3: empty agent name still allowed; submit defaults to 'Admin'", async () => {
    const result = await mountWithOrder();
    // Advance to step 2 -> 3
    const checkboxes = result.container.querySelectorAll('input[type="checkbox"]');
    fireEvent.click(checkboxes[0]);
    const selects = result.container.querySelectorAll("select");
    fireEvent.change(selects[0], { target: { value: "size_issue" } });
    fireEvent.change(selects[1], { target: { value: "new_with_tags" } });
    let buttons = Array.from(result.container.querySelectorAll("button"));
    fireEvent.click(buttons.find((b) => b.textContent?.trim() === "Next") as HTMLButtonElement);
    await waitFor(() => {
      expect(result.container.textContent).toContain("Customer Information");
    });

    // Clear the agent name (whitespace) — this exercises the trim() branch
    // in handleSubmit's createdByStaff fallback.
    const agentInput = result.container.querySelector(
      'input[placeholder="Agent name"]',
    ) as HTMLInputElement;
    fireEvent.change(agentInput, { target: { value: "   " } });

    // Advance to step 4
    buttons = Array.from(result.container.querySelectorAll("button"));
    const reviewBtn = buttons.find((b) => b.textContent?.trim() === "Review") as HTMLButtonElement;
    fireEvent.click(reviewBtn);
    await waitFor(() => {
      expect(result.container.textContent).toContain("Return Items");
    });

    buttons = Array.from(result.container.querySelectorAll("button"));
    const submitBtn = buttons.find((b) =>
      /Submit Return/i.test(b.textContent || ""),
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(submitBtn);
    });
    await waitFor(() => {
      expect(submitFetcherShared.submit).toHaveBeenCalled();
    });
    const [body] = submitFetcherShared.submit.mock.calls[0];
    const parsed = JSON.parse(body as string);
    expect(parsed.createdByStaff).toBe("Admin");
  });

  it("submit success without returnCase id does NOT trigger navigate", async () => {
    submitFetcherShared.data = { success: true, returnCase: null };
    const result = await mountWithOrder();
    // Just advance to step 2; the redirect effect runs on every render.
    await waitFor(() => {
      expect(result.container.textContent).toContain("Select Items to Return");
    });
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("orderFetcher with error data shows error and does NOT auto-advance", async () => {
    orderFetcherShared.data = { error: "Order not found" };
    const result = renderWithRouter(CreateReturn, {
      initialEntries: ["/app/returns/create"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(result.container.textContent).toContain("Order not found");
    });
    // Stayed on step 1
    expect(result.container.textContent).toContain("Look up Order");
  });

  it("loader returns shopDomain from authenticated session (lines 362-363)", async () => {
    (authenticate.admin as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      session: { shop: "loader-shop.myshopify.com" },
    });
    const req = new Request("https://example.com/app/returns/create");
    const res = await loader({
      request: req,
      params: {},
      context: {},
    } as Parameters<typeof loader>[0]);
    expect(res).toEqual({ shopDomain: "loader-shop.myshopify.com" });
    expect(authenticate.admin).toHaveBeenCalledWith(req);
  });

  it("safeCurrencyCode falls back when currencyCode object has NO recognised keys (line 17)", async () => {
    // currencyCode is an object whose value is itself an object — none of the
    // ?? branches resolve to a string, so the helper returns the fallback.
    const result = await mountWithOrder({
      order: {
        ...sampleOrder,
        currencyCode: { unrelated: { nested: "x" } },
      },
    });
    // Default fallback is "INR"
    expect(result.container.textContent).toContain("INR");
  });

  it("safePrice returns '0' when price object has no usable amount (line 30)", async () => {
    // Each candidate key (amount/value/effective/transfer_price/price_effective/mrp)
    // is an OBJECT — typeof n === "object" so the inner branch is skipped and
    // the function falls through to `return "0"`.
    const result = await mountWithOrder({
      order: {
        ...sampleOrder,
        lineItems: [
          {
            ...sampleOrder.lineItems[0],
            // None of the recognised keys; outer object branch falls through.
            price: { foo: { nested: "x" } },
          },
        ],
      },
    });
    // The price renders as "USD 0" because safePrice fell to fallback.
    expect(result.container.textContent).toContain("USD 0");
  });

  it("safeCurrencyCode returns fallback when value is null/undefined", async () => {
    // currencyCode set to null hits the `if (!val) return fallback` branch
    // (safePrice fallback "INR" is rendered for the line item).
    const result = await mountWithOrder({
      order: {
        ...sampleOrder,
        currencyCode: null,
      },
    });
    expect(result.container.textContent).toContain("INR");
  });

  it("safePrice handles numeric value via typeof===number branch (line 23)", async () => {
    // A bare number (not wrapped in an object) hits the
    // `typeof val === "number"` branch.
    const result = await mountWithOrder({
      order: {
        ...sampleOrder,
        lineItems: [
          {
            ...sampleOrder.lineItems[0],
            price: 25 as unknown as string,
          },
        ],
      },
    });
    expect(result.container.textContent).toContain("USD 25");
  });

  it("step 4 review skips selected items missing from orderData.lineItems (line 1401 if (!li) return null)", async () => {
    // Multi-shipment with empty orderData.lineItems forces the find()
    // lookup in the review block to return undefined → if (!li) return null
    // path is exercised when we render step 4.
    const result = await mountWithOrder({
      order: { ...sampleOrder, lineItems: [] },
      shipments: multiShipments,
    });
    const checkboxes = result.container.querySelectorAll('input[type="checkbox"]');
    const firstEnabled = Array.from(checkboxes).find(
      (cb) => !(cb as HTMLInputElement).disabled,
    ) as HTMLInputElement;
    fireEvent.click(firstEnabled);
    await waitFor(() => {
      const selects = result.container.querySelectorAll("select");
      expect(selects.length).toBeGreaterThanOrEqual(2);
    });
    const selects = result.container.querySelectorAll("select");
    fireEvent.change(selects[0], { target: { value: "size_issue" } });
    fireEvent.change(selects[1], { target: { value: "new_with_tags" } });

    let buttons = Array.from(result.container.querySelectorAll("button"));
    fireEvent.click(buttons.find((b) => b.textContent?.trim() === "Next") as HTMLButtonElement);
    await waitFor(() => {
      expect(result.container.textContent).toContain("Customer Information");
    });

    buttons = Array.from(result.container.querySelectorAll("button"));
    fireEvent.click(buttons.find((b) => b.textContent?.trim() === "Review") as HTMLButtonElement);
    await waitFor(() => {
      expect(result.container.textContent).toContain("Return Items");
    });

    // Submitting from this state still works — handleSubmit's `if (!orderData)
    // return` is NOT hit here, but the item-summary loop hit the `if (!li)`
    // continue-branch.
    buttons = Array.from(result.container.querySelectorAll("button"));
    const submitBtn = buttons.find((b) =>
      /Submit Return/i.test(b.textContent || ""),
    ) as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(submitBtn);
    });
    await waitFor(() => {
      expect(submitFetcherShared.submit).toHaveBeenCalled();
    });
  });

  it("single-shipment: disables zero-available items instead of allowing a zero-qty return", async () => {
    const result = await mountWithOrder({
      order: {
        ...sampleOrder,
        lineItems: [
          {
            ...sampleOrder.lineItems[0],
            quantity: 0,
          },
        ],
      },
    });
    const checkboxes = result.container.querySelectorAll('input[type="checkbox"]');
    expect((checkboxes[0] as HTMLInputElement).disabled).toBe(true);
    expect(result.container.textContent).toContain("Already returned");
    const buttons = Array.from(result.container.querySelectorAll("button"));
    const nextBtn = buttons.find((b) => b.textContent?.trim() === "Next") as HTMLButtonElement;
    fireEvent.click(nextBtn);
    await waitFor(() => {
      expect(result.container.textContent).toContain("Please select at least one item");
    });
  });
});
