import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { createPortalToken, verifyPortalToken } from "../lib/portal-auth.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
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

    return Response.json({ portalToken });
  } catch (err) {
    console.error("Portal OTP verify:", err);
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
};
