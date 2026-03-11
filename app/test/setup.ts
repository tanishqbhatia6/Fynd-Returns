/**
 * Global test setup — runs before all tests.
 * Sets environment variables and clears mocks between tests.
 */
import { beforeEach } from "vitest";

process.env.PORTAL_JWT_SECRET = "test-secret-at-least-32-characters-long-for-testing-purposes";
process.env.ENCRYPTION_KEY = "a".repeat(64);
process.env.NODE_ENV = "test";
process.env.SHOPIFY_APP_URL = "https://test-app.example.com";

beforeEach(() => {
  // Rate limiter uses module-level state; clear it
  // Individual tests can mock it as needed
});
