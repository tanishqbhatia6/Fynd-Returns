import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { webhookLogger } from "../lib/observability/logger.server";

/**
 * Catch-all webhook handler at /webhooks
 *
 * Handles GDPR compliance webhooks (customers/data_request, customers/redact,
 * shop/redact) which are all sent to the same URI.
 *
 * authenticate.webhook() validates the HMAC signature and returns 401
 * for invalid signatures, satisfying Shopify's automated verification check.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { topic, shop, payload } = await authenticate.webhook(request);

  webhookLogger.info({ topic, shop }, "Shopify webhook received");

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST": {
      const customerEmail = payload.customer?.email?.toLowerCase().trim() ?? "";
      webhookLogger.info(
        { topic, shop, hasCustomerEmail: Boolean(customerEmail) },
        "Shopify customer data request webhook received",
      );

      try {
        const shopRecord = await prisma.shop.findUnique({
          where: { shopDomain: shop },
        });
        if (shopRecord) {
          const conditions = [];
          if (customerEmail) conditions.push({ customerEmailNorm: customerEmail });

          const returnCases =
            conditions.length > 0
              ? await prisma.returnCase.findMany({
                  where: { shopId: shopRecord.id, OR: conditions },
                  include: { items: true, events: true },
                })
              : [];

          webhookLogger.info(
            { topic, shop, returnCaseCount: returnCases.length },
            "Shopify customer data request lookup completed",
          );
        }
      } catch (err) {
        webhookLogger.error(
          { topic, shop, err },
          "Shopify customer data request webhook failed",
        );
      }
      break;
    }

    case "CUSTOMERS_REDACT": {
      const customerEmail = payload.customer?.email?.toLowerCase().trim() ?? "";
      webhookLogger.info(
        { topic, shop, hasCustomerEmail: Boolean(customerEmail) },
        "Shopify customer redact webhook received",
      );

      try {
        const shopRecord = await prisma.shop.findUnique({
          where: { shopDomain: shop },
        });
        if (shopRecord) {
          // Match by email only. The previous fallback used
          // `shopifyOrderId: { contains: customerId }` which produced false
          // positives (numeric customer IDs are short and substring-match
          // unrelated Order GIDs), redacting the wrong shoppers' records.
          const conditions = [];
          if (customerEmail) conditions.push({ customerEmailNorm: customerEmail });

          if (conditions.length > 0) {
            const returnCases = await prisma.returnCase.findMany({
              where: { shopId: shopRecord.id, OR: conditions },
            });

            if (returnCases.length > 0) {
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

              /* v8 ignore start */
              // defensive: customerEmail typically present on customer redact webhooks; falsy branch unreachable
              if (customerEmail) {
                await prisma.lookupSession.deleteMany({
                  where: {
                    shopId: shopRecord.id,
                    lookupValueNorm: customerEmail,
                  },
                });
              }
              /* v8 ignore stop */

              await prisma.notificationLog.deleteMany({
                where: {
                  shopId: shopRecord.id,
                  returnCaseId: { in: caseIds },
                },
              });

              const fyndLogs = await prisma.fyndWebhookLog.findMany({
                where: {
                  shopDomain: shop,
                  /* v8 ignore start */
                  // defensive: customerEmail spread branch tested only when present
                  OR: [
                    ...(customerEmail ? [{ customerEmail }] : []),
                    { returnCaseId: { in: caseIds } },
                  ],
                  /* v8 ignore stop */
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

              webhookLogger.info(
                { topic, shop, returnCaseCount: returnCases.length },
                "Shopify customer redact completed",
              );
            }
          }
        }
      } catch (err) {
        webhookLogger.error({ topic, shop, err }, "Shopify customer redact webhook failed");
      }
      break;
    }

    case "SHOP_REDACT": {
      webhookLogger.info({ topic, shop }, "Shopify shop redact webhook received");

      try {
        const shopRecord = await prisma.shop.findUnique({
          where: { shopDomain: shop },
        });
        if (shopRecord) {
          const returnCases = await prisma.returnCase.findMany({
            where: { shopId: shopRecord.id },
            select: { id: true },
          });
          const caseIds = returnCases.map((rc) => rc.id);

          if (caseIds.length > 0) {
            await prisma.returnItem.deleteMany({
              where: { returnCaseId: { in: caseIds } },
            });
            await prisma.returnEvent.deleteMany({
              where: { returnCaseId: { in: caseIds } },
            });
            await prisma.returnCase.deleteMany({
              where: { id: { in: caseIds } },
            });
          }

          await prisma.fyndOrderMapping.deleteMany({
            where: { shopId: shopRecord.id },
          });
          await prisma.fyndWebhookLog.deleteMany({
            where: { shopDomain: shop },
          });
          await prisma.lookupSession.deleteMany({
            where: { shopId: shopRecord.id },
          });
          await prisma.apiKey.deleteMany({
            where: { shopId: shopRecord.id },
          });
          await prisma.webhookSubscription.deleteMany({
            where: { shopId: shopRecord.id },
          });
          await prisma.notificationLog.deleteMany({
            where: { shopId: shopRecord.id },
          });
          await prisma.shopSettings.deleteMany({
            where: { shopId: shopRecord.id },
          });
          await prisma.session.deleteMany({ where: { shop } });
          await prisma.shop.delete({ where: { id: shopRecord.id } });

          webhookLogger.info({ topic, shop }, "Shopify shop redact completed");
        }
      } catch (err) {
        webhookLogger.error({ topic, shop, err }, "Shopify shop redact webhook failed");
      }
      break;
    }

    default:
      webhookLogger.info({ topic, shop }, "Unhandled Shopify webhook topic");
  }

  return new Response();
};
