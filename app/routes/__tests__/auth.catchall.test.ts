import { describe, it, expect, vi, beforeEach } from "vitest";

const { authenticateAdminMock, boundaryHeadersMock } = vi.hoisted(() => ({
  authenticateAdminMock: vi.fn(),
  boundaryHeadersMock: vi.fn(() => new Headers({ "x-test-boundary": "1" })),
}));

vi.mock("../../shopify.server", () => ({
  authenticate: { admin: authenticateAdminMock },
}));

vi.mock("@shopify/shopify-app-react-router/server", () => ({
  boundary: { headers: boundaryHeadersMock },
}));

// auth.$ is a TSX route but the loader + headers are the only exports we test
import { loader, headers } from "../auth.$";

beforeEach(() => {
  authenticateAdminMock.mockReset();
  boundaryHeadersMock.mockClear();
});

describe("auth.$ loader", () => {
  it("calls authenticate.admin and returns null on success", async () => {
    authenticateAdminMock.mockResolvedValueOnce({ admin: {}, session: {} });
    const req = new Request("https://app.example/auth");
    const res = await loader({ request: req, params: {}, context: {} } as never);
    expect(res).toBe(null);
    expect(authenticateAdminMock).toHaveBeenCalledWith(req);
  });

  it("propagates authentication failures (throws)", async () => {
    authenticateAdminMock.mockRejectedValueOnce(new Response("redirect", { status: 302 }));
    const req = new Request("https://app.example/auth");
    await expect(loader({ request: req, params: {}, context: {} } as never)).rejects.toBeInstanceOf(Response);
  });
});

describe("auth.$ headers", () => {
  it("delegates to Shopify boundary.headers", () => {
    const args = { parentHeaders: new Headers(), loaderHeaders: new Headers(), actionHeaders: new Headers(), errorHeaders: undefined };
    const out = headers(args as never);
    expect(boundaryHeadersMock).toHaveBeenCalledWith(args);
    expect(out.get("x-test-boundary")).toBe("1");
  });
});
