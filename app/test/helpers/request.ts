/**
 * Request factory functions for testing route handlers.
 */

export function createRequest(path: string, options?: RequestInit): Request {
  return new Request(`http://localhost${path}`, options);
}

export function createJsonRequest(path: string, body: unknown, options?: RequestInit): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...((options?.headers as Record<string, string>) || {}),
    },
    body: JSON.stringify(body),
    ...options,
  });
}

export function createPortalRequest(path: string, body: unknown, origin?: string): Request {
  return createJsonRequest(path, body, {
    headers: {
      Origin: origin || "https://test-store.myshopify.com",
    },
  });
}

export function createApiKeyRequest(path: string, apiKey: string, options?: RequestInit): Request {
  return new Request(`http://localhost${path}`, {
    headers: { "X-API-Key": apiKey, ...((options?.headers as Record<string, string>) || {}) },
    ...options,
  });
}
