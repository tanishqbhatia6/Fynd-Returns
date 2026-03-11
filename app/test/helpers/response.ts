/**
 * Response assertion helpers for testing.
 */
import { expect } from "vitest";

export async function parseJsonResponse<T = unknown>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

export function expectStatus(response: Response, status: number) {
  expect(response.status).toBe(status);
}

export function expectCorsHeaders(response: Response) {
  expect(response.headers.get("access-control-allow-origin")).toBeTruthy();
}
