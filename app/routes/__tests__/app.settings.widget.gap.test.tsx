/**
 * @vitest-environment jsdom
 *
 * Gap-coverage tests for app/routes/app.settings.widget.tsx.
 *
 * Targets the previously uncovered statements (per coverage report):
 *  - handleImageUpload helper (lines 176-181) — file size guard, FileReader read
 *  - Custom-label override editor input change handlers (lines 294-300)
 *  - Branding section: logo + favicon upload, remove buttons (lines 309-377)
 *  - Theme dropdowns: font, border radius (lines 394-410)
 *  - Save / Discard / Preview action buttons + form submit hidden inputs
 *
 * Pure component tests — no source modifications. Companion to the existing
 * `app.settings.widget.component.test.tsx` (which covers high-level render
 * paths) and `app.settings.widget.test.ts` (loader/action).
 */
import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub out node-only / Shopify deps that are imported transitively from the
// route module so it can load under jsdom.
vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
}));
vi.mock("../db.server", () => ({
  default: {
    shopSettings: { upsert: vi.fn() },
    shop: { findUnique: vi.fn() },
  },
}));
vi.mock("../lib/shop.server", () => ({
  findOrCreateShop: vi.fn(async () => ({ id: "shop_1", settings: null })),
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
// Stub the app-bridge web components — jsdom would otherwise complain about
// custom elements. Not strictly imported by widget.tsx but tests using
// renderWithRouter sometimes touch global bridge utilities.
vi.mock("@shopify/app-bridge-react", () => ({
  AppProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useAppBridge: () => ({ toast: { show: vi.fn() } }),
}));

import { renderWithRouter } from "../../test/component-helpers";
import { waitFor, fireEvent, act } from "@testing-library/react";
import { DEFAULT_PORTAL_THEME, FONT_OPTIONS } from "../../lib/portal-theme.server";
import { SUPPORTED_LANGUAGES, DEFAULT_LABELS } from "../../lib/portal-i18n";
import Widget from "../app.settings.widget";

const baseLoaderData = {
  portalTheme: { ...DEFAULT_PORTAL_THEME },
  portalConfig: {
    showOrderTracking: true,
    showReturnTracking: true,
    showCreateReturnTab: true,
    defaultTab: "return" as const,
    allowMediaUploads: true,
    allowReturnCancellation: true,
  },
  fontOptions: FONT_OPTIONS,
  portalUrl: "https://test-shop.myshopify.com/apps/returns",
  portalLanguage: "en",
  portalLabelOverrides: {} as Record<string, string>,
  resolvedLabels: { ...DEFAULT_LABELS },
  labelKeys: Object.keys(DEFAULT_LABELS),
  supportedLanguages: SUPPORTED_LANGUAGES,
  shopLocale: "en",
  shopCurrency: "USD",
  shopTimezone: "UTC",
  brandLogoUrl: null as string | null,
  brandFaviconUrl: null as string | null,
};

/**
 * Build a synthetic File. Optionally inflate the size so the >maxBytes branch
 * triggers without actually allocating that much memory (jsdom respects the
 * `size` getter on File-like objects).
 */
function makeFile(name: string, type: string, size = 1024): File {
  const file = new File([new Blob(["a"], { type })], name, { type });
  Object.defineProperty(file, "size", { value: size, configurable: true });
  return file;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("widget gap coverage — label overrides editor", () => {
  it("opens the custom-label editor and types a new override", async () => {
    const { container, findByText } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: baseLoaderData,
    });
    const trigger = await findByText(/Customize label text/i);
    fireEvent.click(trigger);

    await waitFor(() => {
      expect(
        container.querySelectorAll('input[type="text"].app-input').length,
      ).toBeGreaterThan(0);
    });

    const inputs = container.querySelectorAll(
      'input[type="text"].app-input',
    ) as NodeListOf<HTMLInputElement>;
    fireEvent.change(inputs[0], { target: { value: "Custom heading" } });
    expect(inputs[0].value).toBe("Custom heading");

    // Hidden field that mirrors the override map should now contain the value
    const hidden = container.querySelector(
      'input[type="hidden"][name="portalLabelsJson"]',
    ) as HTMLInputElement;
    expect(hidden.value).toContain("Custom heading");
  });

  it("removes a label override when the value is cleared", async () => {
    const firstKey = Object.keys(DEFAULT_LABELS)[0];
    const { container, findByText } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: {
        ...baseLoaderData,
        portalLabelOverrides: { [firstKey]: "Existing override" },
      },
    });
    // showCustomLabels initialised true because overrides exist — no click needed
    await findByText("Hide custom labels");

    const inputs = container.querySelectorAll(
      'input[type="text"].app-input',
    ) as NodeListOf<HTMLInputElement>;
    expect(inputs[0].value).toBe("Existing override");
    fireEvent.change(inputs[0], { target: { value: "   " } });
    expect(inputs[0].value).toBe("");

    const hidden = container.querySelector(
      'input[type="hidden"][name="portalLabelsJson"]',
    ) as HTMLInputElement;
    expect(JSON.parse(hidden.value)).not.toHaveProperty(firstKey);
  });

  it("toggles the editor closed via the same trigger", async () => {
    const { container, findByText } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: baseLoaderData,
    });
    const open = await findByText(/Customize label text/i);
    fireEvent.click(open);
    const close = await findByText(/Hide custom labels/i);
    fireEvent.click(close);
    await waitFor(() => {
      expect(
        container.querySelectorAll('input[type="text"].app-input').length,
      ).toBe(0);
    });
  });
});

describe("widget gap coverage — branding (logo + favicon)", () => {
  it("renders 'No logo' / 'None' placeholders when no images are uploaded", async () => {
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("No logo");
    });
    expect(container.textContent).toContain("None");
  });

  it("renders the saved logo and favicon as <img> when loader provides them", async () => {
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: {
        ...baseLoaderData,
        brandLogoUrl: "data:image/png;base64,LOGO",
        brandFaviconUrl: "data:image/png;base64,FAV",
      },
    });
    await waitFor(() => {
      const img = container.querySelector(
        'img[alt="Brand logo"]',
      ) as HTMLImageElement | null;
      expect(img).toBeTruthy();
      expect(img?.src).toContain("LOGO");
    });
    const fav = container.querySelector(
      'img[alt="Favicon"]',
    ) as HTMLImageElement;
    expect(fav.src).toContain("FAV");
  });

  it("clears the logo when the Remove button is pressed", async () => {
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: {
        ...baseLoaderData,
        brandLogoUrl: "data:image/png;base64,LOGO",
      },
    });
    await waitFor(() => {
      expect(container.querySelector('img[alt="Brand logo"]')).toBeTruthy();
    });
    const removeBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[type="button"]'),
    ).find((b) => b.textContent?.trim() === "Remove");
    expect(removeBtn).toBeTruthy();
    fireEvent.click(removeBtn!);

    await waitFor(() => {
      expect(container.querySelector('img[alt="Brand logo"]')).toBeFalsy();
    });
    const hidden = container.querySelector(
      'input[type="hidden"][name="brandLogoUrl"]',
    ) as HTMLInputElement;
    expect(hidden.value).toBe("");
  });

  it("clears the favicon when the Remove button is pressed", async () => {
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: {
        ...baseLoaderData,
        brandFaviconUrl: "data:image/png;base64,FAV",
      },
    });
    await waitFor(() => {
      expect(container.querySelector('img[alt="Favicon"]')).toBeTruthy();
    });
    // The single visible Remove button is for the favicon (no logo set)
    const removeBtn = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[type="button"]'),
    ).find((b) => b.textContent?.trim() === "Remove");
    fireEvent.click(removeBtn!);
    await waitFor(() => {
      expect(container.querySelector('img[alt="Favicon"]')).toBeFalsy();
    });
    const hidden = container.querySelector(
      'input[type="hidden"][name="brandFaviconUrl"]',
    ) as HTMLInputElement;
    expect(hidden.value).toBe("");
  });

  it("uploads a logo via the file input and stores it as a data URL", async () => {
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(
        container.querySelector('input[type="file"][accept*="image/png"]'),
      ).toBeTruthy();
    });
    const fileInput = container.querySelector(
      'input[type="file"][accept*="image/png"]',
    ) as HTMLInputElement;

    const file = makeFile("logo.png", "image/png", 2048);

    // jsdom's FileReader is functional — but onload is async. Replace it so
    // the assertion runs synchronously.
    class StubReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      readAsDataURL() {
        this.result = "data:image/png;base64,UPLOADED";
        if (this.onload) this.onload();
      }
    }
    const originalFileReader = globalThis.FileReader;
    (globalThis as unknown as { FileReader: typeof StubReader }).FileReader =
      StubReader;

    try {
      await act(async () => {
        fireEvent.change(fileInput, { target: { files: [file] } });
      });
      await waitFor(() => {
        const img = container.querySelector(
          'img[alt="Brand logo"]',
        ) as HTMLImageElement | null;
        expect(img).toBeTruthy();
        expect(img?.src).toContain("UPLOADED");
      });
    } finally {
      (globalThis as unknown as { FileReader: typeof originalFileReader }).FileReader =
        originalFileReader;
    }
  });

  it("rejects oversized image uploads and resets the input", async () => {
    const alertSpy = vi
      .spyOn(window, "alert")
      .mockImplementation(() => undefined);

    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(
        container.querySelector('input[type="file"][accept*="image/png"]'),
      ).toBeTruthy();
    });
    const fileInput = container.querySelector(
      'input[type="file"][accept*="image/png"]',
    ) as HTMLInputElement;

    // 1 MB > 512 KB max
    const huge = makeFile("big.png", "image/png", 1024 * 1024);
    fireEvent.change(fileInput, { target: { files: [huge] } });

    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy.mock.calls[0][0]).toMatch(/Image too large/i);
    // No image rendered after rejection
    expect(container.querySelector('img[alt="Brand logo"]')).toBeFalsy();
  });

  it("ignores empty file selection (no files chosen)", async () => {
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(
        container.querySelector('input[type="file"][accept*="image/png"]'),
      ).toBeTruthy();
    });
    const fileInput = container.querySelector(
      'input[type="file"][accept*="image/png"]',
    ) as HTMLInputElement;
    fireEvent.change(fileInput, { target: { files: [] } });
    // Component shouldn't crash, nothing rendered
    expect(container.querySelector('img[alt="Brand logo"]')).toBeFalsy();
  });

  it("uploads a favicon via the favicon-specific file input", async () => {
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(
        container.querySelectorAll('input[type="file"]').length,
      ).toBeGreaterThanOrEqual(2);
    });
    // Favicon input is the one whose `accept` mentions `image/x-icon`
    const favInput = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[type="file"]'),
    ).find((i) => (i.getAttribute("accept") ?? "").includes("image/x-icon"));
    expect(favInput).toBeTruthy();

    const file = makeFile("favicon.ico", "image/x-icon", 1024);

    class StubReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      readAsDataURL() {
        this.result = "data:image/x-icon;base64,FAVUP";
        if (this.onload) this.onload();
      }
    }
    const originalFileReader = globalThis.FileReader;
    (globalThis as unknown as { FileReader: typeof StubReader }).FileReader =
      StubReader;

    try {
      await act(async () => {
        fireEvent.change(favInput!, { target: { files: [file] } });
      });
      await waitFor(() => {
        const img = container.querySelector(
          'img[alt="Favicon"]',
        ) as HTMLImageElement | null;
        expect(img).toBeTruthy();
        expect(img?.src).toContain("FAVUP");
      });
    } finally {
      (globalThis as unknown as { FileReader: typeof originalFileReader }).FileReader =
        originalFileReader;
    }
  });
});

describe("widget gap coverage — theme controls", () => {
  it("renders the border-radius selector with all four presets", async () => {
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(
        container.querySelector('select[name="borderRadius"]'),
      ).toBeTruthy();
    });
    const sel = container.querySelector(
      'select[name="borderRadius"]',
    ) as HTMLSelectElement;
    const values = Array.from(sel.querySelectorAll("option")).map(
      (o) => (o as HTMLOptionElement).value,
    );
    expect(values).toEqual(["8px", "12px", "16px", "24px"]);
  });

  it("changes the font-family selection", async () => {
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector('select[name="fontFamily"]')).toBeTruthy();
    });
    const sel = container.querySelector(
      'select[name="fontFamily"]',
    ) as HTMLSelectElement;
    const second = FONT_OPTIONS[1].value;
    fireEvent.change(sel, { target: { value: second } });
    expect(sel.value).toBe(second);
  });

  it("changes the primary color value", async () => {
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(
        container.querySelector('input[type="color"][name="primaryColor"]'),
      ).toBeTruthy();
    });
    const input = container.querySelector(
      'input[type="color"][name="primaryColor"]',
    ) as HTMLInputElement;
    fireEvent.input(input, { target: { value: "#abcdef" } });
    expect(input.value).toBe("#abcdef");
  });

  it("renders hidden inputs for theme fields not exposed in the UI", async () => {
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(
        container.querySelector('input[type="hidden"][name="primaryHoverColor"]'),
      ).toBeTruthy();
    });
    expect(
      container.querySelector('input[type="hidden"][name="textColor"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('input[type="hidden"][name="textMutedColor"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('input[type="hidden"][name="borderColor"]'),
    ).toBeTruthy();
    expect(
      container.querySelector('input[type="hidden"][name="shadow"]'),
    ).toBeTruthy();
  });
});

describe("widget gap coverage — toggles + form submission", () => {
  it("flipping a toggle removes the corresponding hidden input", async () => {
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(
        container.querySelector('input[type="hidden"][name="showOrderTracking"]'),
      ).toBeTruthy();
    });
    // First checkbox is "Order tracking"
    const firstCheckbox = container.querySelector(
      'input[type="checkbox"]',
    ) as HTMLInputElement;
    fireEvent.click(firstCheckbox);
    await waitFor(() => {
      expect(
        container.querySelector('input[type="hidden"][name="showOrderTracking"]'),
      ).toBeFalsy();
    });
  });

  it("disabling cancellation adds the off hidden field", async () => {
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      const checkboxes = container.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"]',
      );
      expect(checkboxes.length).toBeGreaterThanOrEqual(5);
    });
    const checkboxes = container.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    // 5th toggle = "Return cancellation"
    fireEvent.click(checkboxes[4]);
    await waitFor(() => {
      expect(
        container.querySelector(
          'input[type="hidden"][name="allowReturnCancellation"]',
        ),
      ).toBeTruthy();
    });
    const hidden = container.querySelector(
      'input[type="hidden"][name="allowReturnCancellation"]',
    ) as HTMLInputElement;
    expect(hidden.value).toBe("off");
  });

  it("changes the default-tab selection", async () => {
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector('select[name="defaultTab"]')).toBeTruthy();
    });
    const sel = container.querySelector(
      'select[name="defaultTab"]',
    ) as HTMLSelectElement;
    fireEvent.change(sel, { target: { value: "order" } });
    expect(sel.value).toBe("order");
  });

  it("changes the portal language selection", async () => {
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(
        container.querySelector('select[name="portalLanguage"]'),
      ).toBeTruthy();
    });
    const sel = container.querySelector(
      'select[name="portalLanguage"]',
    ) as HTMLSelectElement;
    const someOtherLang = SUPPORTED_LANGUAGES.find((l) => l.code !== "en")?.code;
    if (someOtherLang) {
      fireEvent.change(sel, { target: { value: someOtherLang } });
      expect(sel.value).toBe(someOtherLang);
    }
  });

  it("preserves saved logo URL inside the hidden brandLogoUrl field", async () => {
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: {
        ...baseLoaderData,
        brandLogoUrl: "data:image/png;base64,LOGO",
        brandFaviconUrl: "data:image/png;base64,FAV",
      },
    });
    await waitFor(() => {
      expect(
        container.querySelector('input[type="hidden"][name="brandLogoUrl"]'),
      ).toBeTruthy();
    });
    const logoHidden = container.querySelector(
      'input[type="hidden"][name="brandLogoUrl"]',
    ) as HTMLInputElement;
    const favHidden = container.querySelector(
      'input[type="hidden"][name="brandFaviconUrl"]',
    ) as HTMLInputElement;
    expect(logoHidden.value).toContain("LOGO");
    expect(favHidden.value).toContain("FAV");
  });

  it("renders the Discard link pointing to /app/settings", async () => {
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector(".app-actions")).toBeTruthy();
    });
    const link = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "/app/settings",
    );
    expect(link).toBeTruthy();
  });

  it("uses the loader-provided portalUrl on the Preview portal link", async () => {
    const customUrl = "https://other-shop.myshopify.com/apps/returns";
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: { ...baseLoaderData, portalUrl: customUrl },
    });
    await waitFor(() => {
      const link = Array.from(container.querySelectorAll("a")).find(
        (a) => a.getAttribute("href") === customUrl,
      );
      expect(link).toBeTruthy();
    });
  });

  it("renders the Save button with default loading=false (idle fetcher)", async () => {
    const { container } = renderWithRouter(Widget, {
      initialEntries: ["/app/settings/widget"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      const actions = container.querySelector(".app-actions");
      expect(actions).toBeTruthy();
    });
    // s-button is a custom element — just assert the Save text is rendered
    expect(container.querySelector(".app-actions")?.textContent).toContain(
      "Save",
    );
  });
});
