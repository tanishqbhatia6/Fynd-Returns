/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import TermsOfService, { meta } from "../terms";

describe("TermsOfService deep coverage", () => {
  it("renders exactly one semantic h1 with Terms of Service text", () => {
    const { container } = render(<TermsOfService />);
    const h1s = container.querySelectorAll("h1");
    expect(h1s.length).toBe(1);
    expect(h1s[0].textContent).toMatch(/Terms of Service/i);
  });

  it("renders all 13 numbered legal sections as h2 headings", () => {
    const { container } = render(<TermsOfService />);
    const h2s = Array.from(container.querySelectorAll("h2")).map(
      (h) => h.textContent?.trim() ?? "",
    );
    expect(h2s.length).toBe(13);
    expect(h2s).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/1\.\s*Service Description/i),
        expect.stringMatching(/2\.\s*Account and Installation/i),
        expect.stringMatching(/3\.\s*Acceptable Use/i),
        expect.stringMatching(/4\.\s*Data and Privacy/i),
        expect.stringMatching(/5\.\s*Intellectual Property/i),
        expect.stringMatching(/6\.\s*Third-Party Services/i),
        expect.stringMatching(/7\.\s*Availability and Support/i),
        expect.stringMatching(/8\.\s*Limitation of Liability/i),
        expect.stringMatching(/9\.\s*Indemnification/i),
        expect.stringMatching(/10\.\s*Termination/i),
        expect.stringMatching(/11\.\s*Modifications/i),
        expect.stringMatching(/12\.\s*Governing Law/i),
        expect.stringMatching(/13\.\s*Contact/i),
      ]),
    );
  });

  it("displays the hard-coded effective date", () => {
    const { getByText } = render(<TermsOfService />);
    expect(getByText(/Effective date:\s*March 24, 2026/i)).toBeTruthy();
  });

  it("includes a link to the Privacy Policy in the Data and Privacy section", () => {
    const { container } = render(<TermsOfService />);
    const privacyLink = container.querySelector('a[href="/privacy"]');
    expect(privacyLink).toBeTruthy();
    expect(privacyLink?.textContent).toMatch(/Privacy Policy/i);
  });

  it("includes a mailto legal contact link and external Fynd website link with safe rel attributes", () => {
    const { container } = render(<TermsOfService />);
    const mailto = container.querySelector('a[href="mailto:legal@fynd.com"]');
    expect(mailto).toBeTruthy();

    const external = container.querySelector('a[href="https://www.fynd.com"]');
    expect(external).toBeTruthy();
    expect(external?.getAttribute("target")).toBe("_blank");
    const rel = external?.getAttribute("rel") ?? "";
    expect(rel).toContain("noopener");
    expect(rel).toContain("noreferrer");
  });

  it("renders bullet lists in Account, Acceptable Use, Availability, and Termination sections", () => {
    const { container } = render(<TermsOfService />);
    const lists = container.querySelectorAll(".legal-content ul");
    // Sections 2, 3, 7, 10 use <ul>
    expect(lists.length).toBe(4);
    // every list should contain at least one li
    lists.forEach((ul) => {
      expect(ul.querySelectorAll("li").length).toBeGreaterThan(0);
    });
  });

  it("mentions key legal/business entities and obligations across the document", () => {
    const { container } = render(<TermsOfService />);
    const text = container.textContent ?? "";
    expect(text).toMatch(/Shopsense Retail Technologies Ltd\./i);
    expect(text).toMatch(/Shopify/i);
    expect(text).toMatch(/Fynd OMS/i);
    expect(text).toMatch(/India/i);
    expect(text).toMatch(/Mumbai/i);
    expect(text).toMatch(/99\.9% uptime/i);
    expect(text).toMatch(/48 hours after uninstall/i);
  });

  it("wraps content in a top-level legal-page container with sticky nav and main content region", () => {
    const { container } = render(<TermsOfService />);
    expect(container.querySelector(".legal-page")).toBeTruthy();
    expect(container.querySelector("nav.legal-nav")).toBeTruthy();
    expect(container.querySelector(".legal-content")).toBeTruthy();
  });

  it("nav brand link points to root and includes a decorative icon", () => {
    const { container } = render(<TermsOfService />);
    const anchor = container.querySelector("nav.legal-nav a");
    expect(anchor?.getAttribute("href")).toBe("/");
    expect(anchor?.textContent).toMatch(/ReturnPro/i);
    expect(anchor?.querySelector(".legal-nav-icon")).toBeTruthy();
  });

  it("meta() returns the expected title and description strings", () => {
    const result = meta({} as never) as Array<Record<string, string>>;
    const title = result.find((m) => "title" in m);
    const description = result.find((m) => m.name === "description");
    expect(title?.title).toBe("Terms of Service — ReturnPro by Fynd");
    expect(description?.content).toMatch(/ReturnPro/i);
    expect(description?.content).toMatch(/Fynd Returns/i);
  });
});
