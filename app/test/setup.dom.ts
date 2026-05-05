/**
 * jsdom-only setup. Loaded by vitest.components.config.mts in addition to
 * the shared `setup.ts`. Adds @testing-library/jest-dom matchers and the
 * standard browser-environment polyfills jsdom doesn't provide.
 */
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// Tear down the DOM between tests so leftover elements/event listeners don't
// affect subsequent renders.
afterEach(() => {
  cleanup();
});
