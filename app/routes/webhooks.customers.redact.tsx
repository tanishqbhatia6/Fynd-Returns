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
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  const customerId = payload.customer?.id?.toString() ?? "";
  const customerEmail = payload.customer?.email?.toLowerCase().trim() ?? "";

  console.log(
    `[webhooks.customers.redact] shop=${shop} customerId=${customerId} email=${customerEmail}`,
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

    // Find all return cases for this customer
    const conditions = [];
    if (customerEmail) conditions.push({ customerEmailNorm: customerEmail });
    if (customerId) conditions.push({ shopifyOrderId: { contains: customerId } });

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

    // Delete lookup sessions for this customer
    if (customerEmail) {
      await prisma.lookupSession.deleteMany({
        where: {
          shopId: shopRecord.id,
          lookupValueNorm: customerEmail,
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

    // Anonymize Fynd webhook logs that contain customer data
    const fyndLogs = await prisma.fyndWebhookLog.findMany({
      where: {
        shopDomain: shop,
        OR: [
          ...(customerEmail ? [{ customerEmail }] : []),
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
