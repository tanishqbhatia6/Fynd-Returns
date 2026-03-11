/**
 * Endpoint definition registry for external API.
 * Used by both the admin API docs page and the Postman collection generator.
 */

export interface ApiEndpointDef {
  method: "GET" | "POST" | "DELETE";
  path: string;
  name: string;
  description: string;
  permission: string;
  folder: string;
  queryParams?: { key: string; description: string; example: string }[];
  requestBody?: { description: string; example: Record<string, unknown> };
  responseExample: Record<string, unknown>;
  errorCodes: { status: number; code: string; when: string }[];
}

export const EXTERNAL_API_ENDPOINTS: ApiEndpointDef[] = [
  // ── Returns ──
  {
    method: "GET",
    path: "/api/v1/external/returns",
    name: "List Returns",
    description: "Retrieve a paginated list of return cases for your shop. Supports filtering by status, date range, order name, and customer email.",
    permission: "read_returns",
    folder: "Returns",
    queryParams: [
      { key: "page", description: "Page number (default: 1)", example: "1" },
      { key: "pageSize", description: "Items per page (default: 25, max: 100)", example: "25" },
      { key: "status", description: "Filter by status: pending, approved, rejected, completed, cancelled, processing", example: "pending" },
      { key: "createdAfter", description: "ISO 8601 date — returns created after this date", example: "2026-01-01T00:00:00Z" },
      { key: "createdBefore", description: "ISO 8601 date — returns created before this date", example: "2026-12-31T23:59:59Z" },
      { key: "orderName", description: "Filter by Shopify order name (partial match, case-insensitive)", example: "#1001" },
      { key: "customerEmail", description: "Filter by customer email (partial match)", example: "john@example.com" },
    ],
    responseExample: {
      data: [
        {
          id: "clxyz123",
          returnRequestNo: "RPM-A1B2C3D4",
          shopifyOrderId: "gid://shopify/Order/12345",
          shopifyOrderName: "#1001",
          status: "pending",
          resolutionType: "refund",
          customerName: "John Doe",
          customerEmail: "john@example.com",
          currency: "USD",
          itemCount: 2,
          createdAt: "2026-03-10T14:30:00Z",
          updatedAt: "2026-03-10T15:00:00Z",
        },
      ],
      meta: { page: 1, pageSize: 25, totalCount: 42, totalPages: 2, hasNextPage: true },
      errors: [],
    },
    errorCodes: [
      { status: 401, code: "UNAUTHORIZED", when: "Missing or invalid API key" },
      { status: 403, code: "FORBIDDEN", when: "API key lacks read_returns permission" },
      { status: 429, code: "RATE_LIMITED", when: "Too many requests" },
    ],
  },
  {
    method: "GET",
    path: "/api/v1/external/returns/:id",
    name: "Get Return Detail",
    description: "Retrieve full details for a single return case, including line items and event history.",
    permission: "read_returns",
    folder: "Returns",
    responseExample: {
      data: {
        id: "clxyz123",
        returnRequestNo: "RPM-A1B2C3D4",
        shopifyOrderId: "gid://shopify/Order/12345",
        shopifyOrderName: "#1001",
        status: "approved",
        refundStatus: null,
        resolutionType: "refund",
        customerName: "John Doe",
        customerEmail: "john@example.com",
        currency: "USD",
        items: [
          {
            id: "clitem123",
            shopifyLineItemId: "gid://shopify/LineItem/999",
            title: "Blue T-Shirt",
            variantTitle: "Medium",
            sku: "BTS-M-001",
            price: "29.99",
            qty: 1,
            reasonCode: "wrong_size",
            condition: "unused",
          },
        ],
        events: [
          { id: "clevt123", source: "admin", eventType: "approved", happenedAt: "2026-03-10T15:00:00Z" },
        ],
        createdAt: "2026-03-10T14:30:00Z",
        updatedAt: "2026-03-10T15:00:00Z",
      },
    },
    errorCodes: [
      { status: 401, code: "UNAUTHORIZED", when: "Missing or invalid API key" },
      { status: 404, code: "NOT_FOUND", when: "Return not found or belongs to different shop" },
    ],
  },
  {
    method: "POST",
    path: "/api/v1/external/returns/:id/approve",
    name: "Approve Return",
    description: "Approve a pending return case. Optionally override the resolution type and add an admin note.",
    permission: "write_returns",
    folder: "Returns",
    requestBody: {
      description: "Optional approval parameters",
      example: { note: "Approved by ERP system", resolutionType: "refund" },
    },
    responseExample: {
      data: { id: "clxyz123", status: "approved", message: "Return approved successfully" },
    },
    errorCodes: [
      { status: 400, code: "INVALID_STATE", when: "Return is already in a terminal state" },
      { status: 404, code: "NOT_FOUND", when: "Return not found" },
    ],
  },
  {
    method: "POST",
    path: "/api/v1/external/returns/:id/reject",
    name: "Reject Return",
    description: "Reject a pending return case. A rejection reason is required.",
    permission: "write_returns",
    folder: "Returns",
    requestBody: {
      description: "Rejection parameters",
      example: { rejectionReason: "Item is outside return window", note: "Rejected by automation" },
    },
    responseExample: {
      data: { id: "clxyz123", status: "rejected", message: "Return rejected successfully" },
    },
    errorCodes: [
      { status: 400, code: "BAD_REQUEST", when: "Missing rejectionReason" },
      { status: 400, code: "INVALID_STATE", when: "Return is already in a terminal state" },
      { status: 404, code: "NOT_FOUND", when: "Return not found" },
    ],
  },
  {
    method: "POST",
    path: "/api/v1/external/returns/:id/refund",
    name: "Process Refund",
    description: "Process a refund for an approved return. Defaults to shop's configured refund method.",
    permission: "write_returns",
    folder: "Returns",
    requestBody: {
      description: "Optional refund parameters",
      example: { refundMethod: "original", note: "Refund processed by ERP" },
    },
    responseExample: {
      data: {
        id: "clxyz123",
        refundStatus: "refunded",
        refundDetails: { amount: "29.99", currency: "USD", method: "original" },
        message: "Refund processed successfully",
      },
    },
    errorCodes: [
      { status: 400, code: "INVALID_STATE", when: "Return not approved or already refunded" },
      { status: 400, code: "BAD_REQUEST", when: "Invalid refund parameters" },
      { status: 404, code: "NOT_FOUND", when: "Return not found" },
    ],
  },
  // ── Settings ──
  {
    method: "GET",
    path: "/api/v1/external/settings",
    name: "Get Settings",
    description: "Retrieve non-sensitive return settings for your shop (return window, refund methods, policies).",
    permission: "read_settings",
    folder: "Settings",
    responseExample: {
      data: {
        returnWindowDays: 30,
        autoApproveEnabled: false,
        autoRefundEnabled: false,
        photoRequired: true,
        refundPaymentMethod: "original",
        returnFeeAmount: "5.00",
        returnFeeCurrency: "USD",
        bonusCreditEnabled: false,
        greenReturnsEnabled: false,
        shopCurrency: "USD",
        shopTimezone: "America/New_York",
      },
    },
    errorCodes: [
      { status: 401, code: "UNAUTHORIZED", when: "Missing or invalid API key" },
    ],
  },
  // ── Webhooks ──
  {
    method: "GET",
    path: "/api/v1/external/webhooks",
    name: "List Webhook Subscriptions",
    description: "List all active webhook subscriptions for your shop.",
    permission: "manage_webhooks",
    folder: "Webhooks",
    responseExample: {
      data: [
        {
          id: "clwh123",
          url: "https://erp.example.com/webhooks/returns",
          events: ["return.created", "return.approved"],
          isActive: true,
          createdAt: "2026-03-12T10:00:00Z",
        },
      ],
    },
    errorCodes: [
      { status: 401, code: "UNAUTHORIZED", when: "Missing or invalid API key" },
    ],
  },
  {
    method: "POST",
    path: "/api/v1/external/webhooks",
    name: "Register Webhook",
    description: "Register a new webhook subscription. The HMAC secret is returned once on creation.",
    permission: "manage_webhooks",
    folder: "Webhooks",
    requestBody: {
      description: "Webhook subscription parameters",
      example: {
        url: "https://erp.example.com/webhooks/returns",
        events: ["return.created", "return.approved", "return.rejected", "return.refunded"],
      },
    },
    responseExample: {
      data: {
        id: "clwh123",
        url: "https://erp.example.com/webhooks/returns",
        events: ["return.created", "return.approved", "return.rejected", "return.refunded"],
        secret: "whsec_a1b2c3d4e5f6...",
        isActive: true,
        createdAt: "2026-03-12T10:00:00Z",
      },
    },
    errorCodes: [
      { status: 400, code: "BAD_REQUEST", when: "Invalid URL or empty events array" },
    ],
  },
  {
    method: "DELETE",
    path: "/api/v1/external/webhooks/:id",
    name: "Delete Webhook",
    description: "Remove a webhook subscription.",
    permission: "manage_webhooks",
    folder: "Webhooks",
    responseExample: {
      data: { id: "clwh123", message: "Webhook subscription removed" },
    },
    errorCodes: [
      { status: 404, code: "NOT_FOUND", when: "Webhook subscription not found" },
    ],
  },
];

export const WEBHOOK_EVENTS = [
  "return.created",
  "return.approved",
  "return.rejected",
  "return.refunded",
  "return.status_changed",
] as const;
