/**
 * email-template-preview substitution helper.
 */
import { describe, it, expect } from "vitest";
import { renderEmailPreview } from "../email-template-preview";

const SAMPLE = {
  orderName: "#1023",
  customerEmail: "jane@example.com",
  shopName: "Acme",
  returnId: "RPM-A1B2",
  status: "Approved",
  refundAmount: "$129.00",
};

describe("renderEmailPreview", () => {
  it("substitutes a single token", () => {
    expect(renderEmailPreview("Hello {{customerEmail}}", SAMPLE)).toBe(
      "Hello jane@example.com",
    );
  });

  it("substitutes multiple tokens including duplicates", () => {
    const out = renderEmailPreview(
      "{{orderName}} for {{customerEmail}} — order {{orderName}}",
      SAMPLE,
    );
    expect(out).toBe("#1023 for jane@example.com — order #1023");
  });

  it("tolerates whitespace inside the braces", () => {
    expect(renderEmailPreview("Order {{ orderName }}", SAMPLE)).toBe("Order #1023");
    expect(renderEmailPreview("Order {{   orderName   }}", SAMPLE)).toBe("Order #1023");
  });

  it("leaves unknown tokens untouched (so merchants spot typos)", () => {
    expect(renderEmailPreview("Hello {{misspeled}}", SAMPLE)).toBe("Hello {{misspeled}}");
  });

  it("does not substitute partial / malformed tokens", () => {
    expect(renderEmailPreview("Hello {orderName}", SAMPLE)).toBe("Hello {orderName}");
    expect(renderEmailPreview("Hello {{orderName", SAMPLE)).toBe("Hello {{orderName");
    expect(renderEmailPreview("Hello orderName}}", SAMPLE)).toBe("Hello orderName}}");
  });

  it("returns the input unchanged when no tokens are present", () => {
    expect(renderEmailPreview("Plain text email", SAMPLE)).toBe("Plain text email");
  });

  it("handles an empty input string", () => {
    expect(renderEmailPreview("", SAMPLE)).toBe("");
  });

  it("does not look up inherited Object.prototype keys (security)", () => {
    // {{toString}} is on Object.prototype but is NOT in our sample dictionary;
    // a naive `data[key]` lookup would return Object.prototype.toString.
    // The helper must use hasOwnProperty so polluted prototypes can't be
    // injected into preview output.
    expect(renderEmailPreview("Hello {{toString}}", SAMPLE)).toBe("Hello {{toString}}");
    expect(renderEmailPreview("Hello {{constructor}}", SAMPLE)).toBe("Hello {{constructor}}");
  });

  it("preserves HTML in the body around tokens", () => {
    const tpl = '<p>Hi {{customerEmail}}, your refund of <strong>{{refundAmount}}</strong> is on the way.</p>';
    const out = renderEmailPreview(tpl, SAMPLE);
    expect(out).toBe(
      '<p>Hi jane@example.com, your refund of <strong>$129.00</strong> is on the way.</p>',
    );
  });

  it("does not match tokens whose key starts with a digit", () => {
    expect(renderEmailPreview("{{1bad}}", { "1bad": "x" })).toBe("{{1bad}}");
  });

  it("handles tokens with underscores in the key", () => {
    expect(
      renderEmailPreview("Refund: {{refund_amount}}", { refund_amount: "$50" }),
    ).toBe("Refund: $50");
  });
});
