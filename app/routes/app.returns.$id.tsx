import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useNavigate, isRouteErrorResponse, useRouteError } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const id = params.id;
  if (!id) {
    throw new Response("Return ID is required", { status: 400 });
  }

  const { session } = await authenticate.admin(request);
  const shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
  });
  if (!shop) {
    throw new Response("Shop not found", { status: 404 });
  }

  let returnCase;
  try {
    returnCase = await prisma.returnCase.findFirst({
      where: { id, shopId: shop.id },
      include: {
        items: true,
        events: { orderBy: { happenedAt: "asc" } },
      },
    });
  } catch (err) {
    console.error("Return detail loader error:", err);
    throw new Response("Failed to load return", { status: 500 });
  }

  if (!returnCase) {
    throw new Response("Return not found", { status: 404 });
  }

  return { returnCase };
};

export default function ReturnDetail() {
  const { returnCase } = useLoaderData<typeof loader>();
  const navigate = useNavigate();

  return (
    <s-page heading={`Return ${returnCase.shopifyOrderName || returnCase.id}`}>
      <s-section>
        <s-button variant="secondary" onClick={() => navigate("/app/returns")}>
          Back to Returns
        </s-button>
      </s-section>
      <s-section heading="Status">
        <p><strong>Status:</strong> {returnCase.status}</p>
        <p>Order: {returnCase.shopifyOrderName || "—"}</p>
        <p>Forward AWB: {returnCase.forwardAwb || "—"}</p>
        <p>Return AWB: {returnCase.returnAwb || "—"}</p>
        <p>Fynd Return #: {returnCase.fyndReturnNo || "—"}</p>
      </s-section>
      <s-section heading="Items">
        {(returnCase.items?.length ?? 0) === 0 ? (
          <p style={{ color: "#6d7175" }}>No items in this return.</p>
        ) : (
          <ul>
            {(returnCase.items || []).map((item) => (
              <li key={item.id}>
                {item.sku || item.shopifyLineItemId} × {item.qty} — {item.reasonCode || "—"}
              </li>
            ))}
          </ul>
        )}
      </s-section>
      <s-section heading="Timeline">
        {(returnCase.events?.length ?? 0) === 0 ? (
          <p style={{ color: "#6d7175" }}>No events yet.</p>
        ) : (
          <ul>
            {(returnCase.events || []).map((ev) => (
              <li key={ev.id}>
                [{ev.source}] {ev.eventType} — {new Date(ev.happenedAt).toLocaleString()}
              </li>
            ))}
          </ul>
        )}
      </s-section>
    </s-page>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const is404 = isRouteErrorResponse(error) && error.status === 404;
  const is500 = isRouteErrorResponse(error) && error.status === 500;

  return (
    <s-page heading={is404 ? "Return not found" : "Something went wrong"}>
      <s-section>
        <p style={{ marginBottom: 16, color: "#6d7175" }}>
          {is404
            ? "The return you're looking for doesn't exist or you don't have access to it."
            : is500
              ? "We couldn't load this return. Please try again later."
              : "An unexpected error occurred."}
        </p>
        <Link to="/app/returns">
          <s-button variant="primary">Back to Returns</s-button>
        </Link>
      </s-section>
    </s-page>
  );
}
