import type { LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

const STATUS_COLORS: Record<string, string> = {
  pending: "#b98900",
  processing: "#005bd3",
  "in progress": "#005bd3",
  completed: "#008060",
  approved: "#008060",
  rejected: "#d72c0d",
  cancelled: "#6d7175",
  initiated: "#b98900",
};

function getStatusColor(status: string): string {
  const key = status.toLowerCase().replace(/\s+/g, " ");
  return STATUS_COLORS[key] ?? "#6d7175";
}

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

    const now = new Date();
    const sevenDaysAgo = new Date(now);
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const thirtyDaysAgo = new Date(now);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const where = { shopId: shop.id };
    const whereLast7 = { ...where, createdAt: { gte: sevenDaysAgo } };
    const whereLast30 = { ...where, createdAt: { gte: thirtyDaysAgo } };

    const [
      totalReturns,
      returnsLast7,
      returnsLast30,
      returnsByStatus,
      recentReturns,
      reasonAggregation,
    ] = await Promise.all([
      prisma.returnCase.count({ where }),
      prisma.returnCase.count({ where: whereLast7 }),
      prisma.returnCase.count({ where: whereLast30 }),
      prisma.returnCase.groupBy({
        by: ["status"],
        where,
        _count: true,
      }),
      prisma.returnCase.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: 8,
        include: { items: { take: 3 } },
      }),
      prisma.returnItem.groupBy({
        by: ["reasonCode"],
        where: { returnCase: { shopId: shop.id } },
        _count: true,
      }),
    ]);

    const statusMap = returnsByStatus.reduce(
      (acc, x) => ({ ...acc, [x.status]: x._count }),
      {} as Record<string, number>
    );
    const maxStatusCount = Math.max(...Object.values(statusMap), 1);

    const topReasons = reasonAggregation
      .filter((r) => r.reasonCode && r.reasonCode.trim() !== "")
      .map((r) => ({ reason: r.reasonCode!, count: r._count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const portalUrl = `https://${session.shop}/apps/returns`;
    const hasFyndConfig =
      !!(shop.settings?.fyndCompanyId && shop.settings?.fyndApplicationId && shop.settings?.fyndCredentials);

    return {
      totalReturns,
      returnsLast7,
      returnsLast30,
      statusMap,
      maxStatusCount,
      topReasons,
      recentReturns,
      portalUrl,
      hasFyndConfig,
      shopDomain: session.shop,
      error: null,
    };
  } catch (err) {
    console.error("Dashboard loader error:", err);
    return {
      totalReturns: 0,
      returnsLast7: 0,
      returnsLast30: 0,
      statusMap: {} as Record<string, number>,
      maxStatusCount: 1,
      topReasons: [] as { reason: string; count: number }[],
      recentReturns: [] as Awaited<ReturnType<typeof prisma.returnCase.findMany>>,
      portalUrl: `https://${session.shop}/apps/returns`,
      hasFyndConfig: false,
      shopDomain: session.shop,
      error: "Failed to load dashboard data. Please refresh or try again later.",
    };
  }
};

const cardStyle = {
  padding: 20,
  background: "var(--p-color-bg-surface, #fff)",
  borderRadius: 12,
  border: "1px solid var(--p-color-border-secondary, #e1e3e5)",
  boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
};

const metricLabelStyle = {
  fontSize: 12,
  fontWeight: 500,
  color: "#6d7175",
  textTransform: "uppercase" as const,
  letterSpacing: "0.04em",
  marginBottom: 6,
};

export default function Dashboard() {
  const {
    totalReturns,
    returnsLast7,
    returnsLast30,
    statusMap,
    maxStatusCount,
    topReasons,
    recentReturns,
    portalUrl,
    hasFyndConfig,
    error,
  } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Dashboard">
      {error && (
        <div
          style={{
            ...cardStyle,
            marginBottom: 24,
            borderColor: "#d72c0d",
            background: "#fef2f2",
          }}
        >
          <p style={{ color: "#d72c0d", marginBottom: 8, fontWeight: 500 }}>
            {error}
          </p>
          <p style={{ color: "#6d7175", fontSize: 14 }}>
            Some metrics may be unavailable. You can still use Returns, Settings, and the Customer Portal.
          </p>
        </div>
      )}

      {/* KPI Row */}
      <s-section heading="Key metrics">
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
            gap: 16,
            marginBottom: 8,
          }}
        >
          <div style={cardStyle}>
            <div style={metricLabelStyle}>Total returns</div>
            <div style={{ fontSize: 32, fontWeight: 700, color: "#202223" }}>
              {totalReturns.toLocaleString()}
            </div>
            <Link to="/app/returns" style={{ fontSize: 13, color: "#005bd3", marginTop: 8, display: "block", textDecoration: "none" }}>
              View all →
            </Link>
          </div>
          <div style={cardStyle}>
            <div style={metricLabelStyle}>Last 7 days</div>
            <div style={{ fontSize: 32, fontWeight: 700, color: "#202223" }}>
              {returnsLast7.toLocaleString()}
            </div>
          </div>
          <div style={cardStyle}>
            <div style={metricLabelStyle}>Last 30 days</div>
            <div style={{ fontSize: 32, fontWeight: 700, color: "#202223" }}>
              {returnsLast30.toLocaleString()}
            </div>
          </div>
          {Object.entries(statusMap).slice(0, 2).map(([status, count]) => (
            <div key={status} style={cardStyle}>
              <div style={metricLabelStyle}>{status}</div>
              <div style={{ fontSize: 32, fontWeight: 700, color: getStatusColor(status) }}>
                {count.toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      </s-section>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 24, marginBottom: 24 }}>
        {/* Status breakdown */}
        <s-section heading="Returns by status">
          {Object.keys(statusMap).length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: "#6d7175", fontSize: 14 }}>
              No returns yet. Status breakdown will appear when customers initiate returns.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {Object.entries(statusMap)
                .sort(([, a], [, b]) => b - a)
                .map(([status, count]) => (
                  <div key={status}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6, fontSize: 14 }}>
                      <span style={{ fontWeight: 500 }}>{status}</span>
                      <span style={{ color: "#6d7175" }}>{count}</span>
                    </div>
                    <div
                      style={{
                        height: 8,
                        background: "#f1f2f4",
                        borderRadius: 4,
                        overflow: "hidden",
                      }}
                    >
                      <div
                        style={{
                          width: `${(count / maxStatusCount) * 100}%`,
                          height: "100%",
                          background: getStatusColor(status),
                          borderRadius: 4,
                          minWidth: count > 0 ? 4 : 0,
                        }}
                      />
                    </div>
                  </div>
                ))}
            </div>
          )}
        </s-section>

        {/* Top return reasons */}
        <s-section heading="Top return reasons">
          {topReasons.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: "#6d7175", fontSize: 14 }}>
              No return reasons recorded yet. Reasons will appear as returns are processed.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {topReasons.map(({ reason, count }) => (
                <div
                  key={reason}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "10px 12px",
                    background: "#f9fafb",
                    borderRadius: 8,
                    fontSize: 14,
                  }}
                >
                  <span>{reason}</span>
                  <span style={{ fontWeight: 600, color: "#202223" }}>{count}</span>
                </div>
              ))}
            </div>
          )}
        </s-section>
      </div>

      {/* Recent returns */}
      <s-section heading="Recent returns">
        {recentReturns.length === 0 ? (
          <div
            style={{
              padding: 40,
              textAlign: "center",
              background: "#f9fafb",
              borderRadius: 12,
              border: "1px dashed #e1e3e5",
            }}
          >
            <p style={{ fontSize: 16, fontWeight: 500, marginBottom: 8, color: "#202223" }}>
              No returns yet
            </p>
            <p style={{ color: "#6d7175", marginBottom: 16, fontSize: 14 }}>
              Returns will appear here when customers initiate them via the portal.
            </p>
            <Link to="/app/portal">
              <s-button variant="primary">Share portal URL</s-button>
            </Link>
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
              <thead>
                <tr style={{ borderBottom: "1px solid #e1e3e5" }}>
                  <th style={{ textAlign: "left", padding: "12px 16px", fontWeight: 600 }}>Order</th>
                  <th style={{ textAlign: "left", padding: "12px 16px", fontWeight: 600 }}>Status</th>
                  <th style={{ textAlign: "left", padding: "12px 16px", fontWeight: 600 }}>Return #</th>
                  <th style={{ textAlign: "left", padding: "12px 16px", fontWeight: 600 }}>Created</th>
                  <th style={{ textAlign: "right", padding: "12px 16px", fontWeight: 600 }}></th>
                </tr>
              </thead>
              <tbody>
                {recentReturns.map((r) => (
                  <tr key={r.id} style={{ borderBottom: "1px solid #f1f2f4" }}>
                    <td style={{ padding: "12px 16px" }}>{r.shopifyOrderName || r.id}</td>
                    <td style={{ padding: "12px 16px" }}>
                      <span
                        style={{
                          display: "inline-block",
                          padding: "4px 10px",
                          borderRadius: 6,
                          fontSize: 12,
                          fontWeight: 500,
                          background: `${getStatusColor(r.status)}20`,
                          color: getStatusColor(r.status),
                        }}
                      >
                        {r.status}
                      </span>
                    </td>
                    <td style={{ padding: "12px 16px", color: "#6d7175" }}>{r.fyndReturnNo || "—"}</td>
                    <td style={{ padding: "12px 16px", color: "#6d7175" }}>
                      {new Date(r.createdAt).toLocaleDateString()}
                    </td>
                    <td style={{ padding: "12px 16px", textAlign: "right" }}>
                      <Link to={`/app/returns/${r.id}`} style={{ fontSize: 13, color: "#005bd3", textDecoration: "none" }}>
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </s-section>

      {/* Modules & actions */}
      <s-section heading="Quick actions">
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <Link to="/app/returns">
            <s-button variant="primary">View all returns</s-button>
          </Link>
          <Link to={hasFyndConfig ? "/app/settings" : "/app/settings/integrations"}>
            <s-button variant="secondary">{hasFyndConfig ? "Settings" : "Configure Fynd"}</s-button>
          </Link>
          <Link to="/app/portal">
            <s-button variant="secondary">Customer portal</s-button>
          </Link>
        </div>
      </s-section>

      {/* Customer portal */}
      <s-section heading="Customer portal URL">
        <p style={{ marginBottom: 12, color: "#6d7175", fontSize: 14 }}>
          Share this URL so customers can initiate and track returns.
        </p>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <code
            style={{
              padding: "12px 16px",
              background: "#f6f6f7",
              borderRadius: 8,
              fontSize: 14,
              flex: "1 1 280px",
              overflow: "auto",
              border: "1px solid #e1e3e5",
            }}
          >
            {portalUrl}
          </code>
          <s-button variant="secondary" onClick={() => navigator.clipboard.writeText(portalUrl)}>
            Copy URL
          </s-button>
        </div>
      </s-section>

      {!hasFyndConfig && (
        <s-section heading="Setup required">
          <div
            style={{
              padding: 24,
              background: "#fef9e7",
              borderRadius: 12,
              border: "1px solid #e5c200",
            }}
          >
            <p style={{ marginBottom: 12, fontWeight: 500, color: "#202223" }}>
              Connect your Fynd account to enable full return management.
            </p>
            <p style={{ marginBottom: 16, color: "#6d7175", fontSize: 14 }}>
              Fynd handles reverse logistics. Configure your credentials to sync returns and tracking.
            </p>
            <Link to="/app/settings/integrations">
              <s-button variant="primary">Configure Fynd</s-button>
            </Link>
          </div>
        </s-section>
      )}
    </s-page>
  );
}
