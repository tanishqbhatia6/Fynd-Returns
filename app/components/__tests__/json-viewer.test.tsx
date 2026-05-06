/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { JsonNode, PayloadViewer } from "../json-viewer";

describe("JsonNode primitives", () => {
  it("renders null with purple color", () => {
    const { container } = render(<JsonNode value={null} depth={0} />);
    expect(container.textContent).toContain("null");
    const span = container.querySelector("span");
    expect(span).toBeTruthy();
  });

  it("renders boolean true", () => {
    const { container } = render(<JsonNode value={true} depth={0} />);
    expect(container.textContent).toContain("true");
  });

  it("renders boolean false", () => {
    const { container } = render(<JsonNode value={false} depth={0} />);
    expect(container.textContent).toContain("false");
  });

  it("renders a number", () => {
    const { container } = render(<JsonNode value={42} depth={0} />);
    expect(container.textContent).toContain("42");
  });

  it("renders a zero number", () => {
    const { container } = render(<JsonNode value={0} depth={0} />);
    expect(container.textContent).toContain("0");
  });

  it("renders a short string with quotes", () => {
    const { container } = render(<JsonNode value="hello" depth={0} />);
    expect(container.textContent).toContain("hello");
    // Quoted with HTML entities -> rendered as actual quotes
    expect(container.textContent).toMatch(/"hello"/);
  });

  it("truncates a string longer than 120 chars", () => {
    const long = "a".repeat(200);
    const { container } = render(<JsonNode value={long} depth={0} />);
    expect(container.textContent).toContain("...");
    expect(container.textContent).toContain("a".repeat(120));
    expect(container.textContent).not.toContain("a".repeat(121));
  });

  it("renders the key label when k is provided", () => {
    const { container } = render(<JsonNode k="myKey" value="v" depth={0} />);
    expect(container.textContent).toContain("myKey");
    expect(container.textContent).toContain(": ");
  });

  it("does not render the colon when no key is provided", () => {
    const { container } = render(<JsonNode value="just-value" depth={0} />);
    // No leading "<key>: " — output should start with the quoted value span
    expect(container.textContent?.trim().startsWith(": ")).toBe(false);
  });

  it("renders unknown types via String() fallback (e.g. undefined)", () => {
    // undefined intentionally hits the final fallback branch
    const { container } = render(<JsonNode value={undefined as unknown as null} depth={0} />);
    expect(container.textContent).toContain("undefined");
  });
});

describe("JsonNode arrays", () => {
  it("renders empty array placeholder []", () => {
    const { container } = render(<JsonNode value={[]} depth={0} />);
    expect(container.textContent).toContain("[]");
  });

  it("shows length and is open by default at depth 0", () => {
    const { container, getByRole } = render(<JsonNode value={[1, 2, 3]} depth={0} />);
    const btn = getByRole("button");
    expect(btn.textContent).toContain("[3]");
    // open by default at depth 0 -> children rendered
    expect(container.textContent).toContain("1");
    expect(container.textContent).toContain("2");
    expect(container.textContent).toContain("3");
  });

  it("is collapsed by default at depth >= 1", () => {
    const { container, getByRole } = render(<JsonNode value={[10, 20]} depth={1} />);
    const btn = getByRole("button");
    expect(btn.textContent).toContain("▸");
    // children not rendered when collapsed
    expect(container.textContent).not.toContain("10");
  });

  it("toggles open/closed when the button is clicked", () => {
    const { container, getByRole } = render(<JsonNode value={[7, 8]} depth={0} />);
    const btn = getByRole("button");
    expect(btn.textContent).toContain("▾");
    fireEvent.click(btn);
    expect(btn.textContent).toContain("▸");
    expect(container.textContent).not.toContain("7");
    fireEvent.click(btn);
    expect(btn.textContent).toContain("▾");
    expect(container.textContent).toContain("7");
  });

  it("renders nested arrays recursively", () => {
    const { container } = render(<JsonNode value={[[1, 2]]} depth={0} />);
    // outer open by default; inner collapsed (depth 1)
    expect(container.textContent).toContain("[1]");
    expect(container.textContent).toContain("[2]");
  });
});

describe("JsonNode objects", () => {
  it("renders empty object placeholder {}", () => {
    const { container } = render(<JsonNode value={{}} depth={0} />);
    expect(container.textContent).toContain("{}");
  });

  it("shows entry count and renders keys when open", () => {
    const obj = { a: 1, b: "x" };
    const { container, getByRole } = render(<JsonNode value={obj} depth={0} />);
    const btn = getByRole("button");
    expect(btn.textContent).toContain("{");
    expect(btn.textContent).toContain("2");
    expect(container.textContent).toContain("a");
    expect(container.textContent).toContain("b");
  });

  it("is collapsed at depth >= 1", () => {
    const { container } = render(<JsonNode value={{ a: 1 }} depth={1} />);
    expect(container.textContent).not.toContain("a");
  });

  it("toggles object expand/collapse on button click", () => {
    const { container, getByRole } = render(<JsonNode value={{ x: 99 }} depth={0} />);
    const btn = getByRole("button");
    expect(container.textContent).toContain("99");
    fireEvent.click(btn);
    expect(container.textContent).not.toContain("99");
    fireEvent.click(btn);
    expect(container.textContent).toContain("99");
  });

  it("renders deeply nested objects with depth-based collapse", () => {
    const v = { outer: { inner: { leaf: 1 } } };
    const { container } = render(<JsonNode value={v} depth={0} />);
    // outer open, inner collapsed -> "leaf" not visible until expanded
    expect(container.textContent).toContain("outer");
    expect(container.textContent).not.toContain("leaf");
  });
});

describe("PayloadViewer toolbar + modes", () => {
  beforeEach(() => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined),
      },
    });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders 'No payload' when rawPayload is null", () => {
    const { container } = render(<PayloadViewer rawPayload={null} />);
    expect(container.textContent).toContain("No payload");
  });

  it("renders default title 'Payload' when no title prop given", () => {
    const { container } = render(<PayloadViewer rawPayload={"{}"} />);
    expect(container.textContent).toContain("Payload");
  });

  it("renders the custom title when provided", () => {
    const { container } = render(<PayloadViewer rawPayload={"{}"} title="My Title" />);
    expect(container.textContent).toContain("My Title");
  });

  it("renders Tree mode by default with parsed JSON", () => {
    const { container } = render(<PayloadViewer rawPayload={'{"k":"v"}'} />);
    expect(container.textContent).toContain("k");
    expect(container.textContent).toContain("v");
  });

  it("switches to Pretty/formatted mode when its button is clicked", () => {
    const { container, getByText } = render(<PayloadViewer rawPayload={'{"x":1}'} />);
    fireEvent.click(getByText("Pretty"));
    const pre = container.querySelector("pre");
    expect(pre).toBeTruthy();
    expect(pre?.textContent).toContain('"x"');
    expect(pre?.textContent).toContain("1");
  });

  it("switches to Raw mode when its button is clicked", () => {
    const raw = '{"raw":true}';
    const { container, getByText } = render(<PayloadViewer rawPayload={raw} />);
    fireEvent.click(getByText("Raw"));
    const pre = container.querySelector("pre");
    expect(pre).toBeTruthy();
    // raw view shows pretty-formatted text since payload is valid JSON
    expect(pre?.textContent).toContain("raw");
  });

  it("shows truncation warning in Raw mode for invalid JSON", () => {
    const { container, getByText } = render(<PayloadViewer rawPayload={"{not json"} />);
    fireEvent.click(getByText("Raw"));
    expect(container.textContent).toContain("truncated");
  });

  it("falls back to Raw rendering when JSON is invalid even in Tree mode", () => {
    // Tree mode + invalid -> falls through to the raw <pre> branch
    const { container } = render(<PayloadViewer rawPayload={"not-json"} />);
    expect(container.querySelector("pre")).toBeTruthy();
    expect(container.textContent).toContain("truncated");
  });

  it("falls back to Raw rendering when Pretty mode + invalid JSON", () => {
    const { container, getByText } = render(<PayloadViewer rawPayload={"oops"} />);
    fireEvent.click(getByText("Pretty"));
    expect(container.textContent).toContain("truncated");
  });

  it("highlights the active mode button", () => {
    const { getByText } = render(<PayloadViewer rawPayload={"{}"} />);
    const treeBtn = getByText("Tree") as HTMLButtonElement;
    expect(treeBtn.style.background).toContain("rgb(59, 130, 246)");
    fireEvent.click(getByText("Pretty"));
    const prettyBtn = getByText("Pretty") as HTMLButtonElement;
    expect(prettyBtn.style.background).toContain("rgb(59, 130, 246)");
  });
});

describe("PayloadViewer search", () => {
  it("filters Pretty-mode lines that match the search term (case-insensitive)", () => {
    const payload = JSON.stringify({ apple: 1, banana: 2, cherry: 3 });
    const { container, getByPlaceholderText, getByText } = render(
      <PayloadViewer rawPayload={payload} />,
    );
    fireEvent.click(getByText("Pretty"));
    const input = getByPlaceholderText("Search...") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "BANANA" } });
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toContain("banana");
    expect(pre?.textContent).not.toContain("apple");
    expect(pre?.textContent).not.toContain("cherry");
  });

  it("filters Raw-mode display by search term", () => {
    const payload = JSON.stringify({ alpha: 10, beta: 20 });
    const { container, getByPlaceholderText, getByText } = render(
      <PayloadViewer rawPayload={payload} />,
    );
    fireEvent.click(getByText("Raw"));
    const input = getByPlaceholderText("Search...") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "alpha" } });
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toContain("alpha");
    expect(pre?.textContent).not.toContain("beta");
  });

  it("clearing the search restores full display", () => {
    const payload = JSON.stringify({ alpha: 10, beta: 20 });
    const { container, getByPlaceholderText, getByText } = render(
      <PayloadViewer rawPayload={payload} />,
    );
    fireEvent.click(getByText("Pretty"));
    const input = getByPlaceholderText("Search...") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "alpha" } });
    fireEvent.change(input, { target: { value: "" } });
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toContain("alpha");
    expect(pre?.textContent).toContain("beta");
  });
});

describe("PayloadViewer copy-to-clipboard", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("calls navigator.clipboard.writeText and shows 'Copied!' then reverts", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    const raw = '{"a":1}';
    const { getByText } = render(<PayloadViewer rawPayload={raw} />);
    const btn = getByText("Copy");

    await act(async () => {
      fireEvent.click(btn);
      // flush the resolved promise
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalledWith(raw);
    expect(getByText("Copied!")).toBeTruthy();

    await act(async () => {
      vi.advanceTimersByTime(1600);
    });
    expect(getByText("Copy")).toBeTruthy();
  });

  it("silently handles clipboard.writeText rejection", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.assign(navigator, { clipboard: { writeText } });

    const { getByText, queryByText } = render(<PayloadViewer rawPayload={"{}"} />);
    const btn = getByText("Copy");

    await act(async () => {
      fireEvent.click(btn);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(writeText).toHaveBeenCalled();
    // never showed "Copied!" because the promise rejected
    expect(queryByText("Copied!")).toBeNull();
  });
});

describe("PayloadViewer large arrays + syntax highlighting", () => {
  it("renders a large array with all entries (no virtualization, but no crash)", () => {
    const arr = Array.from({ length: 50 }, (_, i) => i);
    const payload = JSON.stringify(arr);
    const { container } = render(<PayloadViewer rawPayload={payload} />);
    // Tree-mode default: outer array open at depth 0 -> all 50 leaves rendered
    expect(container.textContent).toContain("[50]");
    expect(container.textContent).toContain("0");
    expect(container.textContent).toContain("49");
  });

  it("applies type-specific colors via inline style on spans", () => {
    const { container } = render(
      <JsonNode value={{ s: "abc", n: 1, b: true, z: null }} depth={0} />,
    );
    const html = container.innerHTML;
    // jsdom normalizes inline style hex colors -> rgb()
    expect(html).toContain("rgb(248, 113, 113)"); // string red #F87171
    expect(html).toContain("rgb(16, 185, 129)"); // number green #10B981
    expect(html).toContain("rgb(245, 158, 11)"); // boolean amber #F59E0B
    expect(html).toContain("rgb(167, 139, 250)"); // null purple #A78BFA
    expect(html).toContain("rgb(147, 197, 253)"); // key blue #93C5FD
  });

  it("uses monospace font in JsonNode rows", () => {
    const { container } = render(<JsonNode value={1} depth={0} />);
    const row = container.firstElementChild as HTMLElement;
    expect(row.style.fontFamily).toMatch(/Menlo|SF Mono|Consolas|monospace/);
  });
});
