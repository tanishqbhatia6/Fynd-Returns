/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Mocks for module-top-level imports in app/routes/app.settings.channel-policies.tsx ──
// The route imports shopify.server / db.server / lib/source-channel.server purely
// for the loader and (transitively) module evaluation. Stub them so importing the
// component in jsdom doesn't crash on Node-only deps.
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

// boundary helpers from the server entry are imported transitively; stub.
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
import { waitFor } from "@testing-library/react";
import ChannelPoliciesSettings from "../app.settings.channel-policies";
import type { ChannelPoliciesMap } from "../../lib/source-channel.server";

const emptyPolicies: ChannelPoliciesMap = {};

const baseLoaderData = {
  policies: emptyPolicies,
};

describe("Channel Policies settings page (default export)", () => {
  it("renders the page heading and subtitle", async () => {
    const { findByText } = renderWithRouter(ChannelPoliciesSettings, {
      initialEntries: ["/app/settings/channel-policies"],
      loaderData: baseLoaderData,
    });
    expect(await findByText("Channel Policies")).toBeTruthy();
    expect(
      await findByText(/Configure return eligibility per Shopify sales channel/i),
    ).toBeTruthy();
  });

  it("renders all 3 channel rows (POS, Draft Orders, B2B)", async () => {
    const { findByText } = renderWithRouter(ChannelPoliciesSettings, {
      initialEntries: ["/app/settings/channel-policies"],
      loaderData: baseLoaderData,
    });
    expect(await findByText("Point of Sale (POS)")).toBeTruthy();
    expect(await findByText("Draft Orders")).toBeTruthy();
    expect(await findByText("B2B / Wholesale")).toBeTruthy();
  });

  it("renders descriptive text for each channel", async () => {
    const { container } = renderWithRouter(ChannelPoliciesSettings, {
      initialEntries: ["/app/settings/channel-policies"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(
        /Returns from orders placed in-store via Shopify POS/i,
      );
    });
    expect(container.textContent).toMatch(
      /Returns from orders originally created as Shopify draft orders/i,
    );
    expect(container.textContent).toMatch(
      /Returns from orders placed through Shopify B2B or wholesale channels/i,
    );
  });

  it("renders a hidden returnEnabled input for each channel defaulting to true", async () => {
    const { container } = renderWithRouter(ChannelPoliciesSettings, {
      initialEntries: ["/app/settings/channel-policies"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(
        container.querySelector("input[name='pos_returnEnabled']"),
      ).toBeTruthy();
    });
    const posInput = container.querySelector(
      "input[name='pos_returnEnabled']",
    ) as HTMLInputElement | null;
    const draftInput = container.querySelector(
      "input[name='draft_order_returnEnabled']",
    ) as HTMLInputElement | null;
    const b2bInput = container.querySelector(
      "input[name='b2b_returnEnabled']",
    ) as HTMLInputElement | null;
    expect(posInput?.value).toBe("true");
    expect(draftInput?.value).toBe("true");
    expect(b2bInput?.value).toBe("true");
  });

  it("renders the return-window and auto-approve controls when enabled", async () => {
    const { container } = renderWithRouter(ChannelPoliciesSettings, {
      initialEntries: ["/app/settings/channel-policies"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("input[type='number']")).toBeTruthy();
    });
    // 3 channels enabled by default → 3 number inputs + 3 selects.
    const numberInputs = container.querySelectorAll("input[type='number']");
    const selects = container.querySelectorAll("select");
    expect(numberInputs.length).toBe(3);
    expect(selects.length).toBe(3);
  });

  it("hydrates control values from policies in the loader", async () => {
    const { container } = renderWithRouter(ChannelPoliciesSettings, {
      initialEntries: ["/app/settings/channel-policies"],
      loaderData: {
        policies: {
          pos: {
            returnEnabled: true,
            returnWindowDays: 14,
            autoApproveEnabled: true,
          },
          draft_order: {
            returnEnabled: true,
            returnWindowDays: 30,
            autoApproveEnabled: false,
          },
          b2b: {
            returnEnabled: true,
            returnWindowDays: null,
            autoApproveEnabled: null,
          },
        } satisfies ChannelPoliciesMap,
      },
    });
    await waitFor(() => {
      expect(container.querySelector("input[type='number']")).toBeTruthy();
    });
    const numberInputs = Array.from(
      container.querySelectorAll("input[type='number']"),
    ) as HTMLInputElement[];
    const values = numberInputs.map((i) => i.value);
    expect(values).toEqual(expect.arrayContaining(["14", "30", ""]));
  });

  it("shows the disabled-channel warning when a channel has returnEnabled=false", async () => {
    const { container } = renderWithRouter(ChannelPoliciesSettings, {
      initialEntries: ["/app/settings/channel-policies"],
      loaderData: {
        policies: {
          pos: {
            returnEnabled: false,
            returnWindowDays: null,
            autoApproveEnabled: null,
          },
        } satisfies ChannelPoliciesMap,
      },
    });
    await waitFor(() => {
      expect(container.textContent).toMatch(
        /Returns are disabled for Point of Sale \(POS\) orders/i,
      );
    });
    // The disabled channel should NOT render its window/auto-approve controls,
    // so we should have 2 (not 3) number inputs.
    const numberInputs = container.querySelectorAll("input[type='number']");
    expect(numberInputs.length).toBe(2);
  });

  it("renders the Save Changes button and the global-rules info banner", async () => {
    const { container, findByText } = renderWithRouter(ChannelPoliciesSettings, {
      initialEntries: ["/app/settings/channel-policies"],
      loaderData: baseLoaderData,
    });
    expect(await findByText(/Save Changes/i)).toBeTruthy();
    await waitFor(() => {
      expect(container.textContent).toMatch(
        /These rules apply on top of your global return settings/i,
      );
    });
  });
});
