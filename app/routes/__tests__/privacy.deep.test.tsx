/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import PrivacyPolicy, { meta } from "../privacy";

describe("PrivacyPolicy — deep coverage", () => {
  it("renders the sticky nav with ReturnPro brand link to home", () => {
    const { container } = render(<PrivacyPolicy />);
    const nav = container.querySelector("nav.legal-nav");
    expect(nav).toBeTruthy();
    const brandLink = nav?.querySelector('a[href="/"]');
    expect(brandLink).toBeTruthy();
    expect(brandLink?.textContent).toMatch(/ReturnPro/);
    expect(nav?.querySelector(".legal-nav-icon")).toBeTruthy();
  });

  it("renders the effective date constant verbatim", () => {
    const { container } = render(<PrivacyPolicy />);
    const dateEl = container.querySelector(".legal-date");
    expect(dateEl?.textContent).toContain("March 24, 2026");
    expect(dateEl?.textContent).toMatch(/Effective date:/i);
  });

  it("renders all 10 numbered section headings in order", () => {
    const { container } = render(<PrivacyPolicy />);
    const headings = Array.from(container.querySelectorAll("h2")).map(
      (h) => h.textContent || "",
    );
    const expected = [
      "1. Information We Collect",
      "2. How We Use Information",
      "3. Data Storage and Security",
      "4. Data Sharing",
      "5. Data Retention",
      "6. GDPR and Data Subject Rights",
      "7. Cookies and Tracking",
      "8. Children's Privacy",
      "9. Changes to This Policy",
      "10. Contact Us",
    ];
    expect(headings).toHaveLength(10);
    for (let i = 0; i < expected.length; i++) {
      expect(headings[i]).toBe(expected[i]);
    }
  });

  it("renders the four Information We Collect bullet categories", () => {
    const { container } = render(<PrivacyPolicy />);
    const text = container.textContent || "";
    expect(text).toMatch(/Store information:/);
    expect(text).toMatch(/Order data:/);
    expect(text).toMatch(/Customer data:/);
    expect(text).toMatch(/Fynd integration data:/);
    // strong tags are used for these labels
    const strongs = Array.from(container.querySelectorAll("strong")).map(
      (n) => n.textContent || "",
    );
    expect(strongs).toEqual(
      expect.arrayContaining([
        "Store information:",
        "Order data:",
        "Customer data:",
        "Fynd integration data:",
      ]),
    );
  });

  it("renders the three GDPR-mandated webhooks list", () => {
    const { container } = render(<PrivacyPolicy />);
    // Locate the GDPR section's <ul> — it follows the introductory paragraph
    const gdprHeading = Array.from(container.querySelectorAll("h2")).find((h) =>
      /GDPR and Data Subject Rights/i.test(h.textContent || ""),
    );
    expect(gdprHeading).toBeTruthy();

    // Walk forward until we find the <ul> containing the webhook items
    let cursor: Element | null | undefined = gdprHeading?.nextElementSibling;
    let webhookList: HTMLUListElement | null = null;
    while (cursor) {
      if (cursor.tagName === "UL") {
        webhookList = cursor as HTMLUListElement;
        break;
      }
      if (cursor.tagName === "H2") break;
      cursor = cursor.nextElementSibling;
    }
    expect(webhookList).toBeTruthy();
    const items = Array.from(webhookList!.querySelectorAll("li")).map(
      (li) => li.textContent || "",
    );
    expect(items).toHaveLength(3);
    expect(items[0]).toMatch(/Customer data request/);
    expect(items[0]).toMatch(/compile all stored data/i);
    expect(items[1]).toMatch(/Customer data erasure/);
    expect(items[1]).toMatch(/anonymize or delete/i);
    expect(items[2]).toMatch(/Shop data erasure/);
    expect(items[2]).toMatch(/delete all data associated/i);
  });

  it("references shop/redact and customers/redact webhook codes in retention section", () => {
    const { container } = render(<PrivacyPolicy />);
    const codes = Array.from(container.querySelectorAll("code")).map(
      (c) => c.textContent || "",
    );
    expect(codes).toEqual(
      expect.arrayContaining(["shop/redact", "customers/redact"]),
    );
  });

  it("renders the contact links — privacy email and external Fynd site", () => {
    const { container } = render(<PrivacyPolicy />);
    const mailto = container.querySelector(
      'a[href="mailto:privacy@fynd.com"]',
    );
    expect(mailto).toBeTruthy();
    expect(mailto?.textContent).toBe("privacy@fynd.com");

    const fyndSite = container.querySelector('a[href="https://www.fynd.com"]');
    expect(fyndSite).toBeTruthy();
    expect(fyndSite?.getAttribute("target")).toBe("_blank");
    expect(fyndSite?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("documents data security primitives (AES-256, JWT, HTTPS/TLS, PostgreSQL)", () => {
    const { container } = render(<PrivacyPolicy />);
    const text = container.textContent || "";
    expect(text).toMatch(/PostgreSQL/);
    expect(text).toMatch(/AES-256/);
    expect(text).toMatch(/JWT/);
    expect(text).toMatch(/HTTPS\/TLS/);
    expect(text).toMatch(/least privilege/i);
  });

  it("includes embedded styles and applies the legal-page wrapper class", () => {
    const { container } = render(<PrivacyPolicy />);
    const root = container.querySelector(".legal-page");
    expect(root).toBeTruthy();
    const style = root?.querySelector("style");
    expect(style).toBeTruthy();
    const css = style?.textContent || "";
    // sanity check a few of the hand-authored rules
    expect(css).toMatch(/\.legal-nav/);
    expect(css).toMatch(/\.legal-content/);
    expect(css).toMatch(/prefers-color-scheme: dark/);
    expect(css).toMatch(/@media \(max-width: 768px\)/);
  });
});

describe("PrivacyPolicy — meta", () => {
  it("returns title containing ReturnPro by Fynd and a description", () => {
    const result = meta({} as never) as Array<Record<string, unknown>>;
    const titleEntry = result.find((m) => "title" in m);
    const descEntry = result.find((m) => m.name === "description");
    expect(titleEntry?.title).toBe("Privacy Policy — ReturnPro by Fynd");
    expect(typeof descEntry?.content).toBe("string");
    expect(String(descEntry?.content)).toMatch(/ReturnPro/);
    expect(String(descEntry?.content)).toMatch(/Fynd Returns/);
  });
});
