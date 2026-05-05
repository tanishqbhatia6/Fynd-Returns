/**
 * Module-load tests for app.docs.tsx — a pure documentation route with
 * no loader/action. We verify the module imports cleanly in a node env
 * and exposes the expected default Documentation component plus an
 * ErrorBoundary export.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("../../components/AppPage", () => ({
  AppPage: ({ children }: { children: unknown }) => children,
}));

describe("app.docs module", () => {
  it("imports without throwing", async () => {
    const mod = await import("../app.docs");
    expect(mod).toBeDefined();
  });

  it("exports a default Documentation component", async () => {
    const mod = await import("../app.docs");
    expect(mod.default).toBeDefined();
    expect(typeof mod.default).toBe("function");
  });

  it("default export accepts zero arguments (React component signature)", async () => {
    const mod = await import("../app.docs");
    // React Router may wrap the component (e.g. WithComponentProps),
    // so we just assert it's a callable component, not its name.
    expect(typeof mod.default).toBe("function");
    expect(mod.default.length).toBeLessThanOrEqual(1);
  });

  it("exports an ErrorBoundary function", async () => {
    const mod = await import("../app.docs");
    expect(mod.ErrorBoundary).toBeDefined();
    expect(typeof mod.ErrorBoundary).toBe("function");
  });

  it("does not export a loader (pure documentation route)", async () => {
    const mod = await import("../app.docs") as Record<string, unknown>;
    expect(mod.loader).toBeUndefined();
  });

  it("does not export an action (pure documentation route)", async () => {
    const mod = await import("../app.docs") as Record<string, unknown>;
    expect(mod.action).toBeUndefined();
  });
});
