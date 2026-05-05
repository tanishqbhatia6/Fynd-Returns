/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Mocks for module-top-level imports in app/routes/app.settings.api-keys.tsx ──
// The route's loader & action use authenticate.admin / prisma / lib helpers via
// dynamic import(), but the module is still type-checked against shopify.server.
// Stub these so the component module evaluates cleanly in jsdom.
vi.mock("../../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../../db.server", () => ({
  default: {
    shop: { findUnique: vi.fn() },
    apiKey: {
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));
vi.mock("../../lib/api-key-auth.server", () => ({
  ALL_PERMISSIONS: ["read_returns", "write_returns", "read_settings", "manage_webhooks"],
  generateApiKey: vi.fn(async () => ({
    fullKey: "rpm_test_full_key",
    keyPrefix: "rpm_test",
    keyHash: "hash",
  })),
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
import { fireEvent, waitFor } from "@testing-library/react";
import ApiKeysSettings from "../app.settings.api-keys";

type ApiKeyRow = {
  id: string;
  name: string;
  keyPrefix: string;
  permissions: string;
  isActive: boolean;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

const emptyLoaderData = { keys: [] as ApiKeyRow[] };

const populatedLoaderData = {
  keys: [
    {
      id: "key-active-1",
      name: "ERP Integration",
      keyPrefix: "rpm_abc123",
      permissions: JSON.stringify(["read_returns", "write_returns"]),
      isActive: true,
      lastUsedAt: "2026-05-01T10:00:00.000Z",
      revokedAt: null,
      createdAt: "2026-04-15T08:00:00.000Z",
    },
    {
      id: "key-revoked-2",
      name: "Old Webhook Key",
      keyPrefix: "rpm_xyz789",
      permissions: JSON.stringify(["manage_webhooks"]),
      isActive: false,
      lastUsedAt: null,
      revokedAt: "2026-04-20T12:00:00.000Z",
      createdAt: "2026-03-10T08:00:00.000Z",
    },
  ] as ApiKeyRow[],
};

describe("ApiKeysSettings (default export)", () => {
  it("renders inside the AppPage wrapper with the API Keys heading", async () => {
    const { findByTestId } = renderWithRouter(ApiKeysSettings, {
      initialEntries: ["/app/settings/api-keys"],
      loaderData: emptyLoaderData,
    });
    const heading = await findByTestId("app-page-heading");
    expect(heading.textContent).toBe("API Keys");
  });

  it("shows the empty state when there are no API keys", async () => {
    const { container } = renderWithRouter(ApiKeysSettings, {
      initialEntries: ["/app/settings/api-keys"],
      loaderData: emptyLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain(
        'No API keys generated yet. Click "Generate New Key" to create one.',
      );
    });
  });

  it("renders the Generate New Key button and section description", async () => {
    const { container } = renderWithRouter(ApiKeysSettings, {
      initialEntries: ["/app/settings/api-keys"],
      loaderData: emptyLoaderData,
    });
    await waitFor(() => {
      const buttons = Array.from(container.querySelectorAll("button"));
      const generate = buttons.find((b) => b.textContent?.trim() === "Generate New Key");
      expect(generate).toBeTruthy();
    });
    expect(container.textContent).toContain("External API Keys");
    expect(container.textContent).toContain(
      "Generate API keys for ERP systems and external integrations",
    );
  });

  it("toggles the generate form open when Generate New Key is clicked", async () => {
    const { container } = renderWithRouter(ApiKeysSettings, {
      initialEntries: ["/app/settings/api-keys"],
      loaderData: emptyLoaderData,
    });
    let toggle: HTMLButtonElement | undefined;
    await waitFor(() => {
      const buttons = Array.from(container.querySelectorAll("button"));
      toggle = buttons.find((b) => b.textContent?.trim() === "Generate New Key") as
        | HTMLButtonElement
        | undefined;
      expect(toggle).toBeTruthy();
    });
    // Form is hidden by default — name input shouldn't exist yet.
    expect(container.querySelector("input[name='name']")).toBeNull();

    fireEvent.click(toggle!);

    // After click: form rendered with the name input + four permission checkboxes.
    const nameInput = container.querySelector("input[name='name']") as HTMLInputElement | null;
    expect(nameInput).toBeTruthy();
    expect(nameInput?.placeholder).toMatch(/ERP Integration/i);
    const checkboxes = container.querySelectorAll("input[type='checkbox']");
    expect(checkboxes.length).toBe(4);

    // Toggle button label flips to "Cancel".
    const buttonsAfter = Array.from(container.querySelectorAll("button"));
    const cancel = buttonsAfter.find((b) => b.textContent?.trim() === "Cancel");
    expect(cancel).toBeTruthy();
  });

  it("renders one row per key in the populated list", async () => {
    const { container } = renderWithRouter(ApiKeysSettings, {
      initialEntries: ["/app/settings/api-keys"],
      loaderData: populatedLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("ERP Integration");
    });
    expect(container.textContent).toContain("Old Webhook Key");
    expect(container.textContent).toContain("rpm_abc123");
    expect(container.textContent).toContain("rpm_xyz789");
    // Empty state copy must NOT appear when there are keys.
    expect(container.textContent).not.toContain("No API keys generated yet.");
  });

  it("renders Active and Revoked status badges based on isActive/revokedAt", async () => {
    const { container } = renderWithRouter(ApiKeysSettings, {
      initialEntries: ["/app/settings/api-keys"],
      loaderData: populatedLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Active");
    });
    expect(container.textContent).toContain("Revoked");
  });

  it("shows a Revoke button for active keys and a Delete button for revoked keys", async () => {
    const { container } = renderWithRouter(ApiKeysSettings, {
      initialEntries: ["/app/settings/api-keys"],
      loaderData: populatedLoaderData,
    });
    await waitFor(() => {
      const buttons = Array.from(container.querySelectorAll("button"));
      const labels = buttons.map((b) => b.textContent?.trim());
      expect(labels).toEqual(expect.arrayContaining(["Revoke", "Delete"]));
    });

    // Revoke form should carry the active key's id.
    const revokeForms = Array.from(container.querySelectorAll("form")).filter((f) =>
      Array.from(f.querySelectorAll("input")).some(
        (i) => i.getAttribute("name") === "_action" && i.getAttribute("value") === "revoke",
      ),
    );
    expect(revokeForms.length).toBe(1);
    const revokeKeyId = revokeForms[0].querySelector("input[name='keyId']") as HTMLInputElement | null;
    expect(revokeKeyId?.value).toBe("key-active-1");

    // Delete form should carry the revoked key's id.
    const deleteForms = Array.from(container.querySelectorAll("form")).filter((f) =>
      Array.from(f.querySelectorAll("input")).some(
        (i) => i.getAttribute("name") === "_action" && i.getAttribute("value") === "delete",
      ),
    );
    expect(deleteForms.length).toBe(1);
    const deleteKeyId = deleteForms[0].querySelector("input[name='keyId']") as HTMLInputElement | null;
    expect(deleteKeyId?.value).toBe("key-revoked-2");
  });

  it("renders a View Docs link pointing to the API documentation page", async () => {
    const { container } = renderWithRouter(ApiKeysSettings, {
      initialEntries: ["/app/settings/api-keys"],
      loaderData: emptyLoaderData,
    });
    await waitFor(() => {
      const docsLink = container.querySelector("a[href='/app/api-docs']");
      expect(docsLink).toBeTruthy();
    });
    const docsLink = container.querySelector("a[href='/app/api-docs']");
    expect(docsLink?.textContent).toContain("View Docs");
    expect(container.textContent).toContain("API Documentation");
  });
});
