/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import TermsOfService, { meta } from "../terms";

describe("TermsOfService page", () => {
  it("renders the heading + effective date", () => {
    const { container, getByText } = render(<TermsOfService />);
    expect(container.querySelector("h1")?.textContent).toMatch(/Terms of Service/i);
    expect(getByText(/Effective date:/i)).toBeTruthy();
  });

  it("renders multiple sections (h2 headings)", () => {
    const { container } = render(<TermsOfService />);
    expect(container.querySelectorAll("h2").length).toBeGreaterThan(5);
  });

  it("renders the legal-nav with brand link", () => {
    const { container } = render(<TermsOfService />);
    const navAnchor = container.querySelector("nav.legal-nav a");
    expect(navAnchor?.getAttribute("href")).toBe("/");
  });
});

describe("meta", () => {
  it("returns title + description meta entries", () => {
    const result = meta({} as never);
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ title: expect.stringMatching(/Terms/i) }),
      expect.objectContaining({ name: "description" }),
    ]));
  });
});
