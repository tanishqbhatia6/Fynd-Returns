import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import crypto from "crypto";
import prisma from "../db.server";
import { getPortalCorsHeaders, withCors } from "../lib/portal-cors.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";

const OTP_COOLDOWN_MS = 60_000;
const MAX_OTP_ATTEMPTS = 5;

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

  const rl = checkRateLimit(request, "portal.otp.send");
  if (!rl.allowed) return withCors(rateLimitResponse(rl.retryAfterMs), request);

  try {
    const { sessionId } = await request.json();
    if (!sessionId) {
      return withCors(Response.json({ error: "sessionId required" }, { status: 400 }), request);
    }

    const session = await prisma.lookupSession.findUnique({ where: { id: sessionId } });
    if (!session || session.expiresAt < new Date()) {
      return withCors(Response.json({ error: "Invalid or expired session" }, { status: 400 }), request);
    }
    if (session.attemptsCount >= MAX_OTP_ATTEMPTS) {
      return withCors(Response.json({ error: "Too many OTP attempts. Please start over." }, { status: 429 }), request);
    }

    if (session.otpSentAt && Date.now() - session.otpSentAt.getTime() < OTP_COOLDOWN_MS) {
      const waitSec = Math.ceil((OTP_COOLDOWN_MS - (Date.now() - session.otpSentAt.getTime())) / 1000);
      return withCors(Response.json({ error: `Please wait ${waitSec}s before requesting another OTP` }, { status: 429 }), request);
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const otpHash = hashOtp(otp);

    await prisma.lookupSession.update({
      where: { id: sessionId },
      data: {
        otpTarget: otpHash,
        otpSentAt: new Date(),
        attemptsCount: session.attemptsCount + 1,
      },
    });

    const target = session.lookupValueNorm;
    if (target && target.includes("@") && process.env.RESEND_API_KEY) {
      try {
        const fromEmail = process.env.NOTIFICATION_FROM_EMAIL ?? "returns@resend.dev";
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          },
          body: JSON.stringify({
            from: fromEmail,
            to: [target],
            subject: "Your return portal verification code",
            html: `<div style="font-family:system-ui,sans-serif;max-width:400px;margin:0 auto;padding:24px"><h2 style="margin:0 0 16px">Verification Code</h2><p>Your code is:</p><div style="font-size:32px;font-weight:700;letter-spacing:6px;text-align:center;padding:16px;background:#f0f4f8;border-radius:8px;margin:16px 0">${otp}</div><p style="color:#6b7280;font-size:14px">This code expires in 10 minutes. Do not share it with anyone.</p></div>`,
          }),
        });
      } catch (emailErr) {
        console.warn("[OTP] Email send failed:", emailErr);
      }
    } else if (process.env.NODE_ENV !== "production") {
      console.log("[OTP] Dev mode code:", otp);
    }

    return withCors(Response.json({ success: true }), request);
  } catch (err) {
    console.error("Portal OTP send:", err);
    return withCors(Response.json({ error: "Failed to send verification code" }, { status: 500 }), request);
  }
};
