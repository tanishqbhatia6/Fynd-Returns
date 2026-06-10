/**
 * Shared context for extracted return-action handlers.
 *
 * The action() entrypoint in `app/routes/api.returns.$id.actions.ts` builds
 * one `ReturnHandlerContext` per request and dispatches to a handler. Each
 * handler is a free function — no shared mutable state, easy to test.
 *
 * Behavior is preserved bit-for-bit: handlers continue to `throw redirect(...)`,
 * call the same observability helpers, and emit the same metrics.
 */

import type { ReturnCase, ReturnItem } from "@prisma/client";
import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

export type ReturnCaseWithItems = ReturnCase & { items: ReturnItem[] };

export type ShopWithSettings = {
  id: string;
  shopDomain: string;
  settings: unknown;
};

export type ReturnActionBody = {
  action: string;
  status?: string;
  note?: string;
  notesForCustomer?: string;
  refund?: boolean;
  rejectionReason?: string;
  locationId?: string;
  refundMethod?: string;
  storeCreditPct?: number;
  bonusAmount?: number;
  resolutionType?: string;
  exchangeItems?: Array<{ variantId: string; quantity: number }>;
  splitMode?: string;
  splitScAmount?: number;
  splitOrigAmount?: number;
  carrier?: string;
  trackingNumber?: string;
  labelUrl?: string;
  qrCodeUrl?: string;
  returnInstructions?: string;
  customerAddress1?: string;
  customerAddress2?: string;
  customerCity?: string;
  customerProvince?: string;
  customerZip?: string;
  customerCountry?: string;
  customerLandmark?: string;
};

export type ReturnHandlerContext = {
  /** Stable return-case ID (== params.id; included for ergonomics). */
  id: string;
  /** Pre-loaded ReturnCase with its items. */
  returnCase: ReturnCaseWithItems;
  /** Shop record with settings. */
  shop: ShopWithSettings;
  /** Authenticated Shopify admin, optionally with raw-fetch credentials attached. */
  admin: AdminApiContext;
  /** Authenticated session shop domain. */
  shopDomain: string;
  /** Authenticated user email if available (admin acting). */
  sessionEmail: string | null;
  /** True iff returnCase.status is in TERMINAL_STATUSES. */
  isTerminal: boolean;
  /** ms-since-action-started — for SLO observability. */
  elapsed: () => number;
  /** Helper to write a returnEvent of source=admin (used by closeShopifyReturnBestEffort). */
  logShopifyReturnEvent: (evt: { eventType: string; payloadJson: string }) => Promise<void>;
};

/** Handler signature: takes context and parsed body, returns or throws a Response. */
export type ReturnActionHandler = (
  ctx: ReturnHandlerContext,
  body: ReturnActionBody,
) => Promise<Response>;
