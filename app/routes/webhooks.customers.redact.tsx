import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * GDPR: customers/redact
 *
 * Triggered when a store owner requests deletion of a customer's personal data.
 * We must anonymize or delete all personally identifiable information
 * within 30 days of receiving this webhook.
 */
/**
 * Normalize a phone number for matching: strip everything except digits and a leading +.
 * Phones in the DB go through the same transform when stored — this lets us match
 * "+1 (555) 123-4567" against "+15551234567" without false positives.
 */
function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const cleaned = trimmed.replace(/[^\d+]/g, "");
  return cleaned || null;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  const customerId = payload.customer?.id?.toString() ?? "";
  const customerEmail = payload.customer?.email?.toLowerCase().trim() ?? "";
  // GDPR fix: previously we only matched on email + a fragile substring match on
  // shopifyOrderId. Customers who provided ONLY a phone number were never found,
  // so their PII was never deleted. Now we also match by normalized phone.
  const customerPhone = normalizePhone(payload.customer?.phone ?? null);

  console.log(
    `[webhooks.customers.redact] shop=${shop} customerId=${customerId} hasEmail=${!!customerEmail} hasPhone=${!!customerPhone}`,
  );

  try {
    const shopRecord = await prisma.shop.findUnique({
      where: { shopDomain: shop },
    });
    if (!shopRecord) {
      console.log(
        `[webhooks.customers.redact] Shop not found: ${shop}, nothing to redact`,
      );
      return new Response();
    }

    // Find all return cases for this customer. We deliberately drop the previous
    // `shopifyOrderId: { contains: customerId }` match — Shopify customer IDs are
    // numeric and commonly appear as substrings of unrelated GIDs (e.g. "123" matches
    // "gid://shopify/Order/1234567"), causing false positives that redacted other
    // customers' returns.
    const conditions = [];
    if (customerEmail) conditions.push({ customerEmailNorm: customerEmail });
    if (customerPhone) conditions.push({ customerPhoneNorm: customerPhone });

    if (conditions.length === 0) {
      console.log(`[webhooks.customers.redact] No identifiers provided, skipping`);
      return new Response();
    }

    const returnCases = await prisma.returnCase.findMany({
      where: {
        shopId: shopRecord.id,
        OR: conditions,
      },
    });

    if (returnCases.length === 0) {
      console.log(
        `[webhooks.customers.redact] No return cases found for customer in shop=${shop}`,
      );
      return new Response();
    }

    // Anonymize personal data in return cases — keep the record for
    // business/accounting purposes but strip PII
    const caseIds = returnCases.map((rc) => rc.id);

    await prisma.returnCase.updateMany({
      where: { id: { in: caseIds } },
      data: {
        customerName: "[redacted]",
        customerEmailNorm: null,
        customerPhoneNorm: null,
        customerAddress1: null,
        customerAddress2: null,
        customerCity: null,
        customerProvince: null,
        customerZip: null,
        customerCountry: null,
        customerLandmark: null,
        notesForCustomer: null,
        customerNotes: null,
        customerMediaJson: null,
        giftRecipientName: null,
        giftRecipientEmail: null,
        giftMessageToSender: null,
      },
    });

    // Delete lookup sessions for this customer (by email AND phone — both can be
    // used as portal identifiers).
    const lookupValues: string[] = [];
    if (customerEmail) lookupValues.push(customerEmail);
    if (customerPhone) lookupValues.push(customerPhone);
    if (lookupValues.length > 0) {
      await prisma.lookupSession.deleteMany({
        where: {
          shopId: shopRecord.id,
          lookupValueNorm: { in: lookupValues },
        },
      });
    }

    // Anonymize notification logs for this customer's return cases
    await prisma.notificationLog.deleteMany({
      where: {
        shopId: shopRecord.id,
        returnCaseId: { in: caseIds },
      },
    });

    // Anonymize Fynd webhook logs that contain customer data — match by email,
    // phone, OR linked return case.
    const fyndLogs = await prisma.fyndWebhookLog.findMany({
      where: {
        shopDomain: shop,
        OR: [
          ...(customerEmail ? [{ customerEmail }] : []),
          ...(customerPhone ? [{ customerPhone }] : []),
          { returnCaseId: { in: caseIds } },
        ],
      },
      select: { id: true },
    });

    if (fyndLogs.length > 0) {
      await prisma.fyndWebhookLog.updateMany({
        where: { id: { in: fyndLogs.map((l) => l.id) } },
        data: {
          customerName: null,
          customerEmail: null,
          customerPhone: null,
        },
      });
    }

    console.log(
      `[webhooks.customers.redact] Redacted ${returnCases.length} return case(s) for customer in shop=${shop}`,
    );
  } catch (err) {
    console.error(
      "[webhooks.customers.redact] Error processing redaction:",
      err,
    );
  }

  return new Response();
};
