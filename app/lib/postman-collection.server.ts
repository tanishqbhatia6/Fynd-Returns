/**
 * Generates a Postman Collection v2.1 JSON from the endpoint registry.
 */
import { EXTERNAL_API_ENDPOINTS, type ApiEndpointDef } from "./api-docs-data";

const POSTMAN_SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json";

function buildRequestItem(ep: ApiEndpointDef, baseUrl: string) {
  const pathParts = ep.path.split("/").filter(Boolean);
  const urlObj: Record<string, unknown> = {
    raw: `{{base_url}}${ep.path}`,
    host: ["{{base_url}}"],
    path: pathParts,
  };

  if (ep.queryParams) {
    urlObj.query = ep.queryParams.map((p) => ({
      key: p.key,
      value: p.example,
      description: p.description,
      disabled: true,
    }));
  }

  const headers = [
    { key: "Content-Type", value: "application/json" },
    { key: "X-API-Key", value: "{{api_key}}", description: "Your ReturnProMax API key" },
  ];

  const item: Record<string, unknown> = {
    name: ep.name,
    request: {
      method: ep.method,
      header: headers,
      url: urlObj,
      description: ep.description + `\n\nPermission: ${ep.permission}`,
    },
    response: [
      {
        name: "Success",
        status: "OK",
        code: ep.method === "POST" && ep.path.includes("webhooks") && !ep.path.includes(":id") ? 201 : 200,
        header: [{ key: "Content-Type", value: "application/json" }],
        body: JSON.stringify(ep.responseExample, null, 2),
      },
    ],
  };

  if (ep.requestBody) {
    (item.request as Record<string, unknown>).body = {
      mode: "raw",
      raw: JSON.stringify(ep.requestBody.example, null, 2),
      options: { raw: { language: "json" } },
    };
  }

  return item;
}

export function generatePostmanCollection(baseUrl: string): string {
  // Group endpoints by folder
  const folders = new Map<string, ApiEndpointDef[]>();
  for (const ep of EXTERNAL_API_ENDPOINTS) {
    const list = folders.get(ep.folder) || [];
    list.push(ep);
    folders.set(ep.folder, list);
  }

  const items = Array.from(folders.entries()).map(([name, endpoints]) => ({
    name,
    item: endpoints.map((ep) => buildRequestItem(ep, baseUrl)),
  }));

  const collection = {
    info: {
      name: "ReturnProMax External API",
      // Includes a SECURITY WARNING in the description so anyone opening the file
      // sees the reminder before pasting their actual key in. Postman renders this
      // markdown as the collection's intro pane.
      description:
        "Complete API collection for ReturnProMax — Shopify return management. " +
        "Authenticate using your API key in the X-API-Key header.\n\n" +
        "## ⚠️ SECURITY\n\n" +
        "**Do not export this collection with your real API key embedded** — " +
        "Postman saves variable values in the exported JSON, and that file is " +
        "easy to leak via Slack, email, or git history. Best practice:\n\n" +
        "1. Set `api_key` in a Postman *environment*, not in the collection.\n" +
        "2. If you must share the collection, rotate the key first via " +
        "Settings → API Keys.\n" +
        "3. The placeholder value below (`rpm_YOUR_API_KEY_HERE`) is intentionally " +
        "obvious — replace at runtime, not before sharing.",
      schema: POSTMAN_SCHEMA,
    },
    variable: [
      { key: "base_url", value: baseUrl, description: "Base URL of your ReturnProMax app" },
      {
        key: "api_key",
        value: "rpm_YOUR_API_KEY_HERE",
        description: "Your API key (generate from Settings → API Keys). DO NOT COMMIT this file with the real value — see SECURITY note in collection description.",
      },
    ],
    auth: {
      type: "apikey",
      apikey: [
        { key: "key", value: "X-API-Key" },
        { key: "value", value: "{{api_key}}" },
        { key: "in", value: "header" },
      ],
    },
    item: items,
  };

  return JSON.stringify(collection, null, 2);
}
