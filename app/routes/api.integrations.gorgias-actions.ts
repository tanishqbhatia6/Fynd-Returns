/**
 * Gorgias Helpdesk Integration — Actions Endpoint
 *
 * Allows support agents to take actions on returns from within Gorgias.
 *
 * POST /api/integrations/gorgias-actions
 * Body: { shop, api_key, action, returnId, note?, rejectionReason? }
 */
import type { ActionFunctionArgs } from "react-router";
import crypto from "node:crypto";
import prisma from "../db.server";
import { decryptIfEncrypted } from "../lib/encryption.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  let body: Record<string, string>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const shopDomain = body.shop || "";
  const apiKey = body.api_key || "";
  const actionType = body.action || "";
  const returnId = body.returnId || "";

  if (!shopDomain || !returnId || !actionType) {
    return Response.json({ error: "Missing required fields: shop, returnId, action" }, { status: 400 });
  }

  // Verify shop & auth
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: shopDomain.includes(".") ? shopDomain : `${shopDomain}.myshopify.com` },
    include: { settings: true },
  });

  if (!shop?.settings?.gorgiasEnabled) {
    return Response.json({ error: "Gorgias integration not enabled" }, { status: 403 });
  }

  // Require an API key — previously the absence of a configured key allowed open
  // access. With the multi-tenant fix, key auth is mandatory.
  if (!shop.settings.gorgiasApiKey) {
    return Response.json({ error: "Gorgias API key not configured for this shop" }, { status: 403 });
  }
  // Timing-safe compare against the decrypted stored key.
  const storedPlain = decryptIfEncrypted(shop.settings.gorgiasApiKey) ?? "";
  let keyOk = false;
  try {
    const a = Buffer.from(apiKey, "utf8");
    const b = Buffer.from(storedPlain, "utf8");
    keyOk = a.length === b.length && crypto.timingSafeEqual(a, b);
  } catch { keyOk = false; }
  if (!keyOk) {
    return Response.json({ error: "Invalid API key" }, { status: 401 });
  }

  // Find the return case — scoped by shop.id (the API key proves ownership of THIS
  // shop, so requesting a returnId from a different shop returns 404). Previously the
  // shop param was user-controlled and the key check was lenient — now they're tied.
  const returnCase = await prisma.returnCase.findFirst({
    where: { id: returnId, shopId: shop.id },
  });

  if (!returnCase) {
    return Response.json({ error: "Return not found" }, { status: 404 });
  }

  try {
    switch (actionType) {
      case "approve": {
        if (!["initiated", "pending"].includes(returnCase.status)) {
          return Response.json({ error: `Cannot approve return in "${returnCase.status}" status` }, { status: 400 });
        }
        await prisma.$transaction([
          prisma.returnCase.update({
            where: { id: returnId },
            data: { status: "approved" },
          }),
          prisma.returnEvent.create({
            data: {
              returnCaseId: returnId,
              source: "gorgias",
              eventType: "status_changed",
              payloadJson: JSON.stringify({ from: returnCase.status, to: "approved", by: "gorgias_agent" }),
            },
          }),
        ]);
        return Response.json({ success: true, message: "Return approved" });
      }

      case "reject": {
        if (!["initiated", "pending"].includes(returnCase.status)) {
          return Response.json({ error: `Cannot reject return in "${returnCase.status}" status` }, { status: 400 });
        }
        const rejectionReason = body.rejectionReason || "Rejected via Gorgias";
        await prisma.$transaction([
          prisma.returnCase.update({
            where: { id: returnId },
            data: { status: "rejected", rejectionReason },
          }),
          prisma.returnEvent.create({
            data: {
              returnCaseId: returnId,
              source: "gorgias",
              eventType: "status_changed",
              payloadJson: JSON.stringify({ from: returnCase.status, to: "rejected", reason: rejectionReason, by: "gorgias_agent" }),
            },
          }),
        ]);
        return Response.json({ success: true, message: "Return rejected" });
      }

      case "add_note": {
        const note = body.note || "";
        if (!note) {
          return Response.json({ error: "Note is required" }, { status: 400 });
        }
        const existingNotes = returnCase.adminNotes || "";
        const timestamp = new Date().toISOString().slice(0, 16).replace("T", " ");
        const updatedNotes = existingNotes
          ? `${existingNotes}\n[${timestamp} via Gorgias] ${note}`
          : `[${timestamp} via Gorgias] ${note}`;

        await prisma.$transaction([
          prisma.returnCase.update({
            where: { id: returnId },
            data: { adminNotes: updatedNotes },
          }),
          prisma.returnEvent.create({
            data: {
              returnCaseId: returnId,
              source: "gorgias",
              eventType: "note_added",
              payloadJson: JSON.stringify({ note, by: "gorgias_agent" }),
            },
          }),
        ]);
        return Response.json({ success: true, message: "Note added" });
      }

      case "get_timeline": {
        const events = await prisma.returnEvent.findMany({
          where: { returnCaseId: returnId },
          orderBy: { happenedAt: "desc" },
          take: 20,
        });
        return Response.json({
          success: true,
          timeline: events.map(e => ({
            type: e.eventType,
            source: e.source,
            timestamp: e.happenedAt.toISOString(),
            details: e.payloadJson ? JSON.parse(e.payloadJson) : null,
          })),
        });
      }

      default:
        return Response.json({ error: `Unknown action: ${actionType}` }, { status: 400 });
    }
  } catch (err) {
    console.error("Gorgias action error:", err);
    return Response.json({ error: "Action failed" }, { status: 500 });
  }
};
