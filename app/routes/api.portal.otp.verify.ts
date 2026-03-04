import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import crypto from "crypto";
import prisma from "../db.server";
import { createPortalToken } from "../lib/portal-auth.server";
import { getPortalCorsHeaders, withCors } from "../lib/portal-cors.server";

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;

function hashOtp(otp: string): string {
  return crypto.createHash("sha256").update(otp).digest("hex");
}

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
      return withCors(Response.json({ error: "sessionId and otp required" }, { status: 400 }), request);
    }

    const session = await prisma.lookupSession.findUnique({ where: { id: sessionId } });
    if (!session || session.expiresAt < new Date()) {
      return withCors(Response.json({ error: "Invalid or expired session" }, { status: 400 }), request);
    }

    if (session.attemptsCount >= MAX_VERIFY_ATTEMPTS) {
      return withCors(Response.json({ error: "Too many attempts. Please request a new code." }, { status: 429 }), request);
    }

    if (!session.otpSentAt || Date.now() - session.otpSentAt.getTime() > OTP_TTL_MS) {
      return withCors(Response.json({ error: "Code has expired. Please request a new one." }, { status: 400 }), request);
    }

    if (!session.otpTarget) {
      return withCors(Response.json({ error: "No verification code found. Please request one first." }, { status: 400 }), request);
    }

    const submittedHash = hashOtp(String(otp));
    const storedHash = session.otpTarget;
    let isValid = false;
    try {
      const a = Buffer.from(submittedHash, "hex");
      const b = Buffer.from(storedHash, "hex");
      isValid = a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch {
      isValid = false;
    }

    if (!isValid) {
      await prisma.lookupSession.update({
        where: { id: sessionId },
        data: { attemptsCount: session.attemptsCount + 1 },
      });
      return withCors(Response.json({ error: "Invalid verification code" }, { status: 400 }), request);
    }

    const portalToken = createPortalToken({
      sessionId: session.id,
      shopId: session.shopId,
      lookupType: session.lookupType,
      lookupValueHash: session.lookupValueHash,
    });

    await prisma.lookupSession.update({
      where: { id: sessionId },
      data: { verifiedAt: new Date(), portalToken, otpTarget: null },
    });

    return withCors(Response.json({ portalToken }), request);
  } catch (err) {
    console.error("Portal OTP verify:", err);
    return withCors(Response.json({ error: "Verification failed" }, { status: 500 }), request);
  }
};
