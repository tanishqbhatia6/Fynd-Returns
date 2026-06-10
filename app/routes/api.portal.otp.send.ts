import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import prisma from "../db.server";
import { getPortalCorsHeaders, withCors } from "../lib/portal-cors.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";
import { sendOtpEmail } from "../lib/notification.server";
import { portalOtpCounter } from "../lib/observability/metrics.server";
import { portalLogger } from "../lib/observability/logger.server";

const OTP_COOLDOWN_MS = 60_000;
const MAX_OTP_ATTEMPTS = 5;
const BCRYPT_COST = 10;
const OTP_EMAIL_FAILED_MESSAGE =
  "Could not send the verification email. Ask the store to check email settings and try again.";

async function hashOtp(otp: string): Promise<string> {
  return bcrypt.hash(otp, BCRYPT_COST);
}

async function resetFailedOtpSend(sessionId: string, attemptsCount: number) {
  await prisma.lookupSession
    .update({
      where: { id: sessionId },
      data: {
        otpTarget: null,
        otpSentAt: null,
        attemptsCount,
      },
    })
    .catch(() => {});
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

  const rl = await checkRateLimit(request, "portal.otp.send");
  if (!rl.allowed) {
    portalOtpCounter.add(1, { action: "send", outcome: "rate_limited" });
    return withCors(rateLimitResponse(rl.retryAfterMs), request);
  }

  try {
    const { sessionId } = await request.json();
    if (!sessionId) {
      portalOtpCounter.add(1, { action: "send", outcome: "bad_request" });
      return withCors(Response.json({ error: "sessionId required" }, { status: 400 }), request);
    }

    const session = await prisma.lookupSession.findUnique({ where: { id: sessionId } });
    if (!session || session.expiresAt < new Date()) {
      portalOtpCounter.add(1, { action: "send", outcome: "invalid_session" });
      return withCors(
        Response.json({ error: "Invalid or expired session" }, { status: 400 }),
        request,
      );
    }
    if (session.attemptsCount >= MAX_OTP_ATTEMPTS) {
      portalOtpCounter.add(1, { action: "send", outcome: "locked" });
      return withCors(
        Response.json({ error: "Too many OTP attempts. Please start over." }, { status: 429 }),
        request,
      );
    }

    if (session.otpSentAt && Date.now() - session.otpSentAt.getTime() < OTP_COOLDOWN_MS) {
      portalOtpCounter.add(1, { action: "send", outcome: "cooldown" });
      const waitSec = Math.ceil(
        (OTP_COOLDOWN_MS - (Date.now() - session.otpSentAt.getTime())) / 1000,
      );
      return withCors(
        Response.json(
          { error: `Please wait ${waitSec}s before requesting another OTP` },
          { status: 429 },
        ),
        request,
      );
    }

    const otp = String(crypto.randomInt(100000, 1000000));
    const otpHash = await hashOtp(otp);

    const target = session.lookupValueNorm;
    if (!target || !target.includes("@")) {
      portalOtpCounter.add(1, { action: "send", outcome: "unsupported_channel" });
      return withCors(
        Response.json(
          {
            error:
              "Phone verification is not configured for this portal. Use email verification or contact support.",
            phoneVerificationUnavailable: true,
          },
          { status: 400 },
        ),
        request,
      );
    }

    const shopRecord = await prisma.shop.findUnique({
      where: { id: session.shopId },
      select: { shopDomain: true },
    });
    if (!shopRecord) {
      portalOtpCounter.add(1, { action: "send", outcome: "shop_not_found" });
      return withCors(Response.json({ error: "Shop not found" }, { status: 404 }), request);
    }

    await prisma.lookupSession.update({
      where: { id: sessionId },
      data: {
        otpTarget: otpHash,
        otpSentAt: new Date(),
        attemptsCount: session.attemptsCount + 1,
      },
    });

    try {
      const emailResult = await sendOtpEmail({
        shopDomain: shopRecord.shopDomain,
        to: target,
        otp,
      });
      if (!emailResult.success) {
        await resetFailedOtpSend(sessionId, session.attemptsCount);
        portalOtpCounter.add(1, { action: "send", outcome: "email_failed" });
        portalLogger.warn(
          { error: emailResult.error, sessionId, shopDomain: shopRecord.shopDomain },
          "Portal OTP email send failed",
        );
        return withCors(
          Response.json(
            {
              error: OTP_EMAIL_FAILED_MESSAGE,
              emailVerificationUnavailable: true,
            },
            { status: 503 },
          ),
          request,
        );
      }
    } catch (emailErr) {
      await resetFailedOtpSend(sessionId, session.attemptsCount);
      portalOtpCounter.add(1, { action: "send", outcome: "email_failed" });
      portalLogger.warn({ err: emailErr, sessionId }, "Portal OTP email send failed");
      return withCors(
        Response.json(
          {
            error: OTP_EMAIL_FAILED_MESSAGE,
            emailVerificationUnavailable: true,
          },
          { status: 503 },
        ),
        request,
      );
    }

    portalOtpCounter.add(1, { action: "send", outcome: "success" });
    return withCors(Response.json({ success: true }), request);
  } catch (err) {
    portalOtpCounter.add(1, { action: "send", outcome: "error" });
    portalLogger.error({ err }, "Portal OTP send failed");
    return withCors(
      Response.json({ error: "Failed to send verification code" }, { status: 500 }),
      request,
    );
  }
};
