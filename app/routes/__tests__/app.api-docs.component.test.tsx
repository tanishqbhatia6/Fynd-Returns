/**
 * @vitest-environment jsdom
 */
import React from "react";
import { describe, it, expect, vi } from "vitest";

// ── Mocks for module-top-level imports in app/routes/app.api-docs.tsx ──
// The component pulls in shopify.server purely for the loader; stub it so
// importing the component in jsdom doesn't crash on Node-only deps.
vi.mock("../shopify.server", () => ({
  default: {},
  authenticate: { admin: vi.fn() },
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

import { renderWithRouter } from "../../test/component-helpers";
import { waitFor, fireEvent } from "@testing-library/react";
import ApiDocs from "../app.api-docs";
import type { ApiEndpointDef } from "../../lib/api-docs-data";

const sampleEndpoints: ApiEndpointDef[] = [
  {
    method: "GET",
    path: "/api/v1/external/returns",
    name: "List Returns",
    description: "Retrieve a paginated list of return cases.",
    permission: "read_returns",
    folder: "Returns",
    queryParams: [
      { key: "page", description: "Page number", example: "1" },
      { key: "pageSize", description: "Items per page", example: "25" },
    ],
    responseExample: {
      data: [{ id: "clxyz123", returnRequestNo: "RPM-A1B2C3D4" }],
      meta: { page: 1, pageSize: 25, totalCount: 1 },
    },
    errorCodes: [
      { status: 401, code: "UNAUTHORIZED", when: "Missing or invalid API key" },
      { status: 429, code: "RATE_LIMITED", when: "Too many requests" },
    ],
  },
  {
    method: "POST",
    path: "/api/v1/external/returns/:id/approve",
    name: "Approve Return",
    description: "Approve a pending return case.",
    permission: "write_returns",
    folder: "Returns",
    requestBody: {
      description: "Optional approval note",
      example: { note: "Approved by ERP system" },
    },
    responseExample: { data: { id: "clxyz123", status: "approved" } },
    errorCodes: [
      { status: 403, code: "FORBIDDEN", when: "API key lacks write_returns" },
    ],
  },
  {
    method: "DELETE",
    path: "/api/v1/external/webhooks/:id",
    name: "Delete Webhook",
    description: "Remove a registered webhook subscription.",
    permission: "manage_webhooks",
    folder: "Webhooks",
    responseExample: { data: { ok: true } },
    errorCodes: [],
  },
];

const baseLoaderData = {
  endpoints: sampleEndpoints,
  baseUrl: "https://example.myshopify.com",
};

describe("ApiDocs (default export)", () => {
  it("renders the page heading and base URL", async () => {
    const { container, findByText } = renderWithRouter(ApiDocs, {
      initialEntries: ["/app/api-docs"],
      loaderData: baseLoaderData,
    });
    expect(await findByText("API Documentation")).toBeTruthy();
    await waitFor(() => {
      expect(container.textContent).toContain("https://example.myshopify.com");
    });
  });

  it("renders an endpoint card for each endpoint with its method and path", async () => {
    const { container } = renderWithRouter(ApiDocs, {
      initialEntries: ["/app/api-docs"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("/api/v1/external/returns");
    });
    expect(container.textContent).toContain(
      "/api/v1/external/returns/:id/approve",
    );
    expect(container.textContent).toContain("/api/v1/external/webhooks/:id");

    // Method badges visible in the collapsed header for each row.
    const methodBadges = Array.from(container.querySelectorAll("span")).filter(
      (s) =>
        s.textContent === "GET" ||
        s.textContent === "POST" ||
        s.textContent === "DELETE",
    );
    expect(methodBadges.length).toBeGreaterThanOrEqual(3);
  });

  it("groups endpoints by folder header", async () => {
    const { container } = renderWithRouter(ApiDocs, {
      initialEntries: ["/app/api-docs"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("Returns");
    });
    expect(container.textContent).toContain("Webhooks");
  });

  it("renders endpoint names in the collapsed header rows", async () => {
    const { container } = renderWithRouter(ApiDocs, {
      initialEntries: ["/app/api-docs"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.textContent).toContain("List Returns");
    });
    expect(container.textContent).toContain("Approve Return");
    expect(container.textContent).toContain("Delete Webhook");
  });

  it("expands the endpoint card on click and shows description + permission", async () => {
    const { container } = renderWithRouter(ApiDocs, {
      initialEntries: ["/app/api-docs"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("button")).toBeTruthy();
    });

    // Find the toggle button for "List Returns".
    const buttons = Array.from(container.querySelectorAll("button"));
    const listBtn = buttons.find((b) =>
      b.textContent?.includes("/api/v1/external/returns"),
    );
    expect(listBtn).toBeTruthy();

    // Permission badge is hidden until expanded.
    expect(container.textContent).not.toContain("Permission: read_returns");

    fireEvent.click(listBtn!);

    await waitFor(() => {
      expect(container.textContent).toContain(
        "Retrieve a paginated list of return cases.",
      );
    });
    expect(container.textContent).toContain("Permission: read_returns");
    expect(container.textContent).toContain("Query Parameters");
  });

  it("renders the request-body block only for endpoints that define one", async () => {
    const { container } = renderWithRouter(ApiDocs, {
      initialEntries: ["/app/api-docs"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("button")).toBeTruthy();
    });

    const buttons = Array.from(container.querySelectorAll("button"));
    const approveBtn = buttons.find((b) =>
      b.textContent?.includes("/approve"),
    );
    expect(approveBtn).toBeTruthy();

    fireEvent.click(approveBtn!);

    await waitFor(() => {
      expect(container.textContent).toContain("Request Body");
    });
    expect(container.textContent).toContain("Permission: write_returns");
    expect(container.textContent).toContain("Approved by ERP system");
  });

  it("shows error-code rows when present and omits the table when empty", async () => {
    const { container } = renderWithRouter(ApiDocs, {
      initialEntries: ["/app/api-docs"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(container.querySelector("button")).toBeTruthy();
    });

    const buttons = Array.from(container.querySelectorAll("button"));
    const listBtn = buttons.find((b) =>
      b.textContent?.includes("/api/v1/external/returns") &&
      !b.textContent?.includes("/approve"),
    );
    fireEvent.click(listBtn!);

    await waitFor(() => {
      expect(container.textContent).toContain("Error Codes");
    });
    expect(container.textContent).toContain("UNAUTHORIZED");
    expect(container.textContent).toContain("RATE_LIMITED");

    // Now expand the DELETE endpoint, which has errorCodes: [] — no
    // "Error Codes" heading should appear inside that card. Easiest
    // assertion: the card text does not contain "Error Codes" twice.
    const deleteBtn = buttons.find((b) =>
      b.textContent?.includes("/api/v1/external/webhooks/:id"),
    );
    fireEvent.click(deleteBtn!);

    await waitFor(() => {
      expect(container.textContent).toContain("Remove a registered webhook");
    });
    // The DELETE card itself must not include the "Error Codes" heading.
    const deleteCard = deleteBtn!.parentElement;
    expect(deleteCard?.textContent).not.toContain("Error Codes");
  });

  it("links to the Postman collection using the loader baseUrl", async () => {
    const { container } = renderWithRouter(ApiDocs, {
      initialEntries: ["/app/api-docs"],
      loaderData: baseLoaderData,
    });
    await waitFor(() => {
      expect(
        container.querySelector(
          "a[href='https://example.myshopify.com/api/v1/external/postman']",
        ),
      ).toBeTruthy();
    });
    // "Manage API Keys" navigation link is also present.
    const manageLink = Array.from(container.querySelectorAll("a")).find(
      (a) => a.getAttribute("href") === "/app/settings/api-keys",
    );
    expect(manageLink).toBeTruthy();
  });
});
