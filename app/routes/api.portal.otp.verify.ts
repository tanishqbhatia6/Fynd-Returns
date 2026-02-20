import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { createPortalToken } from "../lib/portal-auth.server";
import { getPortalCorsHeaders, withCors } from "../lib/portal-cors.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getPortalCorsHeaders(request) });
  }
  return null;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return withCors(Response.json({ error: "Method not allowed" }, { status: 405 }), request);
  }
  try {
    const { sessionId, otp } = await request.json();
    if (!sessionId || !otp) {
      return Response.json({ error: "sessionId and otp required" }, { status: 400 });
    }

    const session = await prisma.lookupSession.findUnique({ where: { id: sessionId } });
    if (!session || session.expiresAt < new Date()) {
      return Response.json({ error: "Invalid or expired session" }, { status: 400 });
    }

    if (session.otpTarget !== String(otp)) {
      return Response.json({ error: "Invalid OTP" }, { status: 400 });
    }

    const portalToken = createPortalToken({
      sessionId: session.id,
      shopId: session.shopId,
      lookupType: session.lookupType,
      lookupValueHash: session.lookupValueHash,
    });

    await prisma.lookupSession.update({
      where: { id: sessionId },
      data: { verifiedAt: new Date(), portalToken },
    });

    return withCors(Response.json({ portalToken }), request);
  } catch (err) {
    console.error("Portal OTP verify:", err);
    return withCors(Response.json({ error: (err as Error).message }, { status: 500 }), request);
  }
};
