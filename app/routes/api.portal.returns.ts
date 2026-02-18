import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { verifyPortalToken } from "../lib/portal-auth.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const auth = request.headers.get("Authorization");
  const token = auth?.replace("Bearer ", "");
  if (!token) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = verifyPortalToken(token);
  if (!payload) {
    return Response.json({ error: "Invalid token" }, { status: 401 });
  }

  const session = await prisma.lookupSession.findUnique({
    where: { id: payload.sessionId as string },
  });
  if (!session?.verifiedAt) {
    return Response.json({ error: "Session not verified" }, { status: 401 });
  }

  let returnIds: string[] = [];
  try {
    returnIds = JSON.parse(session.matchedReturnIds || "[]");
  } catch {
    // ignore
  }

  const returns = returnIds.length
    ? await prisma.returnCase.findMany({
        where: { id: { in: returnIds }, shopId: payload.shopId as string },
        include: {
          items: true,
          events: { orderBy: { happenedAt: "desc" }, take: 10 },
        },
        orderBy: { createdAt: "desc" },
      })
    : [];

  return Response.json({ returns });
};
