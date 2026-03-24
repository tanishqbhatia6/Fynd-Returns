import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

/**
 * GDPR: customers/data_request
 *
 * Triggered when a customer requests their stored data via the store.
 * We compile all personal data we hold and log the request.
 * The merchant must send the data to the customer within 30 days.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);

  const customerId = payload.customer?.id?.toString() ?? "";
  const customerEmail = payload.customer?.email?.toLowerCase().trim() ?? "";

  console.log(
    `[webhooks.customers.data_request] shop=${shop} customerId=${customerId} email=${customerEmail}`,
  );

  try {
    const shopRecord = await prisma.shop.findUnique({
      where: { shopDomain: shop },
    });

    if (!shopRecord) {
      console.log(`[webhooks.customers.data_request] Shop not found: ${shop}`);
      return new Response();
    }

    // Gather all return cases associated with this customer
    const conditions = [];
    if (customerEmail) conditions.push({ customerEmailNorm: customerEmail });
    if (customerId) conditions.push({ shopifyOrderId: { contains: customerId } });

    const returnCases = conditions.length > 0
      ? await prisma.returnCase.findMany({
          where: {
            shopId: shopRecord.id,
            OR: conditions,
          },
          include: {
            items: true,
            events: true,
          },
        })
      : [];

    console.log(
      `[webhooks.customers.data_request] Found ${returnCases.length} return case(s) for customer in shop=${shop}`,
    );
  } catch (err) {
    console.error(
      "[webhooks.customers.data_request] Error processing request:",
      err,
    );
  }

  return new Response();
};
