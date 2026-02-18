import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useFetcher } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
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
  const scopes = process.env.SCOPES?.split(",") ?? [];
  const hasReadAllOrders = scopes.some((s) => s.trim().toLowerCase().includes("read_all_orders"));
  return {
    readAllOrdersEnabled: shop.settings?.readAllOrdersEnabled ?? false,
    hasReadAllOrdersScope: hasReadAllOrders,
    scopes,
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const formData = await request.formData();
  const readAllOrdersEnabled = formData.get("readAllOrdersEnabled") === "on";

  let shop = await prisma.shop.findUnique({ where: { shopDomain: session.shop } });
  if (!shop) shop = await prisma.shop.create({ data: { shopDomain: session.shop } });

  await prisma.shopSettings.upsert({
    where: { shopId: shop.id },
    create: { shopId: shop.id, readAllOrdersEnabled },
    update: { readAllOrdersEnabled },
  });
  return { success: true };
};

export default function Permissions() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ success?: boolean }>();

  return (
    <s-page heading="All orders permission">
      {fetcher.data && "success" in fetcher.data && (
        <div style={{ padding: 12, marginBottom: 16, background: "#e8f5e9", borderRadius: 8, color: "#2e7d32" }}>
          Settings saved successfully.
        </div>
      )}

      <fetcher.Form method="post">
        <p style={{ marginBottom: 24, color: "#6d7175", fontSize: 14 }}>
          Approve the read_all_orders permission to fetch every past order. This is required for viewing order details and processing refunds for older orders.
        </p>
        <s-section>
          <div style={{ padding: 20, background: "#f9fafb", borderRadius: 12, border: "1px solid #e1e3e5", marginBottom: 16 }}>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 16 }}>
              <div style={{ fontSize: 24 }}>📄</div>
              <div>
                <div style={{ fontWeight: 600, marginBottom: 8 }}>read_all_orders</div>
                <p style={{ fontSize: 14, color: "#6d7175", marginBottom: 12 }}>
                  This permission allows the app to access all orders in your store, including those outside the default 60-day window. Required for full return and refund functionality.
                </p>
                {data.hasReadAllOrdersScope ? (
                  <p style={{ fontSize: 14, color: "#008060", fontWeight: 500 }}>✓ Scope is configured in your app</p>
                ) : (
                  <p style={{ fontSize: 14, color: "#b98900", fontWeight: 500 }}>
                    Add <code style={{ background: "#fef9e7", padding: "2px 6px", borderRadius: 4 }}>read_all_orders</code> to your SCOPES environment variable and reinstall the app.
                  </p>
                )}
              </div>
            </div>
          </div>
          <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input type="checkbox" name="readAllOrdersEnabled" defaultChecked={data.readAllOrdersEnabled} />
            <span>I acknowledge and want to use read_all_orders for full order access</span>
          </label>
        </s-section>
        <div style={{ marginTop: 24, display: "flex", gap: 12 }}>
          <s-button type="submit" loading={fetcher.state !== "idle"}>Save</s-button>
          <Link to="/app/settings">
            <s-button variant="secondary" type="button">Discard</s-button>
          </Link>
        </div>
      </fetcher.Form>
    </s-page>
  );
}
