/**
 * Customer Account Extension — list returns endpoint.
 * GET /api/customer-account/returns
 *
 * Auth: Shopify-issued customer-account session token (JWT, HS256, signed
 * with SHOPIFY_API_SECRET). The `sub` claim is the customer's GID; `dest`
 * is the shop domain; `aud` is the app's client ID.
 *
 * Flow
 *  1. Extract Bearer token from Authorization header.
 *  2. jwt.verify with HS256 + SHOPIFY_API_SECRET; reject expired or
 *     wrong-aud tokens.
 *  3. Look up the Shop record by `dest`. If not installed, 401.
 *  4. Read the customer's email via Shopify Admin GraphQL using the shop's
 *     offline session (we already store it for webhooks/cron). The email
 *     comes from Shopify, not from the extension — extensions never see
 *     the email, so they can't spoof it.
 *  5. Query ReturnCase rows where shopId = shop.id AND customerEmailNorm
 *     equals the email lower-cased. Return public-safe fields only.
 *
 * No PII leaks beyond what the customer already owns. Rate-limited per
 * (shop, customer GID) to keep this endpoint cheap.
 */
import type { LoaderFunctionArgs } from "react-router";
import jwt from "jsonwebtoken";
import prisma from "../db.server";
import { withCors } from "../lib/portal-cors.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";

const SHOPIFY_API_KEY = process.env.SHOPIFY_API_KEY ?? "";
const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET ?? "";

type CustomerAccountClaims = {
  iss?: string;
  dest?: string;
  aud?: string;
  exp?: number;
  nbf?: number;
  iat?: number;
  jti?: string;
  sub?: string;
};

function extractBearer(request: Request): string | null {
  const h = request.headers.get("Authorization") || request.headers.get("authorization");
  if (!h) return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

function verifyCustomerAccountToken(token: string): CustomerAccountClaims | null {
  if (!SHOPIFY_API_SECRET) return null;
  try {
    const decoded = jwt.verify(token, SHOPIFY_API_SECRET, {
      algorithms: ["HS256"],
    }) as CustomerAccountClaims;
    if (SHOPIFY_API_KEY && decoded.aud && decoded.aud !== SHOPIFY_API_KEY) return null;
    return decoded;
  } catch {
    return null;
  }
}

function err(status: number, message: string, request: Request): Response {
  return withCors(Response.json({ ok: false, error: message }, { status }), request);
}

export const loader = async ({ request }: LoaderFunctionArgs): Promise<Response> => {
  if (request.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }), request);
  }

  const token = extractBearer(request);
  if (!token) return err(401, "Missing Authorization header", request);

  const claims = verifyCustomerAccountToken(token);
  if (!claims || !claims.sub || !claims.dest) {
    return err(401, "Invalid or expired session token", request);
  }

  const customerGid = claims.sub;
  const customerNumericId = customerGid.split("/").pop() || "";
  const shopDomain = String(claims.dest).toLowerCase();

  const rl = await checkRateLimit(request, `customer-account.returns:${customerNumericId}`);
  if (!rl.allowed) return withCors(rateLimitResponse(rl.retryAfterMs), request);

  const shopRecord = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shopRecord) return err(404, "Shop not found", request);

  const session = await prisma.session.findFirst({
    where: { shop: shopDomain, isOnline: false },
    orderBy: { expires: "desc" },
  });
  if (!session?.accessToken) {
    return err(401, "Shop session unavailable; reinstall the app to refresh permissions", request);
  }

  let customerEmail: string | null = null;
  try {
    const resp = await fetch(`https://${shopDomain}/admin/api/2026-01/graphql.json`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": session.accessToken,
      },
      body: JSON.stringify({
        query: `query GetCustomerEmail($id: ID!) { customer(id: $id) { id email } }`,
        variables: { id: customerGid },
      }),
    });
    const json = (await resp.json()) as { data?: { customer?: { email?: string } } };
    customerEmail = json?.data?.customer?.email?.toLowerCase() ?? null;
  } catch {
    customerEmail = null;
  }

  if (!customerEmail) {
    return withCors(
      Response.json({ ok: true, returns: [], appHost: getAppHost() }),
      request,
    );
  }

  const rows = await prisma.returnCase.findMany({
    where: {
      shopId: shopRecord.id,
      customerEmailNorm: customerEmail,
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      returnRequestNo: true,
      status: true,
      refundStatus: true,
      resolutionType: true,
      fyndReturnNo: true,
      returnAwb: true,
      createdAt: true,
    },
  });

  return withCors(
    Response.json({
      ok: true,
      appHost: getAppHost(),
      returns: rows.map((r) => ({
        id: r.id,
        returnRequestNo: r.returnRequestNo ?? r.id,
        status: r.status,
        refundStatus: r.refundStatus,
        resolutionType: r.resolutionType,
        fyndReturnNo: r.fyndReturnNo,
        returnAwb: r.returnAwb,
        createdAt: r.createdAt,
      })),
    }),
    request,
  );
};

function getAppHost(): string {
  return process.env.SHOPIFY_APP_URL || "";
}
