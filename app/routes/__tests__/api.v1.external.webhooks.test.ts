import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock modules
vi.mock("../../db.server", () => {
  const mockPrisma = {
    webhookSubscription: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
  };
  return { default: mockPrisma };
});

vi.mock("../../lib/api-key-auth.server", () => ({
  authenticateApiKey: vi.fn(),
}));

vi.mock("../../lib/rate-limit.server", () => ({
  checkRateLimit: vi.fn().mockReturnValue({ allowed: true, remaining: 100, retryAfterMs: 0 }),
  rateLimitResponse: vi.fn(),
}));

vi.mock("../../lib/api-docs-data", () => ({
  WEBHOOK_EVENTS: [
    "return.created",
    "return.approved",
    "return.rejected",
    "return.refunded",
    "return.status_changed",
  ],
}));

vi.mock("crypto", async () => {
  const actual = await vi.importActual<typeof import("crypto")>("crypto");
  return {
    ...actual,
    default: {
      ...actual,
      randomBytes: vi.fn().mockReturnValue({
        toString: () => "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6abcd",
      }),
    },
  };
});

import prisma from "../../db.server";
import { authenticateApiKey } from "../../lib/api-key-auth.server";
import { loader, action } from "../api.v1.external.webhooks";

const mockAuth = authenticateApiKey as ReturnType<typeof vi.fn>;
const mockPrisma = prisma as any;

function makeGetRequest() {
  return new Request("http://localhost/api/v1/external/webhooks", {
    method: "GET",
    headers: { "X-API-Key": "rpm_testkey123" },
  });
}

function makePostRequest(body: Record<string, unknown>) {
  return new Request("http://localhost/api/v1/external/webhooks", {
    method: "POST",
    headers: {
      "X-API-Key": "rpm_testkey123",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("GET /api/v1/external/webhooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({
      ok: true,
      shopId: "shop-1",
      shopDomain: "test.myshopify.com",
      keyId: "key-1",
    });
  });

  it("returns list of active webhook subscriptions", async () => {
    const now = new Date();
    const fakeSubs = [
      {
        id: "wh-1",
        url: "https://erp.example.com/hooks",
        events: JSON.stringify(["return.created", "return.approved"]),
        isActive: true,
        createdAt: now,
      },
      {
        id: "wh-2",
        url: "https://crm.example.com/hooks",
        events: JSON.stringify(["return.rejected"]),
        isActive: true,
        createdAt: now,
      },
    ];

    mockPrisma.webhookSubscription.findMany.mockResolvedValue(fakeSubs);

    const response = await loader({
      request: makeGetRequest(),
      params: {},
      context: {} as any,
      unstable_pattern: "/api/v1/external/webhooks",
    });

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.data).toHaveLength(2);
    expect(body.data[0].id).toBe("wh-1");
    expect(body.data[0].url).toBe("https://erp.example.com/hooks");
    expect(body.data[0].events).toEqual(["return.created", "return.approved"]);
    expect(body.data[0].isActive).toBe(true);
    expect(body.data[1].id).toBe("wh-2");
    expect(body.errors).toEqual([]);
  });
});

describe("POST /api/v1/external/webhooks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuth.mockResolvedValue({
      ok: true,
      shopId: "shop-1",
      shopDomain: "test.myshopify.com",
      keyId: "key-1",
    });
  });

  it("creates new webhook subscription with secret", async () => {
    const now = new Date();
    mockPrisma.webhookSubscription.findFirst.mockResolvedValue(null); // no duplicate
    mockPrisma.webhookSubscription.create.mockResolvedValue({
      id: "wh-new",
      shopId: "shop-1",
      url: "https://erp.example.com/hooks",
      events: JSON.stringify(["return.created"]),
      secret: "whsec_a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6abcd",
      isActive: true,
      createdAt: now,
    });

    const response = await action({
      request: makePostRequest({
        url: "https://erp.example.com/hooks",
        events: ["return.created"],
      }),
      params: {},
      context: {} as any,
      unstable_pattern: "/api/v1/external/webhooks",
    });

    expect(response.status).toBe(201);
    const body = await response.json();

    expect(body.data.id).toBe("wh-new");
    expect(body.data.url).toBe("https://erp.example.com/hooks");
    expect(body.data.events).toEqual(["return.created"]);
    expect(body.data.secret).toBeDefined();
    expect(body.data.secret).toMatch(/^whsec_/);
    expect(body.data.isActive).toBe(true);
    expect(body.errors).toEqual([]);
  });

  it("validates URL must be HTTPS", async () => {
    const response = await action({
      request: makePostRequest({
        url: "http://insecure.example.com/hooks",
        events: ["return.created"],
      }),
      params: {},
      context: {} as any,
      unstable_pattern: "/api/v1/external/webhooks",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("HTTPS");
  });

  it("validates events array is non-empty", async () => {
    const response = await action({
      request: makePostRequest({
        url: "https://erp.example.com/hooks",
        events: [],
      }),
      params: {},
      context: {} as any,
      unstable_pattern: "/api/v1/external/webhooks",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("non-empty array");
  });

  it("rejects duplicate URL", async () => {
    mockPrisma.webhookSubscription.findFirst.mockResolvedValue({
      id: "wh-existing",
      url: "https://erp.example.com/hooks",
      isActive: true,
    });

    const response = await action({
      request: makePostRequest({
        url: "https://erp.example.com/hooks",
        events: ["return.created"],
      }),
      params: {},
      context: {} as any,
      unstable_pattern: "/api/v1/external/webhooks",
    });

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe("BAD_REQUEST");
    expect(body.error.message).toContain("already exists");
  });
});
