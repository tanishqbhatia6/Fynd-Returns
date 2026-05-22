import type { FyndJourneyFilter } from "./fynd-payload.server";

type ReturnItemWithFyndIds = {
  fyndBagId?: string | null;
  fyndShipmentId?: string | null;
};

type ReturnWithFyndScope = {
  fyndShipmentId?: string | null;
  items?: ReturnItemWithFyndIds[] | null;
};

export function buildFyndJourneyFilterForReturn(
  returnCase: ReturnWithFyndScope | null | undefined,
): FyndJourneyFilter | undefined {
  const filter: FyndJourneyFilter = {
    bagIds: (returnCase?.items ?? []).map((item) => item.fyndBagId ?? null),
    shipmentIds: [
      returnCase?.fyndShipmentId ?? null,
      ...(returnCase?.items ?? []).map((item) => item.fyndShipmentId ?? null),
    ],
  };

  return hasFyndJourneyFilter(filter) ? filter : undefined;
}

function hasFyndJourneyFilter(filter: FyndJourneyFilter | null | undefined): boolean {
  return Boolean(
    filter &&
      ((filter.bagIds ?? []).some((id) => String(id ?? "").trim()) ||
        (filter.shipmentIds ?? []).some((id) => String(id ?? "").trim())),
  );
}

export function fyndObjectMatchesReturnScope(
  obj: Record<string, unknown>,
  filter: FyndJourneyFilter | undefined,
): boolean {
  if (!hasFyndJourneyFilter(filter)) return true;

  const wantedBagIds = new Set(
    (filter?.bagIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean),
  );
  const wantedShipmentIds = new Set(
    (filter?.shipmentIds ?? []).map((id) => String(id ?? "").trim()).filter(Boolean),
  );

  const nestedBags = Array.isArray(obj.bags) ? (obj.bags as Record<string, unknown>[]) : [];
  const allBagCandidates = [obj, ...nestedBags];
  for (const bag of allBagCandidates) {
    const affiliateBagDetails =
      bag.affiliate_bag_details != null && typeof bag.affiliate_bag_details === "object"
        ? (bag.affiliate_bag_details as Record<string, unknown>)
        : null;
    const bagCandidates = [
      bag.bag_id,
      bag.bagId,
      bag.id,
      bag.identifier,
      bag.affiliate_bag_id,
      affiliateBagDetails?.affiliate_bag_id,
      affiliateBagDetails?.bag_id,
    ]
      .map((id) => String(id ?? "").trim())
      .filter(Boolean);
    if (bagCandidates.some((id) => wantedBagIds.has(id))) return true;
  }
  if (wantedBagIds.size > 0) return false;

  const shipmentCandidates = [
    obj.shipment_id,
    obj.shipmentId,
    obj.channel_shipment_id,
    obj.id,
    obj.identifier,
  ]
    .map((id) => String(id ?? "").trim())
    .filter(Boolean);
  return shipmentCandidates.some((id) => wantedShipmentIds.has(id));
}
