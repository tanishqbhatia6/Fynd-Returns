/**
 * Diagnostic endpoint: tests every Shopify order lookup strategy and returns
 * detailed results for each one. Use this to understand why order resolution
 * is failing for a given order name/ID.
 *
 * GET /api/debug/order-lookup?name=FYNDSHOPIFYX14126&returnCaseId=xxx
 *
 * Requires Shopify admin authentication (must be called from within the app).
 */
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import {
  withRestCredentials,
  fetchOrderByGid,
  type AdminGraphQL,
} from "../lib/shopify-admin.server";

const API_VERSION = "2026-01";
const SHOPIFY_FETCH_TIMEOUT_MS = 15_000;

async function shopifyFetch(
  url: string,
  init: RequestInit,
  timeoutMs = SHOPIFY_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

type StrategyResult = {
  strategy: string;
  query: string;
  success: boolean;
  orderId?: string;
  orderName?: string;
  error?: string;
  durationMs: number;
};

/** Run a GraphQL orders search and return raw results */
async function testGraphQLSearch(
  admin: AdminGraphQL,
  query: string,
): Promise<{ nodes: Array<{ id: string; name: string }>; error?: string }> {
  const res = await admin.graphql(
    `#graphql
    query testSearch($query: String!) {
      orders(first: 10, query: $query, sortKey: CREATED_AT, reverse: true) {
        nodes { id name }
      }
    }
  `,
    { variables: { query } },
  );
  const json = (await res.json()) as {
    data?: { orders?: { nodes?: Array<{ id?: string; name?: string }> } };
    errors?: Array<{ message?: string }>;
  };
  if (json.errors?.length) {
    return { nodes: [], error: json.errors.map((e) => e.message).join("; ") };
  }
  return {
    nodes: (json.data?.orders?.nodes ?? []).map((n) => ({
      id: n.id ?? "",
      name: n.name ?? "",
    })),
  };
}

/** Run a REST API order lookup by name */
async function testRestLookup(
  shopDomain: string,
  accessToken: string,
  nameQuery: string,
): Promise<{ orders: Array<{ id: number; name: string }>; error?: string; statusCode?: number }> {
  const shop = shopDomain.includes(".") ? shopDomain : `${shopDomain}.myshopify.com`;
  const url = `https://${shop}/admin/api/${API_VERSION}/orders.json?status=any&name=${encodeURIComponent(nameQuery)}&fields=id,name&limit=5`;
  const res = await shopifyFetch(url, {
    headers: { "X-Shopify-Access-Token": accessToken },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      orders: [],
      error: `HTTP ${res.status}: ${body.slice(0, 200)}`,
      statusCode: res.status,
    };
  }
  const data = (await res.json()) as { orders?: Array<{ id?: number; name?: string }> };
  return {
    orders: (data?.orders ?? []).map((o) => ({ id: o.id ?? 0, name: o.name ?? "" })),
    statusCode: res.status,
  };
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  const url = new URL(request.url);
  const orderName = url.searchParams.get("name") || "FYNDSHOPIFYX14126";
  const returnCaseId = url.searchParams.get("returnCaseId");
  const clean = orderName.replace(/^#/, "").trim();

  const results: StrategyResult[] = [];
  const diagnostics: Record<string, unknown> = {
    shopDomain: session.shop,
    hasAccessToken: !!session.accessToken,
    accessTokenLength: session.accessToken?.length ?? 0,
    orderNameInput: orderName,
    cleanedName: clean,
    apiVersion: API_VERSION,
  };

  // If returnCaseId provided, show the DB record
  if (returnCaseId) {
    const rc = await prisma.returnCase.findUnique({
      where: { id: returnCaseId },
      select: {
        id: true,
        shopifyOrderId: true,
        shopifyOrderName: true,
        returnRequestNo: true,
        fyndPayloadJson: false,
      },
    });
    diagnostics.returnCase = rc;
  }

  // ─── Strategy 1: GraphQL name:"#VALUE" (quoted with #) ───
  for (const q of [
    `name:"#${clean}"`,
    `name:"${clean}"`,
    `name:#${clean}`,
    `name:${clean}`,
    `"#${clean}"`,
    `"${clean}"`,
    clean,
  ]) {
    const start = Date.now();
    try {
      const res = await testGraphQLSearch(admin, q);
      results.push({
        strategy: "GraphQL search",
        query: q,
        success: res.nodes.length > 0,
        orderId: res.nodes[0]?.id,
        orderName: res.nodes[0]?.name,
        error: res.error,
        durationMs: Date.now() - start,
      });
    } catch (err) {
      results.push({
        strategy: "GraphQL search",
        query: q,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      });
    }
  }

  // ─── Strategy 2: REST API exact name match ───
  const accessToken = session.accessToken ?? "";
  for (const nameQuery of [`#${clean}`, clean]) {
    const start = Date.now();
    try {
      const res = await testRestLookup(session.shop, accessToken, nameQuery);
      results.push({
        strategy: "REST API",
        query: `GET orders.json?name=${nameQuery}`,
        success: res.orders.length > 0,
        orderId: res.orders[0]?.id ? `gid://shopify/Order/${res.orders[0].id}` : undefined,
        orderName: res.orders[0]?.name,
        error: res.error,
        durationMs: Date.now() - start,
      });
    } catch (err) {
      results.push({
        strategy: "REST API",
        query: `GET orders.json?name=${nameQuery}`,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      });
    }
  }

  // ─── Strategy 3: Pagination scan (first 250 orders) ───
  {
    const start = Date.now();
    try {
      const res = await admin.graphql(`#graphql
        query scanOrders {
          orders(first: 50, sortKey: CREATED_AT, reverse: true) {
            nodes { id name }
          }
        }
      `);
      const json = (await res.json()) as {
        data?: { orders?: { nodes?: Array<{ id?: string; name?: string }> } };
        errors?: Array<{ message?: string }>;
      };
      const nodes = json.data?.orders?.nodes ?? [];
      const norm = clean.toLowerCase();
      const match = nodes.find((n) => (n.name ?? "").replace(/^#/, "").toLowerCase() === norm);
      // Also list first 10 order names for context
      diagnostics.recentOrderNames = nodes.slice(0, 10).map((n) => n.name);
      results.push({
        strategy: "Pagination scan",
        query: `orders(first: 50) — scanning ${nodes.length} orders`,
        success: !!match,
        orderId: match?.id,
        orderName: match?.name,
        error: json.errors?.[0]?.message,
        durationMs: Date.now() - start,
      });
    } catch (err) {
      results.push({
        strategy: "Pagination scan",
        query: "orders(first: 50)",
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      });
    }
  }

  // ─── Strategy 4: metafield search ───
  {
    const q = `metafields.$app.fynd_order_id:"${clean}"`;
    const start = Date.now();
    try {
      const res = await testGraphQLSearch(admin, q);
      results.push({
        strategy: "Metafield search",
        query: q,
        success: res.nodes.length > 0,
        orderId: res.nodes[0]?.id,
        orderName: res.nodes[0]?.name,
        error: res.error,
        durationMs: Date.now() - start,
      });
    } catch (err) {
      results.push({
        strategy: "Metafield search",
        query: q,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      });
    }
  }

  // Summary
  const successful = results.filter((r) => r.success);
  const summary = {
    totalStrategies: results.length,
    successful: successful.length,
    failed: results.length - successful.length,
    firstSuccessful: successful[0] ?? null,
  };

  return Response.json(
    { summary, diagnostics, results },
    {
      headers: { "Content-Type": "application/json" },
    },
  );
};
