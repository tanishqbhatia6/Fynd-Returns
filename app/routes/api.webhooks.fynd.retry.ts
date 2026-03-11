/**
 * Fynd Webhook Retry API
 *
 * Reprocesses ignored/error webhooks from stored rawPayload.
 * - Single retry: POST { logId: "..." }
 * - Bulk retry: POST { action: "retry_all_ignored" }
 */

import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const MAX_BULK_RETRY = 500;

export const action = async ({ request }: ActionFunctionArgs) => {
  await authenticate.admin(request);

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const { processFyndWebhook, unwrapFyndWebhookPayload } = await import(
    "../lib/fynd-webhook.server"
  );

  const body = (await request.json()) as Record<string, unknown>;

  // Single retry
  if (typeof body.logId === "string") {
    const log = await prisma.fyndWebhookLog.findUnique({
      where: { id: body.logId },
    });
    if (!log) {
      return Response.json({ error: "Log not found" }, { status: 404 });
    }
    if (!log.rawPayload) {
      return Response.json(
        { error: "No rawPayload stored — cannot retry" },
        { status: 400 },
      );
    }

    try {
      const { payload, eventType } = unwrapFyndWebhookPayload(log.rawPayload);
      const result = await processFyndWebhook(
        payload,
        log.rawPayload,
        eventType,
      );
      // If the reprocess produced a different result, delete the old "ignored" log
      if (result.ok && result.action !== "ignored" && result.action !== log.action) {
        try {
          await prisma.fyndWebhookLog.delete({ where: { id: log.id } });
        } catch {
          /* non-fatal */
        }
      }
      return Response.json({
        ok: result.ok,
        action: result.ok ? result.action : undefined,
        error: !result.ok ? result.error : undefined,
        returnCaseId: result.ok ? result.returnCaseId : undefined,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return Response.json({ ok: false, error: msg }, { status: 500 });
    }
  }

  // Bulk retry
  if (body.action === "retry_all_ignored") {
    const ignoredLogs = await prisma.fyndWebhookLog.findMany({
      where: {
        action: "ignored",
        rawPayload: { not: null },
      },
      orderBy: { createdAt: "desc" },
      take: MAX_BULK_RETRY,
      select: { id: true, rawPayload: true },
    });

    let succeeded = 0;
    let stillIgnored = 0;
    let failed = 0;

    for (const log of ignoredLogs) {
      if (!log.rawPayload) {
        failed++;
        continue;
      }
      try {
        const { payload, eventType } = unwrapFyndWebhookPayload(
          log.rawPayload,
        );
        const result = await processFyndWebhook(
          payload,
          log.rawPayload,
          eventType,
        );
        if (result.ok && result.action !== "ignored") {
          succeeded++;
          try {
            await prisma.fyndWebhookLog.delete({ where: { id: log.id } });
          } catch {
            /* non-fatal */
          }
        } else {
          stillIgnored++;
        }
      } catch {
        failed++;
      }
    }

    return Response.json({
      ok: true,
      total: ignoredLogs.length,
      succeeded,
      stillIgnored,
      failed,
    });
  }

  return Response.json({ error: "Invalid request body" }, { status: 400 });
};
