import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) throw new Response("Shop not found", { status: 404 });

  const returnCase = await prisma.returnCase.findFirst({
    where: { id: params.id!, shopId: shop.id },
    include: {
      items: true,
      events: { orderBy: { happenedAt: "asc" } },
    },
  });
  if (!returnCase) throw new Response("Return not found", { status: 404 });

  return { returnCase };
};

export default function ReturnDetail() {
  const { returnCase } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  return (
    <s-page heading={`Return ${returnCase.shopifyOrderName}`}>
      <s-section>
        <s-button variant="secondary" onClick={() => navigate("/app")}>
          Back
        </s-button>
      </s-section>
      <s-section heading="Status">
        <p><strong>Status:</strong> {returnCase.status}</p>
        <p>Order: {returnCase.shopifyOrderName}</p>
        <p>Forward AWB: {returnCase.forwardAwb || "-"}</p>
        <p>Return AWB: {returnCase.returnAwb || "-"}</p>
        <p>Fynd Return #: {returnCase.fyndReturnNo || "-"}</p>
      </s-section>
      <s-section heading="Items">
        <ul>
          {(returnCase.items || []).map((item) => (
            <li key={item.id}>
              {item.sku || item.shopifyLineItemId} × {item.qty} — {item.reasonCode || "-"}
            </li>
          ))}
        </ul>
      </s-section>
      <s-section heading="Timeline">
        <ul>
          {(returnCase.events || []).map((ev) => (
            <li key={ev.id}>
              [{ev.source}] {ev.eventType} — {new Date(ev.happenedAt).toLocaleString()}
            </li>
          ))}
        </ul>
      </s-section>
    </s-page>
  );
}
