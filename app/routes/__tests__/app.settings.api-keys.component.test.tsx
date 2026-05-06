/**
 * @vitest-environment jsdom
 *
 * Component tests for app/routes/app.settings.api-keys.tsx.
 *
 * Pushes coverage past 99% by exercising the three actionData branches that
 * a plain renderWithRouter() can't reach (the route reads fetcher.data, not
 * useActionData()):
 *   - generated-key banner + Copy button → navigator.clipboard + setTimeout
 *   - error banner
 *   - success banner
 *
 * Also covers: empty list, populated list (active + revoked rows),
 * generate-form open/close, name input, permission checkboxes, generate
 * submit (through fetcher.Form), revoke confirm, delete confirm.
 *
 * Pure component tests — no source mods. All deps mocked.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Module-level mocks for loader/action imports ──
// The route uses dynamic import() inside loader/action, but the module is
// still type-checked against shopify.server / db.server / api-key-auth.server.
vi.mock("../../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../shopify.server", () => ({
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
vi.mock("../db.server", () => ({
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
vi.mock("../lib/api-key-auth.server", () => ({
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

// Stub useLoaderData + useFetcher so we can drive the route's three
// actionData branches (generatedKey banner / error / success) directly.
type FetcherData =
  | { generatedKey: string; keyName: string }
  | { error: string }
  | { success: string }
  | undefined;
type MockFetcherState = {
  state: "idle" | "loading" | "submitting";
  data: FetcherData;
  submit: ReturnType<typeof vi.fn>;
  load: ReturnType<typeof vi.fn>;
  Form: React.FC<React.FormHTMLAttributes<HTMLFormElement>>;
};
const mockLoaderState: { value: unknown } = { value: { keys: [] } };
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

import { renderWithRouter } from "../../test/component-helpers";
import { fireEvent, waitFor, act } from "@testing-library/react";
import { afterEach } from "vitest";
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

// Loader row with malformed permissions JSON to exercise the try/catch fallback.
const malformedPermsLoader = {
  keys: [
    {
      id: "key-malformed-3",
      name: "Bad JSON Key",
      keyPrefix: "rpm_bad",
      permissions: "{not-json",
      isActive: true,
      lastUsedAt: null,
      revokedAt: null,
      createdAt: "2026-04-01T08:00:00.000Z",
    },
  ] as ApiKeyRow[],
};

beforeEach(() => {
  mockLoaderState.value = emptyLoaderData;
  mockFetcher.state = "idle";
  mockFetcher.data = undefined;
  mockFetcher.submit.mockReset();
  mockFetcher.load.mockReset();
});

afterEach(() => {
  // Defensive: any test that opted into vi.useFakeTimers must restore real
  // timers, otherwise waitFor() in later tests polls a frozen clock.
  vi.useRealTimers();
});

describe("ApiKeysSettings (default export)", () => {
  it("renders inside the AppPage wrapper with the API Keys heading", async () => {
    mockLoaderState.value = emptyLoaderData;
    const { findByTestId } = renderWithRouter(ApiKeysSettings, {
      initialEntries: ["/app/settings/api-keys"],
      loaderData: emptyLoaderData,
    });
    const heading = await findByTestId("app-page-heading");
    expect(heading.textContent).toBe("API Keys");
  });

  it("shows the empty state when there are no API keys", async () => {
    mockLoaderState.value = emptyLoaderData;
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
    mockLoaderState.value = emptyLoaderData;
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

  it("toggles the generate-key form open and renders name input + 4 permission checkboxes", async () => {
    mockLoaderState.value = emptyLoaderData;
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
    expect(container.querySelector("input[name='name']")).toBeNull();

    fireEvent.click(toggle!);

    const nameInput = container.querySelector("input[name='name']") as HTMLInputElement | null;
    expect(nameInput).toBeTruthy();
    expect(nameInput?.placeholder).toMatch(/ERP Integration/i);
    expect(nameInput?.required).toBe(true);

    const checkboxes = container.querySelectorAll("input[type='checkbox']");
    expect(checkboxes.length).toBe(4);
    // All 4 permission checkboxes default-checked.
    Array.from(checkboxes).forEach((cb) => {
      expect((cb as HTMLInputElement).checked).toBe(true);
    });
    // Each checkbox carries the perm_<perm> name from PERMISSIONS_LIST.
    const cbNames = Array.from(checkboxes).map((cb) => (cb as HTMLInputElement).name).sort();
    expect(cbNames).toEqual([
      "perm_manage_webhooks",
      "perm_read_returns",
      "perm_read_settings",
      "perm_write_returns",
    ]);

    // Permission labels rendered.
    expect(container.textContent).toContain("Read Returns");
    expect(container.textContent).toContain("Write Returns (approve, reject, refund)");
    expect(container.textContent).toContain("Read Settings");
    expect(container.textContent).toContain("Manage Webhooks");

    const buttonsAfter = Array.from(container.querySelectorAll("button"));
    const cancel = buttonsAfter.find((b) => b.textContent?.trim() === "Cancel");
    expect(cancel).toBeTruthy();

    // Toggling the name field via fireEvent.change exercises the controlled input flow.
    await act(async () => { fireEvent.change(nameInput!, { target: { value: "My ERP" } }); });
    await waitFor(() => {
      expect((container.querySelector("input[name='name']") as HTMLInputElement).value).toBe(
        "My ERP",
      );
    });

    // Clicking a permission checkbox toggles it off — covers the checkbox onChange path.
    await act(async () => { fireEvent.click(checkboxes[0]); });
    await waitFor(() => { expect((checkboxes[0] as HTMLInputElement).checked).toBe(false); });

    // Clicking Cancel closes the form.
    await act(async () => { fireEvent.click(cancel!); });
    await waitFor(() => { expect(container.querySelector("input[name='name']")).toBeNull(); });
  });

  it("submitting the generate form posts via fetcher.Form with hidden _action=generate", async () => {
    mockLoaderState.value = emptyLoaderData;
    const { container } = renderWithRouter(ApiKeysSettings, {
      initialEntries: ["/app/settings/api-keys"],
      loaderData: emptyLoaderData,
    });
    await waitFor(() => {
      const buttons = Array.from(container.querySelectorAll("button"));
      const generate = buttons.find((b) => b.textContent?.trim() === "Generate New Key");
      expect(generate).toBeTruthy();
    });
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Generate New Key",
    ) as HTMLButtonElement;
    fireEvent.click(toggle);

    const generateForm = container.querySelector("form");
    expect(generateForm).toBeTruthy();
    const hidden = generateForm!.querySelector("input[name='_action']") as HTMLInputElement;
    expect(hidden.value).toBe("generate");

    const submitBtn = Array.from(generateForm!.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Generate Key",
    ) as HTMLButtonElement;
    expect(submitBtn).toBeTruthy();
    expect(submitBtn.disabled).toBe(false);
    fireEvent.submit(generateForm!);
  });

  it("disables the Generate Key button and shows 'Generating...' while fetcher state is submitting", async () => {
    mockLoaderState.value = emptyLoaderData;
    mockFetcher.state = "submitting";
    const { container } = renderWithRouter(ApiKeysSettings, {
      initialEntries: ["/app/settings/api-keys"],
      loaderData: emptyLoaderData,
    });
    await waitFor(() => {
      const buttons = Array.from(container.querySelectorAll("button"));
      const generate = buttons.find((b) => b.textContent?.trim() === "Generate New Key");
      expect(generate).toBeTruthy();
    });
    const toggle = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Generate New Key",
    ) as HTMLButtonElement;
    fireEvent.click(toggle);
    const submitBtn = Array.from(container.querySelectorAll("form button")).find(
      (b) => b.textContent?.trim() === "Generating...",
    ) as HTMLButtonElement;
    expect(submitBtn).toBeTruthy();
    expect(submitBtn.disabled).toBe(true);
  });

  it("renders the generated-key banner with fullKey when fetcher.data has generatedKey", async () => {
    mockLoaderState.value = emptyLoaderData;
    mockFetcher.data = { generatedKey: "rpm_full_secret_xxx", keyName: "ERP Integration" };

    const { container } = renderWithRouter(ApiKeysSettings, {
      initialEntries: ["/app/settings/api-keys"],
      loaderData: emptyLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("API Key Generated Successfully");
    });
    expect(container.textContent).toContain("Copy this key now");
    expect(container.textContent).toContain("rpm_full_secret_xxx");
    const copyBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Copy",
    );
    expect(copyBtn).toBeTruthy();
  });

  it("clicking Copy on the reveal banner calls navigator.clipboard.writeText and flips label to 'Copied!'", async () => {
    mockLoaderState.value = emptyLoaderData;
    mockFetcher.data = { generatedKey: "rpm_full_secret_xxx", keyName: "ERP Integration" };

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(global.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    const { container } = renderWithRouter(ApiKeysSettings, {
      initialEntries: ["/app/settings/api-keys"],
      loaderData: emptyLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("API Key Generated Successfully");
    });
    const copyBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Copy",
    ) as HTMLButtonElement;
    expect(copyBtn).toBeTruthy();

    await act(async () => { fireEvent.click(copyBtn); });
    await waitFor(() => { expect(writeText).toHaveBeenCalledWith("rpm_full_secret_xxx"); });

    // Synchronous setCopiedKey(true) → label flips to "Copied!".
    await waitFor(() => {
      const flipped = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent?.trim() === "Copied!",
      );
      expect(flipped).toBeTruthy();
    });
  });

  it("Copy reverts to 'Copy' after the 2s setTimeout fires (covers setCopiedKey(false))", async () => {
    mockLoaderState.value = emptyLoaderData;
    mockFetcher.data = { generatedKey: "rpm_full_secret_yyy", keyName: "Another Key" };

    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(global.navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });

    const { container } = renderWithRouter(ApiKeysSettings, {
      initialEntries: ["/app/settings/api-keys"],
      loaderData: emptyLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("API Key Generated Successfully");
    });
    const copyBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Copy",
    ) as HTMLButtonElement;
    fireEvent.click(copyBtn);

    // Real timers — wait up to 3s for the 2s setTimeout(setCopiedKey(false)) to execute.
    await waitFor(
      () => {
        const reverted = Array.from(container.querySelectorAll("button")).find(
          (b) => b.textContent?.trim() === "Copy",
        );
        expect(reverted).toBeTruthy();
      },
      { timeout: 3000 },
    );
  });

  it("renders the error banner when fetcher.data has 'error'", async () => {
    mockLoaderState.value = emptyLoaderData;
    mockFetcher.data = { error: "Key name is required" };
    const { container } = renderWithRouter(ApiKeysSettings, {
      initialEntries: ["/app/settings/api-keys"],
      loaderData: emptyLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Key name is required");
    });
  });

  it("renders the success banner when fetcher.data has 'success'", async () => {
    mockLoaderState.value = emptyLoaderData;
    mockFetcher.data = { success: "API key revoked" };
    const { container } = renderWithRouter(ApiKeysSettings, {
      initialEntries: ["/app/settings/api-keys"],
      loaderData: emptyLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("API key revoked");
    });
  });

  it("renders one row per key in the populated list with prefix masking + permission tags", async () => {
    mockLoaderState.value = populatedLoaderData;
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
    // Permission tag chips rendered for the active key.
    expect(container.textContent).toContain("read_returns");
    expect(container.textContent).toContain("write_returns");
    expect(container.textContent).toContain("manage_webhooks");
    // Created / Last used timestamps rendered.
    expect(container.textContent).toMatch(/Created/);
    expect(container.textContent).toMatch(/Last used/);
    expect(container.textContent).not.toContain("No API keys generated yet.");
  });

  it("renders Active and Revoked status badges based on isActive/revokedAt", async () => {
    mockLoaderState.value = populatedLoaderData;
    const { container } = renderWithRouter(ApiKeysSettings, {
      initialEntries: ["/app/settings/api-keys"],
      loaderData: populatedLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Active");
    });
    expect(container.textContent).toContain("Revoked");
  });

  it("clicking Revoke submits the revoke form with the active key's id", async () => {
    mockLoaderState.value = populatedLoaderData;
    const { container } = renderWithRouter(ApiKeysSettings, {
      initialEntries: ["/app/settings/api-keys"],
      loaderData: populatedLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("ERP Integration");
    });

    const revokeForms = Array.from(container.querySelectorAll("form")).filter((f) =>
      Array.from(f.querySelectorAll("input")).some(
        (i) => i.getAttribute("name") === "_action" && i.getAttribute("value") === "revoke",
      ),
    );
    expect(revokeForms.length).toBe(1);
    const revokeKeyId = revokeForms[0].querySelector(
      "input[name='keyId']",
    ) as HTMLInputElement | null;
    expect(revokeKeyId?.value).toBe("key-active-1");

    const revokeBtn = revokeForms[0].querySelector("button[type='submit']") as HTMLButtonElement;
    expect(revokeBtn.textContent?.trim()).toBe("Revoke");
    expect(revokeBtn.disabled).toBe(false);

    fireEvent.submit(revokeForms[0]);
  });

  it("clicking Delete submits the delete form with the revoked key's id", async () => {
    mockLoaderState.value = populatedLoaderData;
    const { container } = renderWithRouter(ApiKeysSettings, {
      initialEntries: ["/app/settings/api-keys"],
      loaderData: populatedLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Old Webhook Key");
    });

    const deleteForms = Array.from(container.querySelectorAll("form")).filter((f) =>
      Array.from(f.querySelectorAll("input")).some(
        (i) => i.getAttribute("name") === "_action" && i.getAttribute("value") === "delete",
      ),
    );
    expect(deleteForms.length).toBe(1);
    const deleteKeyId = deleteForms[0].querySelector(
      "input[name='keyId']",
    ) as HTMLInputElement | null;
    expect(deleteKeyId?.value).toBe("key-revoked-2");

    const deleteBtn = deleteForms[0].querySelector("button[type='submit']") as HTMLButtonElement;
    expect(deleteBtn.textContent?.trim()).toBe("Delete");

    fireEvent.submit(deleteForms[0]);
  });

  it("disables Revoke + Delete buttons while fetcher is submitting", async () => {
    mockLoaderState.value = populatedLoaderData;
    mockFetcher.state = "submitting";
    const { container } = renderWithRouter(ApiKeysSettings, {
      initialEntries: ["/app/settings/api-keys"],
      loaderData: populatedLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("ERP Integration");
    });
    const revokeBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Revoke",
    ) as HTMLButtonElement;
    expect(revokeBtn.disabled).toBe(true);
    const deleteBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Delete",
    ) as HTMLButtonElement;
    expect(deleteBtn.disabled).toBe(true);
  });

  it("falls back to empty perms array when permissions JSON fails to parse", async () => {
    mockLoaderState.value = malformedPermsLoader;
    const { container } = renderWithRouter(ApiKeysSettings, {
      initialEntries: ["/app/settings/api-keys"],
      loaderData: malformedPermsLoader,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Bad JSON Key");
    });
    // No permission chips rendered, but the row + status badge still render.
    expect(container.textContent).toContain("Active");
  });

  it("renders a View Docs link pointing to the API documentation page", async () => {
    mockLoaderState.value = emptyLoaderData;
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
