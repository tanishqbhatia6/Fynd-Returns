import type { LoaderFunctionArgs } from "react-router";
import { redirect } from "react-router";
import { login } from "../../shopify.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }
  return { showForm: Boolean(login) };
};

export default function Index() {
  return (
    <div style={{
      minHeight: "100vh",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
      fontFamily: "'Inter', system-ui, -apple-system, sans-serif",
      color: "#fff",
    }}>
      <div style={{ textAlign: "center", maxWidth: 480 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 10, marginBottom: 16 }}>
          <img src="/fynd-logo.png" alt="Fynd" style={{ height: 32, filter: "brightness(0) invert(1)" }} />
          <span style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-0.03em" }}>Returns</span>
        </div>
        <p style={{ fontSize: 16, color: "#94a3b8", lineHeight: 1.6 }}>
          Enterprise-grade returns management for Shopify stores, powered by{" "}
          <a href="https://www.fynd.com/" target="_blank" rel="noopener noreferrer" style={{ color: "#a5b4fc", textDecoration: "none", fontWeight: 600 }}>
            Fynd
          </a>
        </p>
      </div>
    </div>
  );
}
