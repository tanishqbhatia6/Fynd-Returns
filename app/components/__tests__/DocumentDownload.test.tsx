/** @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { DocumentDownload, DocumentDownloadGroup } from "../DocumentDownload";

describe("<DocumentDownload />", () => {
  it("renders the label for each kind by default", () => {
    const { rerender } = render(<DocumentDownload url="https://x" kind="label" />);
    expect(screen.getByText("Return label")).toBeTruthy();
    rerender(<DocumentDownload url="https://x" kind="invoice" />);
    expect(screen.getByText("Invoice")).toBeTruthy();
    rerender(<DocumentDownload url="https://x" kind="qr" />);
    expect(screen.getByText("QR code")).toBeTruthy();
    rerender(<DocumentDownload url="https://x" kind="tracking" />);
    expect(screen.getByText("Tracking")).toBeTruthy();
    rerender(<DocumentDownload url="https://x" kind="other" />);
    expect(screen.getByText("Document")).toBeTruthy();
  });

  it("respects the label override", () => {
    render(<DocumentDownload url="https://x" kind="label" label="AWB-1 PDF" />);
    expect(screen.getByText("AWB-1 PDF")).toBeTruthy();
  });

  it("renders hint text when given", () => {
    render(<DocumentDownload url="https://x" kind="invoice" hint="2 pages • 142 KB" />);
    expect(screen.getByText("2 pages • 142 KB")).toBeTruthy();
  });

  it("opens in a new tab and is download-safe", () => {
    const { container } = render(<DocumentDownload url="https://example.test/x.pdf" />);
    const a = container.querySelector("a")!;
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener noreferrer");
    expect(a.hasAttribute("download")).toBe(true);
    expect(a.getAttribute("href")).toBe("https://example.test/x.pdf");
  });

  it("renders neutral tone with grey palette instead of brand-green", () => {
    const { container } = render(<DocumentDownload url="https://x" tone="neutral" />);
    const a = container.querySelector("a") as HTMLElement;
    // neutral fg is #475569, neutral border is #e2e8f0
    expect(a.style.color).toBe("rgb(71, 85, 105)");
    expect(a.style.border).toContain("rgb(226, 232, 240)");
    const iconWrap = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    // neutral icon background is #f1f5f9
    expect(iconWrap.style.background).toBe("rgb(241, 245, 249)");
  });
});

describe("<DocumentDownloadGroup />", () => {
  it("renders empty hint when documents list is empty", () => {
    render(<DocumentDownloadGroup documents={[]} emptyHint="Nothing yet" />);
    expect(screen.getByText("Nothing yet")).toBeTruthy();
  });

  it("filters out null and url-less entries before rendering", () => {
    const { container } = render(
      <DocumentDownloadGroup
        documents={[
          { url: "https://a", kind: "label" },
          null,
          { url: "", kind: "invoice" },
          { url: "https://b", kind: "qr" },
        ]}
      />,
    );
    expect(container.querySelectorAll("a")).toHaveLength(2);
  });

  it("renders a custom heading", () => {
    render(<DocumentDownloadGroup heading="Return paperwork" documents={[]} />);
    expect(screen.getByText("Return paperwork")).toBeTruthy();
  });

  it("hides heading entirely when heading prop is empty string", () => {
    const { queryByText } = render(<DocumentDownloadGroup heading="" documents={[]} />);
    // Default heading "Documents" must not appear
    expect(queryByText("Documents")).toBeNull();
  });
});
