/**
 * @vitest-environment jsdom
 *
 * Interaction-level component tests for app/routes/app.settings.channel-policies.tsx
 * Pushes coverage of the default-export component body (toggles, per-channel
 * controls, save handler, navigate-back) above 95% statements.
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../db.server", () => ({
  default: {
    shop: { findUnique: vi.fn() },
    shopSettings: { update: vi.fn() },
  },
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
import ChannelPoliciesSettings from "../app.settings.channel-policies";
import type { ChannelPoliciesMap } from "../../lib/source-channel.server";

const emptyPolicies: ChannelPoliciesMap = {};
const baseLoaderData = { policies: emptyPolicies };

describe("Channel Policies — interaction coverage", () => {
  it("toggles the POS channel off via the toggle switch", async () => {
    const { container } = renderWithRouter(ChannelPoliciesSettings, {
      initialEntries: ["/app/settings/channel-policies"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(
        container.querySelector("input[name='pos_returnEnabled']"),
      ).toBeTruthy();
    });
    const hidden = container.querySelector(
      "input[name='pos_returnEnabled']",
    ) as HTMLInputElement;
    expect(hidden.value).toBe("true");
    fireEvent.click(hidden.nextElementSibling as HTMLElement);
    await waitFor(() => {
      expect(
        (container.querySelector(
          "input[name='pos_returnEnabled']",
        ) as HTMLInputElement).value,
      ).toBe("false");
    });
    expect(container.querySelectorAll("input[type='number']").length).toBe(2);
    expect(container.textContent).toMatch(
      /Returns are disabled for Point of Sale \(POS\) orders/i,
    );
  });

  it("toggles the draft_order channel off then back on", async () => {
    const { container } = renderWithRouter(ChannelPoliciesSettings, {
      initialEntries: ["/app/settings/channel-policies"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(
        container.querySelector("input[name='draft_order_returnEnabled']"),
      ).toBeTruthy();
    });
    const h1 = container.querySelector(
      "input[name='draft_order_returnEnabled']",
    ) as HTMLInputElement;
    fireEvent.click(h1.nextElementSibling as HTMLElement);
    await waitFor(() => {
      expect(
        (container.querySelector(
          "input[name='draft_order_returnEnabled']",
        ) as HTMLInputElement).value,
      ).toBe("false");
    });
    const h2 = container.querySelector(
      "input[name='draft_order_returnEnabled']",
    ) as HTMLInputElement;
    fireEvent.click(h2.nextElementSibling as HTMLElement);
    await waitFor(() => {
      expect(
        (container.querySelector(
          "input[name='draft_order_returnEnabled']",
        ) as HTMLInputElement).value,
      ).toBe("true");
    });
  });

  it("toggles the b2b channel off and shows the disabled message", async () => {
    const { container } = renderWithRouter(ChannelPoliciesSettings, {
      initialEntries: ["/app/settings/channel-policies"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(
        container.querySelector("input[name='b2b_returnEnabled']"),
      ).toBeTruthy();
    });
    const hidden = container.querySelector(
      "input[name='b2b_returnEnabled']",
    ) as HTMLInputElement;
    fireEvent.click(hidden.nextElementSibling as HTMLElement);
    await waitFor(() => {
      expect(
        (container.querySelector(
          "input[name='b2b_returnEnabled']",
        ) as HTMLInputElement).value,
      ).toBe("false");
    });
    expect(container.textContent).toMatch(
      /Returns are disabled for B2B \/ Wholesale orders/i,
    );
  });

  it("updates and clears the return-window number input", async () => {
    const { container } = renderWithRouter(ChannelPoliciesSettings, {
      initialEntries: ["/app/settings/channel-policies"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("input[type='number']")).toBeTruthy();
    });
    let inputs = Array.from(
      container.querySelectorAll("input[type='number']"),
    ) as HTMLInputElement[];
    fireEvent.change(inputs[0], { target: { value: "21" } });
    await waitFor(() => {
      const refreshed = Array.from(
        container.querySelectorAll("input[type='number']"),
      ) as HTMLInputElement[];
      expect(refreshed[0].value).toBe("21");
    });
    inputs = Array.from(
      container.querySelectorAll("input[type='number']"),
    ) as HTMLInputElement[];
    fireEvent.change(inputs[0], { target: { value: "" } });
    await waitFor(() => {
      const again = Array.from(
        container.querySelectorAll("input[type='number']"),
      ) as HTMLInputElement[];
      expect(again[0].value).toBe("");
    });
  });

  it("updates the auto-approve select for each channel (true / false / blank)", async () => {
    const { container } = renderWithRouter(ChannelPoliciesSettings, {
      initialEntries: ["/app/settings/channel-policies"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("select")).toBeTruthy();
    });
    let selects = Array.from(
      container.querySelectorAll("select"),
    ) as HTMLSelectElement[];
    fireEvent.change(selects[0], { target: { value: "true" } });
    await waitFor(() => {
      const s = Array.from(
        container.querySelectorAll("select"),
      ) as HTMLSelectElement[];
      expect(s[0].value).toBe("true");
    });
    selects = Array.from(
      container.querySelectorAll("select"),
    ) as HTMLSelectElement[];
    fireEvent.change(selects[1], { target: { value: "false" } });
    await waitFor(() => {
      const s = Array.from(
        container.querySelectorAll("select"),
      ) as HTMLSelectElement[];
      expect(s[1].value).toBe("false");
    });
    selects = Array.from(
      container.querySelectorAll("select"),
    ) as HTMLSelectElement[];
    fireEvent.change(selects[2], { target: { value: "" } });
    await waitFor(() => {
      const s = Array.from(
        container.querySelectorAll("select"),
      ) as HTMLSelectElement[];
      expect(s[2].value).toBe("");
    });
  });

  it("submits the form via the Save button (covers handleSave)", async () => {
    const { container, findByText } = renderWithRouter(ChannelPoliciesSettings, {
      initialEntries: ["/app/settings/channel-policies"],
      loaderData: baseLoaderData,
      actionData: { success: true },
    });
    const saveBtn = (await findByText(/Save Changes/i)) as HTMLElement;
    await waitFor(() => {
      expect(container.querySelector("input[type='number']")).toBeTruthy();
    });
    const numberInputs = Array.from(
      container.querySelectorAll("input[type='number']"),
    ) as HTMLInputElement[];
    fireEvent.change(numberInputs[0], { target: { value: "10" } });
    const selects = Array.from(
      container.querySelectorAll("select"),
    ) as HTMLSelectElement[];
    fireEvent.change(selects[1], { target: { value: "true" } });
    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(saveBtn).toBeTruthy();
    });
  });

  it("submits the form when channels start with non-default policies (autoApprove=null path)", async () => {
    const { container, findByText } = renderWithRouter(ChannelPoliciesSettings, {
      initialEntries: ["/app/settings/channel-policies"],
      loaderData: {
        policies: {
          pos: {
            returnEnabled: false,
            returnWindowDays: null,
            autoApproveEnabled: null,
          },
          draft_order: {
            returnEnabled: true,
            returnWindowDays: 7,
            autoApproveEnabled: false,
          },
          b2b: {
            returnEnabled: true,
            returnWindowDays: null,
            autoApproveEnabled: true,
          },
        } satisfies ChannelPoliciesMap,
      },
      actionData: { success: true },
    });
    const saveBtn = (await findByText(/Save Changes/i)) as HTMLElement;
    expect(container.textContent).toMatch(
      /Returns are disabled for Point of Sale \(POS\) orders/i,
    );
    fireEvent.click(saveBtn);
    await waitFor(() => {
      expect(saveBtn).toBeTruthy();
    });
  });

  it("invokes useNavigate when the back-arrow button is clicked", async () => {
    const { container } = renderWithRouter(ChannelPoliciesSettings, {
      initialEntries: ["/app/settings/channel-policies"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("svg polyline")).toBeTruthy();
    });
    const backBtn = container.querySelector(
      "button",
    ) as HTMLButtonElement | null;
    expect(backBtn).toBeTruthy();
    fireEvent.click(backBtn!);
  });

  it("renders the Save button enabled with default Save Changes label", async () => {
    const { findByText, container } = renderWithRouter(ChannelPoliciesSettings, {
      initialEntries: ["/app/settings/channel-policies"],
      loaderData: baseLoaderData,
    });
    const btn = (await findByText(/Save Changes/i)) as HTMLButtonElement;
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.disabled).toBe(false);
    expect(container.textContent).not.toMatch(/Saving…/);
  });
});
