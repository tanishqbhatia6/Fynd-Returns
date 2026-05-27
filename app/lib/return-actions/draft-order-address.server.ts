import type { MailingAddressDisplay, OrderForPortal } from "../shopify-admin.server";
import type { ReturnCaseWithItems } from "./types";

type DraftOrderAddress = {
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  country?: string;
  zip?: string;
  firstName?: string;
  lastName?: string;
  phone?: string;
  company?: string;
};

type DraftOrderAddressInput = {
  shippingAddress?: DraftOrderAddress;
  billingAddress: DraftOrderAddress;
};

function clean(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

function splitName(name: string | null | undefined): { firstName?: string; lastName?: string } {
  const cleaned = clean(name);
  if (!cleaned) return {};
  const [first, ...rest] = cleaned.split(/\s+/);
  return {
    firstName: first,
    lastName: rest.length > 0 ? rest.join(" ") : undefined,
  };
}

function normalizeAddress(
  source: MailingAddressDisplay | null | undefined,
  fallback: { customerName?: string | null; phone?: string | null; forceName?: boolean },
): DraftOrderAddress {
  const fallbackName = splitName(fallback.customerName);
  const sourceName = splitName(source?.name);
  const firstName =
    clean(source?.firstName) ??
    sourceName.firstName ??
    fallbackName.firstName ??
    (fallback.forceName ? "Customer" : undefined);
  const lastName = clean(source?.lastName) ?? sourceName.lastName ?? fallbackName.lastName;

  const address: DraftOrderAddress = {
    address1: clean(source?.address1),
    address2: clean(source?.address2),
    city: clean(source?.city),
    province: clean(source?.province) ?? clean(source?.provinceCode),
    country: clean(source?.country) ?? clean(source?.countryCode),
    zip: clean(source?.zip),
    firstName,
    lastName,
    phone: clean(source?.phone) ?? clean(fallback.phone),
    company: clean(source?.company),
  };

  return Object.fromEntries(
    Object.entries(address).filter(([, value]) => value !== undefined),
  ) as DraftOrderAddress;
}

export function buildDraftOrderAddresses(
  order: Pick<OrderForPortal, "shippingAddress" | "billingAddress" | "phone">,
  returnCase: Pick<ReturnCaseWithItems, "customerName" | "customerPhoneNorm">,
): DraftOrderAddressInput {
  const phone = returnCase.customerPhoneNorm ?? order.phone ?? null;
  const shippingSource = order.shippingAddress ?? order.billingAddress ?? null;
  const billingSource = order.billingAddress ?? order.shippingAddress ?? null;
  const fallback = { customerName: returnCase.customerName, phone };

  return {
    ...(shippingSource
      ? { shippingAddress: normalizeAddress(shippingSource, { ...fallback, forceName: false }) }
      : {}),
    billingAddress: normalizeAddress(billingSource, { ...fallback, forceName: true }),
  };
}
