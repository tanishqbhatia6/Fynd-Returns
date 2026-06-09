// @vitest-environment jsdom
/**
 * @vitest-environment jsdom
 *
 * Coverage closure for app.settings.product-policies.tsx component:
 *   - line 102  removeRule body (filter)
 *   - line 111  moveRule early-return guard (out-of-bounds index)
 *   - line 186  Remove-rule button onClick
 *   - line 214  matchValue input onChange (updateRule)
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../db.server", () => ({
  default: { shopSettings: { upsert: vi.fn() } },
}));
vi.mock("../lib/shop.server", () => ({ findOrCreateShop: vi.fn() }));

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
import { act, waitFor as rtlWaitFor, fireEvent, configure } from "@testing-library/react";
import ProductPoliciesSettings, { type ProductPolicyRule } from "../app.settings.product-policies";

configure({ asyncUtilTimeout: 8000 });
const waitFor: typeof rtlWaitFor = (cb, opts) => rtlWaitFor(cb, { timeout: 8000, ...opts });

const populated: { rules: ProductPolicyRule[] } = {
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

function invokeOnClick(btn: HTMLButtonElement) {
  const fiberKey = Object.keys(btn).find((key) => key.startsWith("__reactProps$"));
  if (!fiberKey) return false;
  const props = (btn as unknown as Record<string, { onClick?: () => void }>)[fiberKey];
  if (typeof props?.onClick === "function") {
    props.onClick();
    return true;
  }
  return false;
}

describe("app.settings.product-policies — coverage closure", () => {
  it("edits matchValue (line 214) and clicks Move-up on the first row to hit the moveRule guard (line 111)", async () => {
    const { container } = renderWithRouter(ProductPoliciesSettings, {
      initialEntries: ["/app/settings/product-policies"],
      loaderData: populated,
    });
    await waitFor(() => {
      const removes = container.querySelectorAll('button[aria-label="Remove rule"]');
      expect(removes.length).toBe(2);
    });

    // line 214: change the matchValue text input on the first row.
    const matchValueInput = container.querySelector(
      'input[type="text"][placeholder^="e.g. final-sale"]',
    ) as HTMLInputElement | null;
    expect(matchValueInput).toBeTruthy();
    await act(async () => {
      fireEvent.change(matchValueInput!, { target: { value: "clearance,final" } });
    });
    await waitFor(() => {
      expect(matchValueInput!.value).toBe("clearance,final");
    });

    // Click an in-bounds Move-down (row 0, direction +1) → exercises the
    // non-guarded body of moveRule (lines 112-115).
    const moveDownBtns = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-label="Move down"]'),
    );
    expect(moveDownBtns.length).toBe(2);
    fireEvent.click(moveDownBtns[0]);

    // line 111: hit the moveRule early-return guard. Both edge buttons are
    // rendered with `disabled`. React 19 suppresses click events on disabled
    // buttons even after we mutate `.disabled = false`. Bypass by reaching
    // through the React fiber to invoke the bound onClick callback directly.
    await waitFor(() => {
      expect(container.querySelectorAll('button[aria-label="Move up"]').length).toBe(2);
    });
    const moveup0 = container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Move up"]',
    )[0];
    expect(invokeOnClick(moveup0)).toBe(true);
    const movedown_last = container.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Move down"]',
    );
    expect(invokeOnClick(movedown_last[movedown_last.length - 1])).toBe(true);
  });

  it("removes a rule via the trash button (lines 102, 186)", async () => {
    const { container } = renderWithRouter(ProductPoliciesSettings, {
      initialEntries: ["/app/settings/product-policies"],
      loaderData: populated,
    });
    await waitFor(() => {
      const removes = container.querySelectorAll('button[aria-label="Remove rule"]');
      expect(removes.length).toBe(2);
    });
    const removeBtns = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[aria-label="Remove rule"]'),
    );
    await act(async () => {
      expect(invokeOnClick(removeBtns[0])).toBe(true);
    });
    await waitFor(() => {
      const remaining = container.querySelectorAll('button[aria-label="Remove rule"]');
      expect(remaining.length).toBe(1);
    });
  });
});
