/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Mocks for module-top-level imports in app/routes/app.settings.blocklist.tsx ──
// The route pulls in shopify.server / db.server / lib/* purely for the
// loader/action. Stub them so importing the component in jsdom doesn't
// crash on Node-only deps.
vi.mock("../../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../../db.server", () => ({
  default: {
    blocklistEntry: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    shopSettings: {
      upsert: vi.fn(),
      update: vi.fn(),
    },
  },
}));
vi.mock("../../lib/shop.server", () => ({
  findOrCreateShop: vi.fn(),
}));

// AppPage shouldn't pull in embedded-Shopify host machinery during test —
// passthrough render the heading + children.
vi.mock("../../components/AppPage", () => ({
  AppPage: ({ heading, children }: { heading: string; children: React.ReactNode }) => (
    <div data-testid="app-page">
      <h1 data-testid="app-page-heading">{heading}</h1>
      {children}
    </div>
  ),
}));

import { renderWithRouter } from "../../test/component-helpers";
import BlocklistSettings from "../app.settings.blocklist";

type BlocklistEntryRow = {
  id: string;
  type: string;
  value: string;
  reason: string | null;
  blockedBy: string | null;
  createdAt: string;
};

const baseLoaderData: {
  blocklistEnabled: boolean;
  entries: BlocklistEntryRow[];
  shopLocale: string;
  shopTimezone: string;
} = {
  blocklistEnabled: false,
  entries: [],
  shopLocale: "en",
  shopTimezone: "UTC",
};

describe("BlocklistSettings (default export)", () => {
  it("renders inside the AppPage wrapper with the Customer Blocklist heading", async () => {
    const { findByTestId } = renderWithRouter(BlocklistSettings, {
      initialEntries: ["/app/settings/blocklist"],
      loaderData: baseLoaderData,
    });
    const heading = await findByTestId("app-page-heading");
    expect(heading.textContent).toBe("Customer Blocklist");
  });

  it("renders the toggle button with 'Disabled' label when blocklistEnabled is false", async () => {
    const { container, findByTestId } = renderWithRouter(BlocklistSettings, {
      initialEntries: ["/app/settings/blocklist"],
      loaderData: baseLoaderData,
    });
    await findByTestId("app-page");
    const buttons = Array.from(container.querySelectorAll("s-button"));
    const toggle = buttons.find((b) => b.textContent?.trim() === "Disabled");
    expect(toggle).toBeTruthy();
    expect(toggle?.getAttribute("variant")).toBe("secondary");
  });

  it("renders the toggle button with 'Enabled' label and primary variant when blocklistEnabled is true", async () => {
    const { container, findByTestId } = renderWithRouter(BlocklistSettings, {
      initialEntries: ["/app/settings/blocklist"],
      loaderData: { ...baseLoaderData, blocklistEnabled: true },
    });
    await findByTestId("app-page");
    const buttons = Array.from(container.querySelectorAll("s-button"));
    const toggle = buttons.find((b) => b.textContent?.trim() === "Enabled");
    expect(toggle).toBeTruthy();
    expect(toggle?.getAttribute("variant")).toBe("primary");
  });

  it("includes a hidden toggle input flipping the next state (off->on when disabled)", async () => {
    const { container, findByTestId } = renderWithRouter(BlocklistSettings, {
      initialEntries: ["/app/settings/blocklist"],
      loaderData: baseLoaderData,
    });
    await findByTestId("app-page");
    const hidden = container.querySelector(
      "input[type='hidden'][name='blocklistEnabled']",
    ) as HTMLInputElement | null;
    expect(hidden).toBeTruthy();
    expect(hidden?.value).toBe("on");
  });

  it("renders the type select with all four blocklist entry types", async () => {
    const { container, findByTestId } = renderWithRouter(BlocklistSettings, {
      initialEntries: ["/app/settings/blocklist"],
      loaderData: baseLoaderData,
    });
    await findByTestId("app-page");
    const select = container.querySelector("select[name='type']") as HTMLSelectElement | null;
    expect(select).toBeTruthy();
    const options = Array.from(select?.querySelectorAll("option") ?? []).map(
      (o) => o.value,
    );
    expect(options).toEqual(["email", "phone", "order_name", "ip"]);
  });

  it("shows the empty state when there are no blocklist entries", async () => {
    const { container, findByTestId } = renderWithRouter(BlocklistSettings, {
      initialEntries: ["/app/settings/blocklist"],
      loaderData: baseLoaderData,
    });
    await findByTestId("app-page");
    expect(container.textContent).toContain("Blocked entries (0)");
    expect(container.textContent).toContain(
      "No entries in the blocklist yet. Add one above to get started.",
    );
    expect(container.querySelector("table")).toBeNull();
  });

  it("renders a populated table with one row per entry, including type label and value", async () => {
    const entries: BlocklistEntryRow[] = [
      {
        id: "e1",
        type: "email",
        value: "bad@example.com",
        reason: "Suspected fraud",
        blockedBy: "admin@shop.com",
        createdAt: "2025-01-15T10:00:00.000Z",
      },
      {
        id: "e2",
        type: "phone",
        value: "+1234567890",
        reason: null,
        blockedBy: null,
        createdAt: "2025-01-16T10:00:00.000Z",
      },
    ];
    const { container, findByTestId } = renderWithRouter(BlocklistSettings, {
      initialEntries: ["/app/settings/blocklist"],
      loaderData: { ...baseLoaderData, entries },
    });
    await findByTestId("app-page");
    expect(container.textContent).toContain("Blocked entries (2)");
    const table = container.querySelector("table");
    expect(table).toBeTruthy();
    const rows = table?.querySelectorAll("tbody tr") ?? [];
    expect(rows.length).toBe(2);
    expect(container.textContent).toContain("bad@example.com");
    expect(container.textContent).toContain("+1234567890");
    expect(container.textContent).toContain("Suspected fraud");
    // Email label rendered for "email" type entry
    const cells = container.textContent ?? "";
    expect(cells).toContain("Email");
    expect(cells).toContain("Phone");
  });

  it("renders a Remove button per populated row carrying the entry id", async () => {
    const entries: BlocklistEntryRow[] = [
      {
        id: "entry-abc",
        type: "ip",
        value: "192.168.1.1",
        reason: null,
        blockedBy: null,
        createdAt: "2025-02-01T00:00:00.000Z",
      },
    ];
    const { container, findByTestId } = renderWithRouter(BlocklistSettings, {
      initialEntries: ["/app/settings/blocklist"],
      loaderData: { ...baseLoaderData, entries },
    });
    await findByTestId("app-page");
    const removeButtons = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.textContent?.trim() === "Remove",
    );
    expect(removeButtons.length).toBe(1);
    const entryIdInput = container.querySelector(
      "input[type='hidden'][name='entryId']",
    ) as HTMLInputElement | null;
    expect(entryIdInput?.value).toBe("entry-abc");
  });
});
