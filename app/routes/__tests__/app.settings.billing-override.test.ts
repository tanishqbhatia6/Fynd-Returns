/**
 * Loader + action tests for app.settings.billing-override.tsx — the
 * superadmin-only page for toggling per-shop billing overrides.
 *
 * Covers:
 *   - loader rejects non-superadmins (redirects to /app)
 *   - loader returns shop list + audit metadata to superadmins
 *   - action gates on isSuperAdmin
 *   - action validates shopDomain / reason / override value
 *   - action calls setBillingPlanOverride for "free" / "paid" / null
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const {
  prismaMock,
  authenticateMock,
  isSuperAdminMock,
  getBillingModeMock,
  setBillingPlanOverrideMock,
} = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  isSuperAdminMock: vi.fn(),
  getBillingModeMock: vi.fn(),
  setBillingPlanOverrideMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({
  authenticate: { admin: authenticateMock },
}));
vi.mock("../../lib/billing.server", () => ({
  isSuperAdmin: isSuperAdminMock,
  getBillingMode: getBillingModeMock,
  setBillingPlanOverride: setBillingPlanOverrideMock,
}));

import { loader, action } from "../app.settings.billing-override";

function adminSession(email: string | null) {
  return {
    session: {
      shop: "store.myshopify.com",
      onlineAccessInfo: email
        ? { associated_user: { email } }
        : undefined,
    },
  };
}

function formReq(form: Record<string, string>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) fd.append(k, v);
  return new Request("https://x", { method: "POST", body: fd });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset();
  isSuperAdminMock.mockReset();
  getBillingModeMock.mockReset().mockReturnValue("dev");
  setBillingPlanOverrideMock.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("loader", () => {
  it("redirects non-superadmins to /app", async () => {
    authenticateMock.mockResolvedValueOnce(adminSession("merchant@shop.com"));
    isSuperAdminMock.mockReturnValueOnce(false);

    let thrown: unknown;
    try {
      await loader({
        request: new Request("https://x"),
        params: {},
        context: {},
      } as never);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    const res = thrown as Response;
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/app");
  });

  it("redirects when session has no email", async () => {
    authenticateMock.mockResolvedValueOnce(adminSession(null));
    isSuperAdminMock.mockReturnValueOnce(false);

    let thrown: unknown;
    try {
      await loader({
        request: new Request("https://x"),
        params: {},
        context: {},
      } as never);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).headers.get("Location")).toBe("/app");
    // Verify isSuperAdmin received null (no email in session)
    expect(isSuperAdminMock).toHaveBeenCalledWith(null);
  });

  it("returns shop list + acting email + mode for superadmins", async () => {
    authenticateMock.mockResolvedValueOnce(adminSession("admin@returnpro.com"));
    isSuperAdminMock.mockReturnValueOnce(true);
    getBillingModeMock.mockReturnValueOnce("prod");
    const installedAt = new Date("2026-01-01T00:00:00.000Z");
    const overrideAt = new Date("2026-02-15T00:00:00.000Z");
    prismaMock.shop.findMany.mockResolvedValueOnce([
      {
        shopDomain: "a.myshopify.com",
        installedAt,
        settings: {
          billingPlanOverride: "free",
          billingPlanOverrideReason: "Comp account",
          billingPlanOverrideBy: "admin@returnpro.com",
          billingPlanOverrideAt: overrideAt,
          subscriptionStatus: "active",
          subscriptionName: "Pro",
        },
      },
      {
        shopDomain: "b.myshopify.com",
        installedAt,
        settings: null,
      },
    ]);

    const data = await loader({
      request: new Request("https://x"),
      params: {},
      context: {},
    } as never);

    expect(data.actingEmail).toBe("admin@returnpro.com");
    expect(data.mode).toBe("prod");
    expect(data.shops).toHaveLength(2);
    expect(data.shops[0]).toEqual({
      shopDomain: "a.myshopify.com",
      installedAt: installedAt.toISOString(),
      override: "free",
      overrideReason: "Comp account",
      overrideBy: "admin@returnpro.com",
      overrideAt: overrideAt.toISOString(),
      subscriptionStatus: "active",
      subscriptionName: "Pro",
    });
    expect(data.shops[1]).toEqual({
      shopDomain: "b.myshopify.com",
      installedAt: installedAt.toISOString(),
      override: null,
      overrideReason: null,
      overrideBy: null,
      overrideAt: null,
      subscriptionStatus: null,
      subscriptionName: null,
    });
  });

  it("queries shops ordered by installedAt desc with settings included", async () => {
    authenticateMock.mockResolvedValueOnce(adminSession("admin@returnpro.com"));
    isSuperAdminMock.mockReturnValueOnce(true);
    prismaMock.shop.findMany.mockResolvedValueOnce([]);

    const data = await loader({
      request: new Request("https://x"),
      params: {},
      context: {},
    } as never);

    expect(data.shops).toEqual([]);
    expect(prismaMock.shop.findMany).toHaveBeenCalledWith({
      include: { settings: true },
      orderBy: { installedAt: "desc" },
    });
  });
});

describe("action", () => {
  it("returns Forbidden for non-superadmins", async () => {
    authenticateMock.mockResolvedValueOnce(adminSession("merchant@shop.com"));
    isSuperAdminMock.mockReturnValueOnce(false);

    const res = await action({
      request: formReq({
        shopDomain: "a.myshopify.com",
        override: "free",
        reason: "test reason",
      }),
      params: {},
      context: {},
    } as never);

    expect(res).toEqual({ error: "Forbidden" });
    expect(setBillingPlanOverrideMock).not.toHaveBeenCalled();
  });

  it("returns error when shopDomain is missing", async () => {
    authenticateMock.mockResolvedValueOnce(adminSession("admin@returnpro.com"));
    isSuperAdminMock.mockReturnValueOnce(true);

    const res = await action({
      request: formReq({ override: "free", reason: "valid reason" }),
      params: {},
      context: {},
    } as never);

    expect(res).toEqual({ error: "Missing shopDomain" });
    expect(setBillingPlanOverrideMock).not.toHaveBeenCalled();
  });

  it("returns error when reason is too short", async () => {
    authenticateMock.mockResolvedValueOnce(adminSession("admin@returnpro.com"));
    isSuperAdminMock.mockReturnValueOnce(true);

    const res = await action({
      request: formReq({
        shopDomain: "a.myshopify.com",
        override: "free",
        reason: "x",
      }),
      params: {},
      context: {},
    } as never);

    expect(res).toEqual({
      error:
        "Provide a short reason (min 4 chars) — shows up in the audit log",
    });
    expect(setBillingPlanOverrideMock).not.toHaveBeenCalled();
  });

  it("returns error when reason is empty", async () => {
    authenticateMock.mockResolvedValueOnce(adminSession("admin@returnpro.com"));
    isSuperAdminMock.mockReturnValueOnce(true);

    const res = await action({
      request: formReq({
        shopDomain: "a.myshopify.com",
        override: "free",
      }),
      params: {},
      context: {},
    } as never);

    expect(res).toEqual({
      error:
        "Provide a short reason (min 4 chars) — shows up in the audit log",
    });
    expect(setBillingPlanOverrideMock).not.toHaveBeenCalled();
  });

  it("returns error for invalid override value", async () => {
    authenticateMock.mockResolvedValueOnce(adminSession("admin@returnpro.com"));
    isSuperAdminMock.mockReturnValueOnce(true);

    const res = await action({
      request: formReq({
        shopDomain: "a.myshopify.com",
        override: "platinum",
        reason: "trying weird value",
      }),
      params: {},
      context: {},
    } as never);

    expect(res).toEqual({ error: "Invalid override value: platinum" });
    expect(setBillingPlanOverrideMock).not.toHaveBeenCalled();
  });

  it("sets override to 'free' with audit metadata", async () => {
    authenticateMock.mockResolvedValueOnce(adminSession("admin@returnpro.com"));
    isSuperAdminMock.mockReturnValueOnce(true);

    const res = await action({
      request: formReq({
        shopDomain: "a.myshopify.com",
        override: "free",
        reason: "Comp account for partner",
      }),
      params: {},
      context: {},
    } as never);

    expect(setBillingPlanOverrideMock).toHaveBeenCalledWith(
      "a.myshopify.com",
      "free",
      "Comp account for partner",
      "admin@returnpro.com",
    );
    expect(res).toEqual({
      success: "Override for a.myshopify.com set to free",
    });
  });

  it("sets override to 'paid'", async () => {
    authenticateMock.mockResolvedValueOnce(adminSession("admin@returnpro.com"));
    isSuperAdminMock.mockReturnValueOnce(true);

    const res = await action({
      request: formReq({
        shopDomain: "b.myshopify.com",
        override: "paid",
        reason: "force paid plan for testing",
      }),
      params: {},
      context: {},
    } as never);

    expect(setBillingPlanOverrideMock).toHaveBeenCalledWith(
      "b.myshopify.com",
      "paid",
      "force paid plan for testing",
      "admin@returnpro.com",
    );
    expect(res).toEqual({
      success: "Override for b.myshopify.com set to paid",
    });
  });

  it("clears override when value is empty string (default env)", async () => {
    authenticateMock.mockResolvedValueOnce(adminSession("admin@returnpro.com"));
    isSuperAdminMock.mockReturnValueOnce(true);

    const res = await action({
      request: formReq({
        shopDomain: "c.myshopify.com",
        override: "",
        reason: "reverting to default",
      }),
      params: {},
      context: {},
    } as never);

    expect(setBillingPlanOverrideMock).toHaveBeenCalledWith(
      "c.myshopify.com",
      null,
      "reverting to default",
      "admin@returnpro.com",
    );
    expect(res).toEqual({
      success: "Override for c.myshopify.com set to default (env)",
    });
  });

  it("clears override when value is literal 'null'", async () => {
    authenticateMock.mockResolvedValueOnce(adminSession("admin@returnpro.com"));
    isSuperAdminMock.mockReturnValueOnce(true);

    const res = await action({
      request: formReq({
        shopDomain: "d.myshopify.com",
        override: "null",
        reason: "explicit null clear",
      }),
      params: {},
      context: {},
    } as never);

    expect(setBillingPlanOverrideMock).toHaveBeenCalledWith(
      "d.myshopify.com",
      null,
      "explicit null clear",
      "admin@returnpro.com",
    );
    expect(res).toEqual({
      success: "Override for d.myshopify.com set to default (env)",
    });
  });

  it("trims whitespace from form fields", async () => {
    authenticateMock.mockResolvedValueOnce(adminSession("admin@returnpro.com"));
    isSuperAdminMock.mockReturnValueOnce(true);

    const res = await action({
      request: formReq({
        shopDomain: "  e.myshopify.com  ",
        override: "  free  ",
        reason: "  valid reason text  ",
      }),
      params: {},
      context: {},
    } as never);

    expect(setBillingPlanOverrideMock).toHaveBeenCalledWith(
      "e.myshopify.com",
      "free",
      "valid reason text",
      "admin@returnpro.com",
    );
    expect(res).toEqual({
      success: "Override for e.myshopify.com set to free",
    });
  });
});
