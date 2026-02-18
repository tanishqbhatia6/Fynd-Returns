import { Link, Outlet, useLocation } from "react-router";

export default function SettingsLayout() {
  const location = useLocation();
  const isRoot = location.pathname === "/app/settings" || location.pathname === "/app/settings/";

  return (
    <s-page heading={isRoot ? "Settings" : undefined}>
      {!isRoot && (
        <div style={{ marginBottom: 16 }}>
          <Link
            to="/app/settings"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              color: "#005bd3",
              textDecoration: "none",
              fontSize: 14,
              fontWeight: 500,
            }}
          >
            ← Back to Settings
          </Link>
        </div>
      )}
      <Outlet />
    </s-page>
  );
}
