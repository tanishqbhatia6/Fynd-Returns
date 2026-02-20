import type { LoaderFunctionArgs } from "react-router";
import prisma from "../db.server";
import { verifyPortalToken } from "../lib/portal-auth.server";
import { getPortalCorsHeaders, withCors } from "../lib/portal-cors.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getPortalCorsHeaders(request) });
  }
  const auth = request.headers.get("Authorization");
  const token = auth?.replace("Bearer ", "");
  if (!token) {
    return withCors(Response.json({ error: "Unauthorized" }, { status: 401 }), request);
  }

  const payload = verifyPortalToken(token);
  if (!payload) {
    return withCors(Response.json({ error: "Invalid token" }, { status: 401 }), request);
  }

  const session = await prisma.lookupSession.findUnique({
    where: { id: payload.sessionId as string },
  });
  if (!session?.verifiedAt) {
    return withCors(Response.json({ error: "Session not verified" }, { status: 401 }), request);
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

  return withCors(Response.json({ returns }), request);
};
