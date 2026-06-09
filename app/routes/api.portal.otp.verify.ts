import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import bcrypt from "bcryptjs";
import prisma from "../db.server";
import { createPortalToken } from "../lib/portal-auth.server";
import { getPortalCorsHeaders, withCors } from "../lib/portal-cors.server";
import { checkRateLimit, rateLimitResponse } from "../lib/rate-limit.server";
import { portalOtpCounter } from "../lib/observability/metrics.server";
import { portalLogger } from "../lib/observability/logger.server";

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_VERIFY_ATTEMPTS = 5;
// Account-level lockout: across ALL sessions for the same lookup value (email/phone)
// in the last hour, if total failed verification attempts hit this threshold, refuse
// to accept any more OTP submissions until the window passes. Defends against the
// "spin up N parallel sessions × 5 attempts each" brute force that the per-session
// limit alone allowed (P0 finding from QA audit).
const ACCOUNT_LOCK_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const ACCOUNT_LOCK_MAX_FAILURES = 15; // ≈ 3 sessions worth before locking
// bcrypt cost factor — 10 is industry standard. Verifying takes ~50ms which makes
// brute-force significantly more expensive while remaining responsive for users.
const BCRYPT_COST = 10;

/** Legacy SHA-256 detection — pre-bcrypt rollout sessions had hex-only hashes. */
function isLegacySha256(hash: string): boolean {
  return /^[0-9a-f]{64}$/i.test(hash);
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

  const rl = await checkRateLimit(request, "portal.otp.verify");
  if (!rl.allowed) {
    portalOtpCounter.add(1, { action: "verify", outcome: "rate_limited" });
    return withCors(rateLimitResponse(rl.retryAfterMs), request);
  }

  try {
    const { sessionId, otp } = await request.json();
    if (!sessionId || !otp) {
      portalOtpCounter.add(1, { action: "verify", outcome: "bad_request" });
      return withCors(
        Response.json({ error: "sessionId and otp required" }, { status: 400 }),
        request,
      );
    }

    const session = await prisma.lookupSession.findUnique({ where: { id: sessionId } });
    if (!session || session.expiresAt < new Date()) {
      portalOtpCounter.add(1, { action: "verify", outcome: "invalid_session" });
      return withCors(
        Response.json({ error: "Invalid or expired session" }, { status: 400 }),
        request,
      );
    }

    if (session.attemptsCount >= MAX_VERIFY_ATTEMPTS) {
      portalOtpCounter.add(1, { action: "verify", outcome: "locked" });
      return withCors(
        Response.json({ error: "Too many attempts. Please request a new code." }, { status: 429 }),
        request,
      );
    }

    // Account-level lockout — sum failed verification attempts across ALL sessions for
    // the same email/phone in the last hour. If ≥ ACCOUNT_LOCK_MAX_FAILURES, refuse to
    // accept any more verification attempts. Defends against the "spin up N parallel
    // sessions" brute force the per-session 5-attempt cap previously allowed.
    const lockoutSince = new Date(Date.now() - ACCOUNT_LOCK_WINDOW_MS);
    const recentSessionsForValue = await prisma.lookupSession.findMany({
      where: {
        shopId: session.shopId,
        lookupValueHash: session.lookupValueHash,
        createdAt: { gte: lockoutSince },
      },
      select: { attemptsCount: true, verifiedAt: true },
    });
    const totalRecentFailures = recentSessionsForValue
      .filter((s) => !s.verifiedAt) // exclude successfully-verified sessions
      .reduce((sum, s) => sum + (s.attemptsCount ?? 0), 0);
    if (totalRecentFailures >= ACCOUNT_LOCK_MAX_FAILURES) {
      portalOtpCounter.add(1, { action: "verify", outcome: "account_locked" });
      return withCors(
        Response.json(
          {
            error:
              "Too many failed verification attempts on this contact. Please try again in an hour.",
            accountLocked: true,
          },
          { status: 429 },
        ),
        request,
      );
    }

    if (!session.otpSentAt || Date.now() - session.otpSentAt.getTime() > OTP_TTL_MS) {
      portalOtpCounter.add(1, { action: "verify", outcome: "expired" });
      return withCors(
        Response.json({ error: "Code has expired. Please request a new one." }, { status: 400 }),
        request,
      );
    }

    if (!session.otpTarget) {
      portalOtpCounter.add(1, { action: "verify", outcome: "missing_code" });
      return withCors(
        Response.json(
          { error: "No verification code found. Please request one first." },
          { status: 400 },
        ),
        request,
      );
    }

    const submittedOtp = String(otp);
    const storedHash = session.otpTarget;
    let isValid = false;
    if (isLegacySha256(storedHash)) {
      // Legacy session created before bcrypt rollout. Compare with the old SHA-256
      // method, then on success transparently re-hash to bcrypt for the next time.
      // (Stored hash gets cleared by the verify-success branch anyway.)
      const crypto = await import("node:crypto");
      const submittedSha = crypto.createHash("sha256").update(submittedOtp).digest("hex");
      try {
        const a = Buffer.from(submittedSha, "hex");
        const b = Buffer.from(storedHash, "hex");
        isValid = a.length === b.length && crypto.timingSafeEqual(a, b);
        // unreachable: Buffer.from(hex) + length-checked timingSafeEqual cannot throw
        /* v8 ignore start */
      } catch {
        isValid = false;
      }
      /* v8 ignore stop */
    } else {
      // bcrypt comparison — constant-time by design, slow enough to deter brute force.
      try {
        isValid = await bcrypt.compare(submittedOtp, storedHash);
      } catch {
        isValid = false;
      }
    }

    if (!isValid) {
      portalOtpCounter.add(1, { action: "verify", outcome: "invalid_code" });
      const updatedSession = await prisma.lookupSession.update({
        where: { id: sessionId },
        data: { attemptsCount: session.attemptsCount + 1 },
      });
      const attemptsRemaining = Math.max(0, MAX_VERIFY_ATTEMPTS - updatedSession.attemptsCount);
      if (attemptsRemaining === 0) {
        return withCors(
          Response.json(
            {
              error: "Too many attempts. Please request a new code.",
              attemptsRemaining: 0,
              locked: true,
            },
            { status: 429 },
          ),
          request,
        );
      }
      return withCors(
        Response.json({ error: "Invalid verification code", attemptsRemaining }, { status: 400 }),
        request,
      );
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

    portalOtpCounter.add(1, { action: "verify", outcome: "success" });
    return withCors(Response.json({ portalToken, sessionId: session.id }), request);
  } catch (err) {
    portalOtpCounter.add(1, { action: "verify", outcome: "error" });
    portalLogger.error({ err }, "Portal OTP verify failed");
    return withCors(Response.json({ error: "Verification failed" }, { status: 500 }), request);
  }
};
