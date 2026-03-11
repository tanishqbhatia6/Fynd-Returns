/**
 * Shared helpers for external API endpoints:
 * - Standard response envelope
 * - Pagination builder
 * - Error factories
 * - Return data sanitization
 */

// ── Response Envelope ──

export function apiSuccess<T>(data: T, meta?: PaginationMeta) {
  return Response.json({ data, ...(meta ? { meta } : {}), errors: [] });
}

export function apiCreated<T>(data: T) {
  return Response.json({ data, errors: [] }, { status: 201 });
}

export function apiError(
  status: number,
  code: string,
  message: string,
) {
  return Response.json({ error: { code, message } }, { status });
}

// ── Pagination ──

export type PaginationMeta = {
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasNextPage: boolean;
};

export function parsePagination(url: URL): { page: number; pageSize: number; skip: number } {
  let page = parseInt(url.searchParams.get("page") || "1", 10);
  let pageSize = parseInt(url.searchParams.get("pageSize") || "25", 10);
  if (isNaN(page) || page < 1) page = 1;
  if (isNaN(pageSize) || pageSize < 1) pageSize = 25;
  if (pageSize > 100) pageSize = 100;
  return { page, pageSize, skip: (page - 1) * pageSize };
}

export function buildMeta(page: number, pageSize: number, totalCount: number): PaginationMeta {
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  return {
    page,
    pageSize,
    totalCount,
    totalPages,
    hasNextPage: page < totalPages,
  };
}

// ── Sanitize Return for External Consumption ──

export function sanitizeReturn(rc: Record<string, unknown>) {
  // Strip large/sensitive fields
  const { fyndPayloadJson, customerMediaJson, ...rest } = rc;
  return rest;
}

export function sanitizeReturnSummary(rc: Record<string, unknown>) {
  return {
    id: rc.id,
    returnRequestNo: rc.returnRequestNo,
    shopifyOrderId: rc.shopifyOrderId,
    shopifyOrderName: rc.shopifyOrderName,
    status: rc.status,
    resolutionType: rc.resolutionType,
    customerName: rc.customerName,
    customerEmail: rc.customerEmailNorm,
    currency: rc.currency,
    itemCount: Array.isArray(rc.items) ? rc.items.length : 0,
    createdAt: rc.createdAt,
    updatedAt: rc.updatedAt,
  };
}

export function sanitizeReturnDetail(rc: Record<string, unknown> & { items?: unknown[]; events?: unknown[] }) {
  return {
    id: rc.id,
    returnRequestNo: rc.returnRequestNo,
    shopifyOrderId: rc.shopifyOrderId,
    shopifyOrderName: rc.shopifyOrderName,
    shopifyReturnId: rc.shopifyReturnId,
    status: rc.status,
    refundStatus: rc.refundStatus,
    resolutionType: rc.resolutionType,
    customerName: rc.customerName,
    customerEmail: rc.customerEmailNorm,
    customerPhone: rc.customerPhoneNorm,
    customerCity: rc.customerCity,
    customerCountry: rc.customerCountry,
    currency: rc.currency,
    rejectionReason: rc.rejectionReason,
    adminNotes: rc.adminNotes,
    notesForCustomer: rc.notesForCustomer,
    isGreenReturn: rc.isGreenReturn,
    fyndReturnId: rc.fyndReturnId,
    fyndReturnNo: rc.fyndReturnNo,
    fyndCurrentStatus: rc.fyndCurrentStatus,
    returnAwb: rc.returnAwb,
    forwardAwb: rc.forwardAwb,
    createdAt: rc.createdAt,
    updatedAt: rc.updatedAt,
    items: (rc.items || []).map((item: any) => ({
      id: item.id,
      shopifyLineItemId: item.shopifyLineItemId,
      title: item.title,
      variantTitle: item.variantTitle,
      sku: item.sku,
      price: item.price,
      qty: item.qty,
      reasonCode: item.reasonCode,
      condition: item.condition,
      notes: item.notes,
    })),
    events: (rc.events || []).map((evt: any) => ({
      id: evt.id,
      source: evt.source,
      eventType: evt.eventType,
      happenedAt: evt.happenedAt,
    })),
  };
}

// ── Settings Sanitization ──

export function sanitizeSettings(s: Record<string, unknown>) {
  return {
    returnWindowDays: s.returnWindowDays,
    autoApproveEnabled: s.autoApproveEnabled,
    autoRefundEnabled: s.autoRefundEnabled,
    photoRequired: s.photoRequired,
    refundPaymentMethod: s.refundPaymentMethod,
    returnFeeAmount: s.returnFeeAmount != null ? String(s.returnFeeAmount) : null,
    returnFeeCurrency: s.returnFeeCurrency,
    bonusCreditEnabled: s.bonusCreditEnabled,
    bonusCreditPct: s.bonusCreditPct,
    greenReturnsEnabled: s.greenReturnsEnabled,
    portalExchangeEnabled: s.portalExchangeEnabled,
    shopCurrency: s.shopCurrency,
    shopTimezone: s.shopTimezone,
    discountCodeRefundEnabled: s.discountCodeRefundEnabled,
  };
}
