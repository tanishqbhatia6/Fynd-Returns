/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import PrivacyPolicy, { meta } from "../privacy";

describe("PrivacyPolicy page", () => {
  it("renders the legal content", () => {
    const { getByText, container } = render(<PrivacyPolicy />);
    // h1 has the heading text; the document <title> does too — match the h1 specifically.
    expect(container.querySelector("h1")?.textContent).toMatch(/Privacy Policy/i);
    expect(getByText(/Effective date:/i)).toBeTruthy();
    expect(container.querySelector("nav.legal-nav")).toBeTruthy();
  });

  it("renders all 10 numbered sections", () => {
    const { container } = render(<PrivacyPolicy />);
    const headings = container.querySelectorAll("h2");
    expect(headings.length).toBeGreaterThanOrEqual(10);
  });

  it("links to the privacy contact email", () => {
    const { container } = render(<PrivacyPolicy />);
    const link = container.querySelector('a[href="mailto:privacy@fynd.com"]');
    expect(link).toBeTruthy();
  });
});

describe("meta", () => {
  it("returns title + description meta tags", () => {
    const result = meta({} as never);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: expect.stringContaining("Privacy") }),
      expect.objectContaining({ name: "description" }),
    ]));
  });
});
