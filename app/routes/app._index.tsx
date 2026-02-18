import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);

  try {
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

    const [returnsCount, returnsByStatus] = await Promise.all([
      prisma.returnCase.count({ where: { shopId: shop.id } }),
      prisma.returnCase.groupBy({
        by: ["status"],
        where: { shopId: shop.id },
        _count: true,
      }),
    ]);

    const portalUrl = `https://${session.shop}/apps/returns`;
    const hasFyndConfig =
      !!(shop.settings?.fyndCompanyId && shop.settings?.fyndApplicationId && shop.settings?.fyndCredentials);

    return {
      returnsCount,
      returnsByStatus: returnsByStatus.reduce(
        (acc, x) => ({ ...acc, [x.status]: x._count }),
        {} as Record<string, number>
      ),
      portalUrl,
      hasFyndConfig,
      shopDomain: session.shop,
      error: null,
    };
  } catch (err) {
    console.error("Dashboard loader error:", err);
    return {
      returnsCount: 0,
      returnsByStatus: {} as Record<string, number>,
      portalUrl: `https://${session.shop}/apps/returns`,
      hasFyndConfig: false,
      shopDomain: session.shop,
      error: "Failed to load dashboard data",
    };
  }
};

export default function Dashboard() {
  const { returnsCount, returnsByStatus, portalUrl, hasFyndConfig, error } =
    useLoaderData<typeof loader>();

  return (
    <s-page heading="Dashboard">
      {error && (
        <s-section>
          <p style={{ color: "#d72c0d", marginBottom: 8 }}>{error}</p>
          <p style={{ color: "#6d7175", fontSize: 14 }}>Some data may be unavailable. Please try again.</p>
        </s-section>
      )}
      <s-section heading="Overview">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: 16,
            marginBottom: 24,
          }}
        >
          <div
            style={{
              padding: 20,
              background: "var(--p-color-bg-surface-secondary, #f6f6f7)",
              borderRadius: 8,
              border: "1px solid var(--p-color-border-secondary, #e1e3e5)",
            }}
          >
            <div style={{ fontSize: 14, color: "#6d7175", marginBottom: 4 }}>
              Total Returns
            </div>
            <div style={{ fontSize: 28, fontWeight: 600 }}>{returnsCount}</div>
            <Link
              to="/app/returns"
              style={{ fontSize: 14, marginTop: 8, display: "block" }}
            >
              View all →
            </Link>
          </div>
          {Object.entries(returnsByStatus).slice(0, 3).map(([status, count]) => (
            <div
              key={status}
              style={{
                padding: 20,
                background: "var(--p-color-bg-surface-secondary, #f6f6f7)",
                borderRadius: 8,
                border: "1px solid var(--p-color-border-secondary, #e1e3e5)",
              }}
            >
              <div style={{ fontSize: 14, color: "#6d7175", marginBottom: 4 }}>
                {status}
              </div>
              <div style={{ fontSize: 28, fontWeight: 600 }}>{count}</div>
            </div>
          ))}
        </div>
      </s-section>

      <s-section heading="Quick actions">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <Link to="/app/returns">
            <s-button variant="primary">View Returns</s-button>
          </Link>
          <Link to="/app/settings">
            <s-button variant="secondary">
              {hasFyndConfig ? "Edit Settings" : "Configure Fynd"}
            </s-button>
          </Link>
          <Link to="/app/portal">
            <s-button variant="secondary">Customer Portal</s-button>
          </Link>
        </div>
      </s-section>

      <s-section heading="Customer Portal">
        <p style={{ marginBottom: 12, color: "#6d7175" }}>
          Share this URL with customers to let them initiate and track returns:
        </p>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <code
            style={{
              padding: "8px 12px",
              background: "#f6f6f7",
              borderRadius: 6,
              fontSize: 14,
              flex: "1 1 300px",
              overflow: "auto",
            }}
          >
            {portalUrl}
          </code>
          <s-button
            variant="secondary"
            onClick={() => navigator.clipboard.writeText(portalUrl)}
          >
            Copy URL
          </s-button>
        </div>
      </s-section>

      {!hasFyndConfig && (
        <s-section heading="Setup required">
          <p style={{ marginBottom: 12, color: "#6d7175" }}>
            Connect your Fynd account to enable return management.
          </p>
          <Link to="/app/settings">
            <s-button variant="primary">Configure Fynd</s-button>
          </Link>
        </s-section>
      )}
    </s-page>
  );
}
