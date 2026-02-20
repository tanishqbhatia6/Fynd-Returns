import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { hashLookupValue } from "../lib/portal-auth.server";
import { getPortalCorsHeaders, withCors } from "../lib/portal-cors.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getPortalCorsHeaders(request) });
  }
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    const res = Response.json({ error: "Method not allowed" }, { status: 405 });
    return withCors(res, request);
  }
  try {
    const { shop, lookupType, lookupValue } = await request.json();
    if (!shop || !lookupType || !lookupValue) {
      return Response.json({ error: "shop, lookupType, lookupValue required" }, { status: 400 });
    }

    const shopDomain = shop.includes(".") ? shop : `${shop}.myshopify.com`;
    const shopRecord = await prisma.shop.findUnique({ where: { shopDomain } });
    if (!shopRecord) {
      return Response.json({ error: "Shop not found" }, { status: 404 });
    }

    const norm = String(lookupValue).toLowerCase().trim();
    const hash = hashLookupValue(norm);

    const where: Record<string, unknown> = { shopId: shopRecord.id };
    if (["return_no", "order_no"].includes(lookupType)) {
      where.OR = [
        { fyndReturnNo: { contains: norm, mode: "insensitive" } },
        { shopifyOrderName: { contains: norm, mode: "insensitive" } },
      ];
    } else if (["forward_awb", "return_awb"].includes(lookupType)) {
      where.OR = [
        { forwardAwb: { contains: norm, mode: "insensitive" } },
        { returnAwb: { contains: norm, mode: "insensitive" } },
      ];
    } else {
      where.OR = [
        { customerEmailNorm: { contains: norm, mode: "insensitive" } },
        { customerPhoneNorm: { contains: norm, mode: "insensitive" } },
      ];
    }

    const matches = await prisma.returnCase.findMany({ where, select: { id: true } });
    const matchedReturnIds = matches.map((m) => m.id);

    const session = await prisma.lookupSession.create({
      data: {
        shopId: shopRecord.id,
        lookupType,
        lookupValueHash: hash,
        lookupValueNorm: norm,
        matchedReturnIds: JSON.stringify(matchedReturnIds),
        expiresAt: new Date(Date.now() + 15 * 60 * 1000),
      },
    });

    return withCors(Response.json({ sessionId: session.id, nextStep: "otp" }), request);
  } catch (err) {
    console.error("Portal lookup:", err);
    return withCors(Response.json({ error: (err as Error).message }, { status: 500 }), request);
  }
};
