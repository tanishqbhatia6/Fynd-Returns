import { redirect } from "react-router";
import prisma from "../../db.server";
import { withSpan, startTimer } from "../observability/tracing.server";
import { returnActionCounter, returnActionDuration, appErrorCounter } from "../observability/metrics.server";
import { annotateSLO } from "../observability/slo.server";
import { createFyndClientOrError } from "../fynd.server";
import { isRedirectResponse, extractErrorMessage, enrichFyndError } from "../return-action-errors.server";
import type { ReturnActionHandler } from "./types";

export const handleRefreshFyndDetails: ReturnActionHandler = async (ctx) => {
  const { id, returnCase, shop, elapsed } = ctx;
  return await withSpan("return.action.refresh_fynd_details", {
    "return.id": returnCase.id,
    "return.request_no": returnCase.returnRequestNo || "",
    "action.type": "refresh_fynd_details",
  }, async () => {
    const actionTimer = startTimer();
    try {
      const externalOrderId = (returnCase.shopifyOrderName ?? "").replace(/^#/, "").trim();
      if (!externalOrderId || returnCase.shopifyOrderId?.startsWith("manual:")) {
        returnActionCounter.add(1, { action: "refresh_fynd_details", outcome: "error" });
        returnActionDuration.record(actionTimer(), { action: "refresh_fynd_details" });
        throw redirect(`/app/returns/${id}?fyndError=${encodeURIComponent("No order number. Refresh from Fynd requires a valid order number.")}`);
      }
      const settings = shop.settings as (NonNullable<unknown> & { fyndApiType?: string | null }) | undefined;
      const fyndResult = settings
        ? await createFyndClientOrError(settings as never, { requirePlatform: true })
        : { ok: false as const, error: "Fynd is not configured. Go to Settings → Integrations." };
      if (!fyndResult.ok) {
        returnActionCounter.add(1, { action: "refresh_fynd_details", outcome: "error" });
        returnActionDuration.record(actionTimer(), { action: "refresh_fynd_details" });
        throw redirect(`/app/returns/${id}?fyndError=${encodeURIComponent(fyndResult.error)}`);
      }
      const fyndClient = fyndResult.client;
      if (!("searchShipmentsByExternalOrderId" in fyndClient)) {
        returnActionCounter.add(1, { action: "refresh_fynd_details", outcome: "error" });
        returnActionDuration.record(actionTimer(), { action: "refresh_fynd_details" });
        throw redirect(`/app/returns/${id}?fyndError=${encodeURIComponent("Refresh from Fynd requires Platform API. Configure in Settings → Integrations.")}`);
      }
      try {
        const searchRes = await fyndClient.searchShipmentsByExternalOrderId(externalOrderId, {
          searchType: "external_order_id",
          groupEntity: "shipments",
          pageNo: 1,
          pageSize: 20,
          parentViewSlug: "all",
          childViewSlug: "all",
          sortType: "sla_asc",
        });
        const items = searchRes?.items ?? searchRes?.shipments ?? (searchRes as { data?: { items?: unknown[] } })?.data?.items ?? [];
        if (!Array.isArray(items) || items.length === 0) {
          throw new Error(`No shipments found for order ${externalOrderId}. Check order number and date range.`);
        }
        let payload: unknown = searchRes;
        const fyndOrderId = (searchRes as { orderId?: string; shipmentId?: string }).orderId ?? (searchRes as { orderId?: string; shipmentId?: string }).shipmentId ?? null;
        if (fyndOrderId && "getShipments" in fyndClient) {
          try {
            const fullShipments = await fyndClient.getShipments(fyndOrderId);
            if (fullShipments != null) {
              const fullList = Array.isArray(fullShipments)
                ? fullShipments
                : (fullShipments as { items?: unknown[] })?.items ?? (fullShipments as { shipments?: unknown[] })?.shipments ?? [];
              if (fullList.length > 0) {
                payload = fullShipments;
              }
            }
          } catch {
            /* fall back */
          }
        }
        const payloadJson = payload != null ? JSON.stringify(payload) : null;

        const returnLogisticsData: Record<string, unknown> = {};
        const allItems = Array.isArray(items) ? items as Record<string, unknown>[] : [];
        const returnShipment = allItems.find((s) => {
          const jt = String(s.journey_type ?? "").toLowerCase();
          const st = String(s.status ?? s.shipment_status ?? "").toLowerCase();
          return jt === "return" || st.startsWith("return_");
        });
        if (returnShipment) {
          const dp = (returnShipment.delivery_partner_details ?? returnShipment.dp_details ?? {}) as Record<string, unknown>;
          const meta = (returnShipment.meta ?? {}) as Record<string, unknown>;
          const inv = returnShipment.invoice as Record<string, unknown> | undefined;
          const invLinks = (inv?.links ?? {}) as Record<string, unknown>;
          const rCarrier = String(dp.display_name ?? dp.name ?? returnShipment.dp_name ?? meta.cp_name ?? "").trim() || null;
          const rAwbRaw = dp.awb_no ?? returnShipment.awb_no ?? meta.awb_no ?? meta.awb;
          const rAwb = typeof rAwbRaw === "string" && rAwbRaw.trim() ? rAwbRaw.trim() : null;
          const rTrackUrl = String(returnShipment.tracking_url ?? returnShipment.track_url ?? dp.track_url ?? dp.tracking_url ?? meta.tracking_url ?? "").trim() || null;
          const rLabelUrl = inv ? (String(inv.label_url ?? invLinks.label ?? "").trim() || null) : null;
          const rInvoiceUrl = inv ? (String(inv.invoice_url ?? invLinks.invoice_a4 ?? "").trim() || null) : null;
          if (rCarrier || rAwb || rTrackUrl || rLabelUrl) {
            returnLogisticsData.returnLabelJson = JSON.stringify({
              carrier: rCarrier,
              trackingNumber: rAwb,
              trackingUrl: rTrackUrl,
              labelUrl: rLabelUrl,
              invoiceUrl: rInvoiceUrl,
              source: "fynd_api_refresh",
            });
            if (rAwb) returnLogisticsData.returnAwb = rAwb;
          }
        }

        await prisma.returnCase.update({
          where: { id },
          data: { fyndPayloadJson: payloadJson ?? undefined, ...(fyndOrderId && { fyndOrderId }), ...returnLogisticsData },
        });

        returnActionCounter.add(1, { action: "refresh_fynd_details", outcome: "success" });
        returnActionDuration.record(actionTimer(), { action: "refresh_fynd_details" });
        annotateSLO("api_latency_p99", { durationMs: elapsed() });

        throw redirect(`/app/returns/${id}?fyndRefresh=1`);
      } catch (err) {
        if (isRedirectResponse(err)) throw err;
        if (err instanceof Response) throw err;
        const rawMsg = await extractErrorMessage(err);
        const msg = enrichFyndError(rawMsg);
        returnActionCounter.add(1, { action: "refresh_fynd_details", outcome: "error" });
        returnActionDuration.record(actionTimer(), { action: "refresh_fynd_details" });
        throw redirect(`/app/returns/${id}?fyndError=${encodeURIComponent(msg)}`);
      }
    } catch (err) {
      if (isRedirectResponse(err) || err instanceof Response) throw err;
      returnActionCounter.add(1, { action: "refresh_fynd_details", outcome: "error" });
      appErrorCounter.add(1, { action: "refresh_fynd_details" });
      returnActionDuration.record(actionTimer(), { action: "refresh_fynd_details" });
      throw err;
    }
  });
};
