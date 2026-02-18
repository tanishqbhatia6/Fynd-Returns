import type { LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const query = url.searchParams.get("query") || "";
  const status = url.searchParams.get("status") || "";

  let shop = await prisma.shop.findUnique({
    where: { shopDomain: session.shop },
    include: { settings: true },
  });
  if (!shop) {
    shop = await prisma.shop.create({
      data: { shopDomain: session.shop },
      include: { settings: true },
    });
  }

  const where: Record<string, unknown> = { shopId: shop.id };
  if (status) where.status = status;
  if (query) {
    where.OR = [
      { shopifyOrderName: { contains: query, mode: "insensitive" } },
      { forwardAwb: { contains: query, mode: "insensitive" } },
      { returnAwb: { contains: query, mode: "insensitive" } },
      { fyndReturnNo: { contains: query, mode: "insensitive" } },
      { customerEmailNorm: { contains: query, mode: "insensitive" } },
      { customerPhoneNorm: { contains: query, mode: "insensitive" } },
    ];
  }

  const returns = await prisma.returnCase.findMany({
    where,
    include: {
      items: true,
      events: { orderBy: { happenedAt: "desc" }, take: 5 },
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  return { returns };
};

export default function ReturnsList() {
  const { returns } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Returns">
      <s-section>
        {returns.length === 0 ? (
          <p>No returns yet. Returns will appear when customers initiate them via the portal.</p>
        ) : (
          <s-data-table>
            <table>
              <thead>
                <tr>
                  <th>Order</th>
                  <th>Return #</th>
                  <th>Forward AWB</th>
                  <th>Return AWB</th>
                  <th>Status</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {returns.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <a href={`/app/returns/${r.id}`}>{r.shopifyOrderName || r.id}</a>
                    </td>
                    <td>{r.fyndReturnNo || "-"}</td>
                    <td>{r.forwardAwb || "-"}</td>
                    <td>{r.returnAwb || "-"}</td>
                    <td>{r.status}</td>
                    <td>{new Date(r.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </s-data-table>
        )}
      </s-section>
    </s-page>
  );
}
