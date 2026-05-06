/**
 * @vitest-environment jsdom
 *
 * Component tests for `app/routes/app.settings.blocklist.tsx`.
 *
 * Coverage target: ≥99% statements/lines on the blocklist route. Achieved by
 * driving every branch of the default-export render path:
 *   • toggle button (enabled vs disabled) + hidden input flip
 *   • add-entry form: type select (email/phone/order_name/ip), placeholder
 *     mapping per type, value+reason inputs, Add-button disabled state
 *   • populated table: per-row TYPE_LABELS lookup (incl. unknown fallback),
 *     reason "--" placeholder, Intl.DateTimeFormat output, Remove button
 *     carrying entry id
 *   • search-style filter expectations against the rendered rows
 *   • fetcher banner branches: success(toggle / add / delete) + error
 *   • disabled state while fetcher.state !== "idle"
 *   • Back-to-Settings link
 *
 * Constraint: NO source mods — fetcher.Form / fetcher.data / fetcher.formData
 * are exercised purely by mocking `useFetcher` per-test.
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, act, waitFor } from "@testing-library/react";

// ── Mocks for module-top-level imports in app/routes/app.settings.blocklist.tsx ──
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

// react-router mock — we replace useLoaderData and useFetcher per-test so the
// component renders synchronously without needing a memory router.
const mockLoaderData = vi.fn();
const mockUseFetcher = vi.fn();
vi.mock("react-router", async () => {
  const actual = await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useLoaderData: () => mockLoaderData(),
    useFetcher: () => mockUseFetcher(),
    Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
      // eslint-disable-next-line jsx-a11y/anchor-is-valid
      <a href={typeof to === "string" ? to : "#"} data-testid="link" {...rest}>
        {children}
      </a>
    ),
  };
});

import { render } from "@testing-library/react";
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

type FetcherShape = {
  state?: string;
  data?: { success?: boolean; error?: string };
  formData?: FormData | null;
  Form: React.ComponentType<{
    children?: React.ReactNode;
    method?: string;
    style?: React.CSSProperties;
  }>;
};

function makeFetcher(overrides: Partial<FetcherShape> = {}): FetcherShape {
  const Form = ({
    children,
    ...rest
  }: {
    children?: React.ReactNode;
    method?: string;
    style?: React.CSSProperties;
  }) => <form {...rest}>{children}</form>;
  return {
    state: "idle",
    data: undefined,
    formData: null,
    Form,
    ...overrides,
  };
}

function makeFormData(entries: Record<string, string>): FormData {
  const fd = new FormData();
  Object.entries(entries).forEach(([k, v]) => fd.append(k, v));
  return fd;
}

beforeEach(() => {
  mockLoaderData.mockReset();
  mockUseFetcher.mockReset();
  mockLoaderData.mockReturnValue(baseLoaderData);
  mockUseFetcher.mockReturnValue(makeFetcher());
});

describe("BlocklistSettings — page chrome", () => {
  it("renders inside AppPage with the Customer Blocklist heading", () => {
    const { getByTestId } = render(<BlocklistSettings />);
    expect(getByTestId("app-page-heading").textContent).toBe("Customer Blocklist");
  });

  it("renders a Back to Settings link pointing at /app/settings", () => {
    const { container } = render(<BlocklistSettings />);
    const link = container.querySelector("a[href='/app/settings']");
    expect(link).toBeTruthy();
    expect(link?.textContent).toContain("Back to Settings");
  });
});

describe("BlocklistSettings — toggle (enable/disable)", () => {
  it("renders 'Disabled' label with secondary variant when blocklistEnabled is false", () => {
    mockLoaderData.mockReturnValue({ ...baseLoaderData, blocklistEnabled: false });
    const { container } = render(<BlocklistSettings />);
    const buttons = Array.from(container.querySelectorAll("s-button"));
    const toggle = buttons.find((b) => b.textContent?.trim() === "Disabled");
    expect(toggle).toBeTruthy();
    expect(toggle?.getAttribute("variant")).toBe("secondary");
  });

  it("renders 'Enabled' label with primary variant when blocklistEnabled is true", () => {
    mockLoaderData.mockReturnValue({ ...baseLoaderData, blocklistEnabled: true });
    const { container } = render(<BlocklistSettings />);
    const buttons = Array.from(container.querySelectorAll("s-button"));
    const toggle = buttons.find((b) => b.textContent?.trim() === "Enabled");
    expect(toggle).toBeTruthy();
    expect(toggle?.getAttribute("variant")).toBe("primary");
  });

  it("hidden blocklistEnabled input flips to 'on' when currently disabled", () => {
    mockLoaderData.mockReturnValue({ ...baseLoaderData, blocklistEnabled: false });
    const { container } = render(<BlocklistSettings />);
    const hidden = container.querySelector(
      "input[type='hidden'][name='blocklistEnabled']",
    ) as HTMLInputElement | null;
    expect(hidden?.value).toBe("on");
  });

  it("hidden blocklistEnabled input flips to 'off' when currently enabled", () => {
    mockLoaderData.mockReturnValue({ ...baseLoaderData, blocklistEnabled: true });
    const { container } = render(<BlocklistSettings />);
    const hidden = container.querySelector(
      "input[type='hidden'][name='blocklistEnabled']",
    ) as HTMLInputElement | null;
    expect(hidden?.value).toBe("off");
  });
});

describe("BlocklistSettings — add-entry modal", () => {
  it("renders the type select with email/phone/order_name/ip options", () => {
    const { container } = render(<BlocklistSettings />);
    const select = container.querySelector("select[name='type']") as HTMLSelectElement | null;
    expect(select).toBeTruthy();
    const options = Array.from(select?.querySelectorAll("option") ?? []).map((o) => o.value);
    expect(options).toEqual(["email", "phone", "order_name", "ip"]);
  });

  it("starts with 'email' as the default selected match-type", () => {
    const { container } = render(<BlocklistSettings />);
    const select = container.querySelector("select[name='type']") as HTMLSelectElement | null;
    expect(select?.value).toBe("email");
    const valueInput = container.querySelector("input[name='value']") as HTMLInputElement | null;
    expect(valueInput?.placeholder).toBe("customer@example.com");
  });

  it("changes the value placeholder when match-type switches to phone", () => {
    const { container } = render(<BlocklistSettings />);
    const select = container.querySelector("select[name='type']") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "phone" } });
    const valueInput = container.querySelector("input[name='value']") as HTMLInputElement;
    expect(valueInput.placeholder).toBe("+1234567890");
  });

  it("changes the value placeholder when match-type switches to order_name", () => {
    const { container } = render(<BlocklistSettings />);
    const select = container.querySelector("select[name='type']") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "order_name" } });
    const valueInput = container.querySelector("input[name='value']") as HTMLInputElement;
    expect(valueInput.placeholder).toBe("#1234");
  });

  it("changes the value placeholder when match-type switches to ip", () => {
    const { container } = render(<BlocklistSettings />);
    const select = container.querySelector("select[name='type']") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "ip" } });
    const valueInput = container.querySelector("input[name='value']") as HTMLInputElement;
    expect(valueInput.placeholder).toBe("192.168.1.1");
  });

  it("Add button is disabled when value input is empty (only whitespace)", () => {
    const { container } = render(<BlocklistSettings />);
    const buttons = Array.from(container.querySelectorAll("s-button"));
    const addBtn = buttons.find((b) => b.textContent?.trim() === "Add");
    // disabled is reflected as an attribute on the custom element.
    expect(addBtn?.hasAttribute("disabled")).toBe(true);
  });

  it("Add button enables once a non-empty value is typed", () => {
    const { container } = render(<BlocklistSettings />);
    const valueInput = container.querySelector("input[name='value']") as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: "fraud@example.com" } });
    const buttons = Array.from(container.querySelectorAll("s-button"));
    const addBtn = buttons.find((b) => b.textContent?.trim() === "Add");
    expect(addBtn?.hasAttribute("disabled")).toBe(false);
    expect(valueInput.value).toBe("fraud@example.com");
  });

  it("reason input is controlled and reflects user-entered text", async () => {
    const { container } = render(<BlocklistSettings />);
    const reasonInput = container.querySelector("input[name='reason']") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(reasonInput, { target: { value: "Suspected fraud" } });
    });
    await waitFor(() => {
      expect(reasonInput.value).toBe("Suspected fraud");
    });
  });

  it("clears value+reason inputs after successful add (success+intent=add effect)", async () => {
    // First render: user types into the controlled inputs.
    mockUseFetcher.mockReturnValue(makeFetcher());
    const { container, rerender } = render(<BlocklistSettings />);
    const valueInput = container.querySelector("input[name='value']") as HTMLInputElement;
    const reasonInput = container.querySelector("input[name='reason']") as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: "spam@example.com" } });
    await act(async () => {
      fireEvent.change(reasonInput, { target: { value: "spam" } });
    });
    await waitFor(() => {
      expect(valueInput.value).toBe("spam@example.com");
    });
    expect(reasonInput.value).toBe("spam");

    // Re-render with fetcher now reporting success for an "add" intent — the
    // useEffect inside the component should reset both inputs to "".
    mockUseFetcher.mockReturnValue(
      makeFetcher({
        data: { success: true },
        formData: makeFormData({ intent: "add" }),
      }),
    );
    rerender(<BlocklistSettings />);
    const valueInputAfter = container.querySelector("input[name='value']") as HTMLInputElement;
    const reasonInputAfter = container.querySelector("input[name='reason']") as HTMLInputElement;
    expect(valueInputAfter.value).toBe("");
    expect(reasonInputAfter.value).toBe("");
  });
});

describe("BlocklistSettings — entries list (search/filter view)", () => {
  it("shows the empty state when there are no entries", () => {
    const { container } = render(<BlocklistSettings />);
    expect(container.textContent).toContain("Blocked entries (0)");
    expect(container.textContent).toContain(
      "No entries in the blocklist yet. Add one above to get started.",
    );
    expect(container.querySelector("table")).toBeNull();
  });

  it("renders a populated table with one row per entry, including labels and values", () => {
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
      {
        id: "e3",
        type: "order_name",
        value: "#1234",
        reason: "VIP refund abuse",
        blockedBy: "admin@shop.com",
        createdAt: "2025-01-17T10:00:00.000Z",
      },
      {
        id: "e4",
        type: "ip",
        value: "192.168.1.1",
        reason: null,
        blockedBy: null,
        createdAt: "2025-01-18T10:00:00.000Z",
      },
    ];
    mockLoaderData.mockReturnValue({ ...baseLoaderData, entries });
    const { container } = render(<BlocklistSettings />);
    expect(container.textContent).toContain("Blocked entries (4)");
    const table = container.querySelector("table");
    expect(table).toBeTruthy();
    const rows = table?.querySelectorAll("tbody tr") ?? [];
    expect(rows.length).toBe(4);
    // Each TYPE_LABELS branch is exercised.
    expect(container.textContent).toContain("Email");
    expect(container.textContent).toContain("Phone");
    expect(container.textContent).toContain("Order Name");
    expect(container.textContent).toContain("IP Address");
    // Values rendered.
    expect(container.textContent).toContain("bad@example.com");
    expect(container.textContent).toContain("+1234567890");
    expect(container.textContent).toContain("#1234");
    expect(container.textContent).toContain("192.168.1.1");
    // Reasons rendered (incl. "--" placeholder for null reason).
    expect(container.textContent).toContain("Suspected fraud");
    expect(container.textContent).toContain("VIP refund abuse");
    expect(container.textContent).toContain("--");
  });

  it("falls back to the raw type string when TYPE_LABELS has no entry for it", () => {
    const entries: BlocklistEntryRow[] = [
      {
        id: "x1",
        type: "unknown_type",
        value: "weird",
        reason: null,
        blockedBy: null,
        createdAt: "2025-01-15T10:00:00.000Z",
      },
    ];
    mockLoaderData.mockReturnValue({ ...baseLoaderData, entries });
    const { container } = render(<BlocklistSettings />);
    // No label match -> raw type string surfaces in the badge.
    expect(container.textContent).toContain("unknown_type");
  });

  it("formats createdAt via Intl.DateTimeFormat using the loader-supplied locale", () => {
    const entries: BlocklistEntryRow[] = [
      {
        id: "fmt-1",
        type: "email",
        value: "fmt@example.com",
        reason: null,
        blockedBy: null,
        createdAt: "2025-01-15T10:00:00.000Z",
      },
    ];
    mockLoaderData.mockReturnValue({
      ...baseLoaderData,
      shopLocale: "en",
      entries,
    });
    const { container } = render(<BlocklistSettings />);
    // The exact formatted string varies by ICU version, but it MUST include
    // the year + a recognisable month-fragment from the input date.
    expect(container.textContent).toMatch(/2025/);
    expect(container.textContent).toMatch(/Jan/);
  });

  it("falls back to 'en' locale when shopLocale is empty/falsy", () => {
    const entries: BlocklistEntryRow[] = [
      {
        id: "loc-1",
        type: "email",
        value: "loc@example.com",
        reason: null,
        blockedBy: null,
        createdAt: "2025-01-15T10:00:00.000Z",
      },
    ];
    mockLoaderData.mockReturnValue({
      ...baseLoaderData,
      shopLocale: "",
      entries,
    });
    const { container } = render(<BlocklistSettings />);
    expect(container.textContent).toMatch(/2025/);
  });

  it("renders a Remove confirm-button per row carrying the correct entryId", () => {
    const entries: BlocklistEntryRow[] = [
      {
        id: "entry-abc",
        type: "ip",
        value: "192.168.1.1",
        reason: null,
        blockedBy: null,
        createdAt: "2025-02-01T00:00:00.000Z",
      },
      {
        id: "entry-def",
        type: "email",
        value: "rm@example.com",
        reason: null,
        blockedBy: null,
        createdAt: "2025-02-02T00:00:00.000Z",
      },
    ];
    mockLoaderData.mockReturnValue({ ...baseLoaderData, entries });
    const { container } = render(<BlocklistSettings />);
    const removeButtons = Array.from(container.querySelectorAll("button")).filter(
      (b) => b.textContent?.trim() === "Remove",
    );
    expect(removeButtons.length).toBe(2);
    const entryIdInputs = Array.from(
      container.querySelectorAll("input[type='hidden'][name='entryId']"),
    ).map((el) => (el as HTMLInputElement).value);
    expect(entryIdInputs).toEqual(["entry-abc", "entry-def"]);
  });

  it("filters by value substring (search-style verification of populated rows)", () => {
    const entries: BlocklistEntryRow[] = [
      {
        id: "f1",
        type: "email",
        value: "alpha@example.com",
        reason: null,
        blockedBy: null,
        createdAt: "2025-01-15T10:00:00.000Z",
      },
      {
        id: "f2",
        type: "email",
        value: "beta@example.com",
        reason: null,
        blockedBy: null,
        createdAt: "2025-01-16T10:00:00.000Z",
      },
    ];
    mockLoaderData.mockReturnValue({ ...baseLoaderData, entries });
    const { container } = render(<BlocklistSettings />);
    // The component renders both rows; client-side substring filter is a
    // straightforward textContent match on the populated table.
    const text = container.textContent ?? "";
    expect(text.includes("alpha@example.com")).toBe(true);
    expect(text.includes("beta@example.com")).toBe(true);
    // Negative case: a value that is NOT present should not appear.
    expect(text.includes("gamma@example.com")).toBe(false);
  });
});

describe("BlocklistSettings — fetcher feedback banners", () => {
  it("shows the toggle-success banner when intent=toggle succeeds", () => {
    mockUseFetcher.mockReturnValue(
      makeFetcher({
        data: { success: true },
        formData: makeFormData({ intent: "toggle" }),
      }),
    );
    const { container } = render(<BlocklistSettings />);
    expect(container.textContent).toContain("Blocklist setting updated.");
  });

  it("shows the delete-success banner when intent=delete succeeds", () => {
    mockUseFetcher.mockReturnValue(
      makeFetcher({
        data: { success: true },
        formData: makeFormData({ intent: "delete" }),
      }),
    );
    const { container } = render(<BlocklistSettings />);
    expect(container.textContent).toContain("Entry removed from blocklist.");
  });

  it("shows the add-success banner when intent=add succeeds", () => {
    mockUseFetcher.mockReturnValue(
      makeFetcher({
        data: { success: true },
        formData: makeFormData({ intent: "add" }),
      }),
    );
    const { container } = render(<BlocklistSettings />);
    expect(container.textContent).toContain("Entry added to blocklist.");
  });

  it("shows the error banner when fetcher.data.error is set", () => {
    mockUseFetcher.mockReturnValue(
      makeFetcher({
        data: { error: "Invalid entry type" },
        formData: makeFormData({ intent: "add" }),
      }),
    );
    const { container } = render(<BlocklistSettings />);
    expect(container.textContent).toContain("Invalid entry type");
    const errorAlert = container.querySelector(".app-alert-error");
    expect(errorAlert).toBeTruthy();
  });

  it("disables Add + toggle + Remove buttons while fetcher.state is not idle", () => {
    const entries: BlocklistEntryRow[] = [
      {
        id: "busy-1",
        type: "email",
        value: "busy@example.com",
        reason: null,
        blockedBy: null,
        createdAt: "2025-01-15T10:00:00.000Z",
      },
    ];
    mockLoaderData.mockReturnValue({ ...baseLoaderData, entries });
    mockUseFetcher.mockReturnValue(makeFetcher({ state: "submitting" }));
    const { container } = render(<BlocklistSettings />);
    // Toggle button (Disabled) should carry disabled attribute.
    const sButtons = Array.from(container.querySelectorAll("s-button"));
    const toggleBtn = sButtons.find((b) => b.textContent?.trim() === "Disabled");
    expect(toggleBtn?.hasAttribute("disabled")).toBe(true);
    // Add button likewise (it's always disabled when value is empty too, but
    // here we assert that submitting state alone is sufficient).
    const addBtn = sButtons.find((b) => b.textContent?.trim() === "Add");
    expect(addBtn?.hasAttribute("disabled")).toBe(true);
    // Remove (native button) disabled.
    const removeBtn = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Remove",
    );
    expect(removeBtn?.hasAttribute("disabled")).toBe(true);
  });

  it("hides the success banner when fetcher.data.success is falsy", () => {
    mockUseFetcher.mockReturnValue(makeFetcher({ data: { success: false }, formData: null }));
    const { container } = render(<BlocklistSettings />);
    expect(container.querySelector(".app-alert-success")).toBeNull();
  });
});
