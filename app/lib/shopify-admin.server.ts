type AdminGraphQL = { graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response> };

const ORDERS_QUERY = `#graphql
  query getOrders($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        id
        name
        createdAt
        totalPriceSet { shopMoney { amount } }
        displayFinancialStatus
        displayFulfillmentStatus
        lineItems(first: 50) {
          nodes {
            id
            title
            sku
            quantity
            originalUnitPriceSet { shopMoney { amount } }
          }
        }
      }
    }
  }
`;

const REFUND_MUTATION = `#graphql
  mutation refundCreate($refund: RefundInput!) {
    refundCreate(refund: $refund) {
      refund { id }
      userErrors { field message }
    }
  }
`;

export async function fetchOrder(
  admin: AdminGraphQL,
  orderId: string
): Promise<{ id: string; name: string; lineItems: Array<{ id: string; title: string; sku: string | null; quantity: number }> } | null> {
  const gid = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;
  const res = await admin.graphql(ORDERS_QUERY, { variables: { ids: [gid] } });
  const json = (await res.json()) as { data?: { nodes?: Array<unknown> } };
  const node = json.data?.nodes?.[0];
  if (!node || !("name" in node)) return null;
  const order = node as { id: string; name: string; lineItems?: { nodes?: Array<{ id: string; title: string; sku: string | null; quantity: number }> } };
  return {
    id: order.id,
    name: order.name,
    lineItems: order.lineItems?.nodes ?? [],
  };
}

export async function createRefund(
  admin: AdminGraphQL,
  orderId: string,
  lineItemIds: string[],
  note?: string
): Promise<{ success: boolean; error?: string }> {
  const gid = orderId.startsWith("gid://") ? orderId : `gid://shopify/Order/${orderId}`;
  const refundInput: Record<string, unknown> = {
    orderId: gid,
    note: note || "Return processed via Return Pro Max",
  };
  if (lineItemIds.length > 0) {
    refundInput.refundLineItems = lineItemIds.map((id) => ({
      lineItemId: id.startsWith("gid://") ? id : `gid://shopify/LineItem/${id}`,
      quantity: 1,
      restockType: "RETURN",
    }));
  } else {
    refundInput.refundLineItems = [{ quantity: 1, restockType: "RETURN" }];
  }
  const res = await admin.graphql(REFUND_MUTATION, { variables: { refund: refundInput } });
  const json = (await res.json()) as { data?: { refundCreate?: { userErrors?: Array<{ message: string }> } } };
  const errors = json.data?.refundCreate?.userErrors ?? [];
  if (errors.length > 0) return { success: false, error: errors.map((e) => e.message).join(", ") };
  return { success: true };
}
