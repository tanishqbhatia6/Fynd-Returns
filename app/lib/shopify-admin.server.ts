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
            variant { product { tags, productType } }
          }
        }
      }
    }
  }
`;

const ORDERS_BY_CUSTOMER_QUERY = `#graphql
  query getOrdersByCustomer($query: String!) {
    orders(first: 50, query: $query, sortKey: CREATED_AT, reverse: true) {
      nodes {
        id
        name
        createdAt
        email
        totalPriceSet { shopMoney { amount } }
        displayFinancialStatus
        displayFulfillmentStatus
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
    productType?: string | null;
  }>;
  shippingCountry?: string | null;
  shippingProvince?: string | null;
};

export class OrderAccessError extends Error {
  constructor(
    message: string,
    public readonly code: "PCDA" | "NOT_FOUND" = "PCDA"
  ) {
    super(message);
    this.name = "OrderAccessError";
  }
}

export async function fetchOrderByOrderNumber(
  admin: AdminGraphQL,
  orderNumber: string
): Promise<OrderForPortal | null> {
  const clean = orderNumber.replace(/^#/, "").trim();
  if (!clean) return null;
  const query = /^\d+$/.test(clean) ? `name:#${clean}` : `name:${clean}`;
  const res = await admin.graphql(ORDERS_BY_NAME_QUERY, { variables: { query } });
  const json = (await res.json()) as {
    data?: { orders?: { nodes?: Array<unknown> } };
    errors?: Array<{ message?: string }>;
  };
  const errMsg = json.errors?.[0]?.message ?? "";
  if (errMsg.includes("not approved") || errMsg.includes("Order object") || errMsg.includes("protected")) {
    throw new OrderAccessError(errMsg, "PCDA");
  }
  if (json.errors?.length) {
    throw new OrderAccessError(errMsg || "Order access failed", "PCDA");
  }
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
        variant?: { product?: { tags?: string[]; productType?: string } };
      }>;
    };
  };
  return {
    id: o.id,
    name: o.name,
    createdAt: o.createdAt,
    email: o.email ?? null,
    totalPrice: o.totalPriceSet?.shopMoney?.amount,
    lineItems: (o.lineItems?.nodes ?? []).map((li) => {
      const product = (li as { variant?: { product?: { tags?: string[]; productType?: string } } }).variant?.product;
      return {
        id: li.id,
        title: li.title,
        sku: li.sku,
        quantity: li.quantity,
        price: li.originalUnitPriceSet?.shopMoney?.amount,
        productTags: product?.tags ?? [],
        productType: product?.productType ?? null,
      };
    }),
    shippingCountry: o.shippingAddress?.countryCode ?? null,
    shippingProvince: o.shippingAddress?.provinceCode ?? null,
  };
}

export type OrderSummaryForPortal = {
  id: string;
  name: string;
  createdAt: string;
  email?: string | null;
  totalPrice?: string;
  displayFinancialStatus?: string;
  displayFulfillmentStatus?: string;
};

export async function fetchOrdersByCustomer(
  admin: AdminGraphQL,
  email: string
): Promise<OrderSummaryForPortal[]> {
  const trimmed = email.trim().toLowerCase();
  if (!trimmed) return [];
  const query = `email:${trimmed}`;
  try {
    const res = await admin.graphql(ORDERS_BY_CUSTOMER_QUERY, { variables: { query } });
    const json = (await res.json()) as {
      data?: { orders?: { nodes?: Array<{
        id: string;
        name: string;
        createdAt: string;
        email?: string | null;
        totalPriceSet?: { shopMoney?: { amount?: string } };
        displayFinancialStatus?: string;
        displayFulfillmentStatus?: string;
      }> } };
      errors?: Array<{ message?: string }>;
    };
    if (json.errors?.length) return [];
    const nodes = json.data?.orders?.nodes ?? [];
    return nodes.map((o) => ({
      id: o.id,
      name: o.name,
      createdAt: o.createdAt,
      email: o.email ?? null,
      totalPrice: o.totalPriceSet?.shopMoney?.amount,
      displayFinancialStatus: o.displayFinancialStatus ?? undefined,
      displayFulfillmentStatus: o.displayFulfillmentStatus ?? undefined,
    }));
  } catch {
    return [];
  }
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
  try {
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
    let json: { data?: { refundCreate?: { userErrors?: Array<{ message: string }> } }; errors?: Array<{ message?: string }> };
    try {
      json = (await res.json()) as typeof json;
    } catch {
      return { success: false, error: "Invalid response from Shopify. Please try again." };
    }
    const gqlErrors = json.errors ?? [];
    if (gqlErrors.length > 0) {
      return { success: false, error: gqlErrors.map((e) => e.message ?? "GraphQL error").join(", ") };
    }
    if (!res.ok) {
      return { success: false, error: `Shopify API error (${res.status}). Please try again or refund manually in Shopify Admin.` };
    }
    const userErrors = json.data?.refundCreate?.userErrors ?? [];
    if (userErrors.length > 0) {
      return { success: false, error: userErrors.map((e) => e.message).join(", ") };
    }
    return { success: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Refund request failed";
    return { success: false, error: msg };
  }
}
