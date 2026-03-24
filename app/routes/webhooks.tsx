import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

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

  console.log(`[webhooks] Received topic=${topic} shop=${shop}`);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST": {
      const customerEmail =
        payload.customer?.email?.toLowerCase().trim() ?? "";
      console.log(
        `[webhooks] customers/data_request shop=${shop} email=${customerEmail}`,
      );

      try {
        const shopRecord = await prisma.shop.findUnique({
          where: { shopDomain: shop },
        });
        if (shopRecord) {
          const conditions = [];
          if (customerEmail)
            conditions.push({ customerEmailNorm: customerEmail });

          const returnCases =
            conditions.length > 0
              ? await prisma.returnCase.findMany({
                  where: { shopId: shopRecord.id, OR: conditions },
                  include: { items: true, events: true },
                })
              : [];

          console.log(
            `[webhooks] customers/data_request found ${returnCases.length} return case(s)`,
          );
        }
      } catch (err) {
        console.error("[webhooks] customers/data_request error:", err);
      }
      break;
    }

    case "CUSTOMERS_REDACT": {
      const customerEmail =
        payload.customer?.email?.toLowerCase().trim() ?? "";
      const customerId = payload.customer?.id?.toString() ?? "";
      console.log(
        `[webhooks] customers/redact shop=${shop} email=${customerEmail}`,
      );

      try {
        const shopRecord = await prisma.shop.findUnique({
          where: { shopDomain: shop },
        });
        if (shopRecord) {
          const conditions = [];
          if (customerEmail)
            conditions.push({ customerEmailNorm: customerEmail });
          if (customerId)
            conditions.push({
              shopifyOrderId: { contains: customerId },
            });

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

              if (customerEmail) {
                await prisma.lookupSession.deleteMany({
                  where: {
                    shopId: shopRecord.id,
                    lookupValueNorm: customerEmail,
                  },
                });
              }

              await prisma.notificationLog.deleteMany({
                where: {
                  shopId: shopRecord.id,
                  returnCaseId: { in: caseIds },
                },
              });

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
                `[webhooks] customers/redact redacted ${returnCases.length} case(s)`,
              );
            }
          }
        }
      } catch (err) {
        console.error("[webhooks] customers/redact error:", err);
      }
      break;
    }

    case "SHOP_REDACT": {
      console.log(`[webhooks] shop/redact shop=${shop}`);

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

          console.log(
            `[webhooks] shop/redact deleted all data for shop=${shop}`,
          );
        }
      } catch (err) {
        console.error("[webhooks] shop/redact error:", err);
      }
      break;
    }

    default:
      console.log(`[webhooks] Unhandled topic: ${topic}`);
  }

  return new Response();
};
