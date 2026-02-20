type AdminGraphQL = { graphql: (query: string, options?: { variables?: Record<string, unknown> }) => Promise<Response> };

const ORDERS_QUERY = `#graphql
  query getOrders($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on Order {
        id
        name
        createdAt
        email
        totalPriceSet { shopMoney { amount } }
        displayFinancialStatus
        displayFulfillmentStatus
        shippingAddress { countryCode provinceCode }
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

const ORDERS_BY_NAME_QUERY = `#graphql
  query getOrdersByName($query: String!) {
    orders(first: 1, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        createdAt
        email
        totalPriceSet { shopMoney { amount } }
        displayFinancialStatus
        displayFulfillmentStatus
        shippingAddress { countryCode provinceCode }
        lineItems(first: 50) {
          nodes {
            id
            title
            sku
            quantity
            originalUnitPriceSet { shopMoney { amount } }
            variant { product { tags } }
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

export type OrderForPortal = {
  id: string;
  name: string;
  createdAt: string;
  email?: string | null;
  totalPrice?: string;
  lineItems: Array<{
    id: string;
    title: string;
    sku: string | null;
    quantity: number;
    price?: string;
    productTags?: string[];
  }>;
  shippingCountry?: string | null;
  shippingProvince?: string | null;
};

export async function fetchOrderByOrderNumber(
  admin: AdminGraphQL,
  orderNumber: string
): Promise<OrderForPortal | null> {
  const clean = orderNumber.replace(/^#/, "").trim();
  if (!clean) return null;
  const query = /^\d+$/.test(clean) ? `name:#${clean}` : `name:${clean}`;
  const res = await admin.graphql(ORDERS_BY_NAME_QUERY, { variables: { query } });
  const json = (await res.json()) as { data?: { orders?: { nodes?: Array<unknown> } } };
  const node = json.data?.orders?.nodes?.[0];
  if (!node || !("name" in node)) return null;
  const o = node as {
    id: string;
    name: string;
    createdAt: string;
    email?: string | null;
    totalPriceSet?: { shopMoney?: { amount?: string } };
    shippingAddress?: { countryCode?: string; provinceCode?: string };
    lineItems?: {
      nodes?: Array<{
        id: string;
        title: string;
        sku: string | null;
        quantity: number;
        originalUnitPriceSet?: { shopMoney?: { amount?: string } };
        variant?: { product?: { tags?: string[] } };
      }>;
    };
  };
  return {
    id: o.id,
    name: o.name,
    createdAt: o.createdAt,
    email: o.email ?? null,
    totalPrice: o.totalPriceSet?.shopMoney?.amount,
    lineItems: (o.lineItems?.nodes ?? []).map((li) => ({
      id: li.id,
      title: li.title,
      sku: li.sku,
      quantity: li.quantity,
      price: li.originalUnitPriceSet?.shopMoney?.amount,
      productTags: (li as { variant?: { product?: { tags?: string[] } } }).variant?.product?.tags ?? [],
    })),
    shippingCountry: o.shippingAddress?.countryCode ?? null,
    shippingProvince: o.shippingAddress?.provinceCode ?? null,
  };
}

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
