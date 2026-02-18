import type { ActionFunctionArgs } from "react-router";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  try {
    const { sessionId } = await request.json();
    if (!sessionId) {
      return Response.json({ error: "sessionId required" }, { status: 400 });
    }

    const session = await prisma.lookupSession.findUnique({ where: { id: sessionId } });
    if (!session || session.expiresAt < new Date()) {
      return Response.json({ error: "Invalid or expired session" }, { status: 400 });
    }
    if (session.attemptsCount >= 5) {
      return Response.json({ error: "Too many OTP attempts" }, { status: 429 });
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000));
    if (process.env.NODE_ENV !== "production") {
      console.log("OTP (dev):", otp);
    }

    await prisma.lookupSession.update({
      where: { id: sessionId },
      data: {
        otpTarget: otp,
        otpSentAt: new Date(),
        attemptsCount: session.attemptsCount + 1,
      },
    });

    return Response.json({ success: true });
  } catch (err) {
    console.error("Portal OTP send:", err);
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }
};
