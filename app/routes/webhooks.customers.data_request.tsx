import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { webhookLogger } from "../lib/observability/logger.server";

/**
 * GDPR: customers/data_request
 *
 * Triggered when a customer requests their stored data via the store.
 * We compile all personal data we hold and log the request.
 * The merchant must send the data to the customer within 30 days.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  // Re-throw HMAC 401 Responses; swallow other authenticate-time errors.
  let authed: Awaited<ReturnType<typeof authenticate.webhook>>;
  try {
    authed = await authenticate.webhook(request);
  } catch (err) {
    if (err instanceof Response) throw err;
    webhookLogger.error(
      { topic: "CUSTOMERS_DATA_REQUEST", err },
      "Customer data request webhook authentication failed",
    );
    return new Response();
  }
  const { shop, payload } = authed;

  const customerId = payload.customer?.id?.toString() ?? "";
  const customerEmail = payload.customer?.email?.toLowerCase().trim() ?? "";

  webhookLogger.info(
    {
      topic: "CUSTOMERS_DATA_REQUEST",
      shop,
      hasCustomerId: Boolean(customerId),
      hasCustomerEmail: Boolean(customerEmail),
    },
    "Shopify customer data request webhook received",
  );

  try {
    const shopRecord = await prisma.shop.findUnique({
      where: { shopDomain: shop },
    });

    if (!shopRecord) {
      webhookLogger.info(
        { topic: "CUSTOMERS_DATA_REQUEST", shop },
        "Shop not found for customer data request",
      );
      return new Response();
    }

    // Gather all return cases associated with this customer
    const conditions = [];
    if (customerEmail) conditions.push({ customerEmailNorm: customerEmail });
    if (customerId) conditions.push({ shopifyOrderId: { contains: customerId } });

    const returnCases =
      conditions.length > 0
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

    webhookLogger.info(
      { topic: "CUSTOMERS_DATA_REQUEST", shop, returnCaseCount: returnCases.length },
      "Shopify customer data request lookup completed",
    );
  } catch (err) {
    webhookLogger.error(
      { topic: "CUSTOMERS_DATA_REQUEST", shop, err },
      "Customer data request webhook failed",
    );
  }

  return new Response();
};
