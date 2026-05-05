/**
 * Loader + action tests for app.settings.channel-policies.tsx — per-channel
 * (POS / draft_order / B2B) return policy overrides.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createPrismaMock, resetPrismaMock } from "../../test/prisma-mock";

const { prismaMock, authenticateMock, parseChannelPoliciesMock } = vi.hoisted(() => ({
  prismaMock: {} as ReturnType<typeof createPrismaMock>,
  authenticateMock: vi.fn(),
  parseChannelPoliciesMock: vi.fn(),
}));
Object.assign(prismaMock, createPrismaMock());

vi.mock("../../db.server", () => ({ default: prismaMock }));
vi.mock("../../shopify.server", () => ({ authenticate: { admin: authenticateMock } }));
vi.mock("../../lib/source-channel.server", () => ({
  parseChannelPolicies: parseChannelPoliciesMock,
}));

import { loader, action } from "../app.settings.channel-policies";

function formReq(form: Record<string, string>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) fd.append(k, v);
  return new Request("https://x", { method: "POST", body: fd });
}

beforeEach(() => {
  resetPrismaMock(prismaMock);
  authenticateMock.mockReset().mockResolvedValue({ session: { shop: "store.myshopify.com" } });
  parseChannelPoliciesMock.mockReset().mockReturnValue({});
});

describe("loader", () => {
  it("delegates parsing to parseChannelPolicies", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { channelPoliciesJson: '{"pos":{"returnEnabled":false}}' },
    });
    parseChannelPoliciesMock.mockReturnValueOnce({
      pos: { returnEnabled: false, returnWindowDays: null, autoApproveEnabled: null },
    });
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(data.policies.pos).toBeDefined();
    expect(parseChannelPoliciesMock).toHaveBeenCalledWith('{"pos":{"returnEnabled":false}}');
  });

  it("returns empty policies when channelPoliciesJson is null", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: null });
    parseChannelPoliciesMock.mockReturnValueOnce({});
    const data = await loader({ request: new Request("https://x"), params: {}, context: {} } as never);
    expect(parseChannelPoliciesMock).toHaveBeenCalledWith(null);
    expect(data.policies).toEqual({});
  });
});

describe("action", () => {
  it("404 when shop settings not found", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({ id: "shop-1", settings: null });
    const res = await action({ request: formReq({}), params: {}, context: {} } as never);
    expect(res.status).toBe(404);
  });

  it("saves all 3 channels with form values", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1" },
    });
    const res = await action({
      request: formReq({
        pos_returnEnabled: "true",
        pos_returnWindowDays: "14",
        pos_autoApproveEnabled: "true",
        draft_order_returnEnabled: "false",
        draft_order_returnWindowDays: "",
        draft_order_autoApproveEnabled: "",
        b2b_returnEnabled: "true",
        b2b_returnWindowDays: "30",
        b2b_autoApproveEnabled: "false",
      }),
      params: {}, context: {},
    } as never);
    expect(res.status).toBe(200);
    const stored = JSON.parse(prismaMock.shopSettings.update.mock.calls[0][0].data.channelPoliciesJson);
    expect(stored.pos.returnEnabled).toBe(true);
    expect(stored.pos.returnWindowDays).toBe(14);
    expect(stored.pos.autoApproveEnabled).toBe(true);
    expect(stored.draft_order.returnEnabled).toBe(false);
    expect(stored.draft_order.returnWindowDays).toBeNull();
    expect(stored.draft_order.autoApproveEnabled).toBeNull();
    expect(stored.b2b.returnEnabled).toBe(true);
    expect(stored.b2b.autoApproveEnabled).toBe(false);
  });

  it("treats empty string returnWindowDays as null", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1" },
    });
    await action({
      request: formReq({
        pos_returnEnabled: "true",
        pos_returnWindowDays: "   ",
        pos_autoApproveEnabled: "true",
        draft_order_returnEnabled: "false",
        draft_order_returnWindowDays: "",
        draft_order_autoApproveEnabled: "",
        b2b_returnEnabled: "true",
        b2b_returnWindowDays: "",
        b2b_autoApproveEnabled: "",
      }),
      params: {}, context: {},
    } as never);
    const stored = JSON.parse(prismaMock.shopSettings.update.mock.calls[0][0].data.channelPoliciesJson);
    expect(stored.pos.returnWindowDays).toBeNull();
    expect(stored.b2b.returnWindowDays).toBeNull();
  });

  it("returns success:true on save", async () => {
    prismaMock.shop.findUnique.mockResolvedValueOnce({
      id: "shop-1",
      settings: { id: "s-1" },
    });
    const res = await action({
      request: formReq({
        pos_returnEnabled: "false",
        pos_returnWindowDays: "",
        pos_autoApproveEnabled: "",
        draft_order_returnEnabled: "false",
        draft_order_returnWindowDays: "",
        draft_order_autoApproveEnabled: "",
        b2b_returnEnabled: "false",
        b2b_returnWindowDays: "",
        b2b_autoApproveEnabled: "",
      }),
      params: {}, context: {},
    } as never);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
  });
});
