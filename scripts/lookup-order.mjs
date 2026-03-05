#!/usr/bin/env node
/**
 * Call portal lookup API and print result for an order id.
 * Usage: node scripts/lookup-order.mjs [shop] [orderId]
 * Example: node scripts/lookup-order.mjs fynd-store-1.myshopify.com FYNDSHOPIFYX14122
 * Base URL: set PORTAL_BASE_URL or defaults to https://returnpromax.onrender.com
 */
const baseUrl = process.env.PORTAL_BASE_URL || "https://returnpromax.onrender.com";
const shop = process.argv[2] || "fynd-store-1.myshopify.com";
const orderId = process.argv[3] || "FYNDSHOPIFYX14122";

async function main() {
  const url = `${baseUrl}/api/portal/lookup`;
  const body = { shop: shop.includes(".") ? shop : `${shop}.myshopify.com`, lookupType: "order_no", lookupValue: orderId };
  console.log("POST", url);
  console.log("Body:", JSON.stringify(body, null, 2));
  console.log("");
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json();
  console.log("=== Result for order id:", orderId, "===");
  console.log("Orders found:", data.orders?.length ?? 0);
  console.log("Returns found:", data.returns?.length ?? 0);
  if (data.orders?.length) {
    data.orders.forEach((o, i) => {
      console.log("\nOrder", i + 1, ":", o.name, "| id:", o.id);
      console.log("  createdAt:", o.createdAt);
      console.log("  email:", o.email);
      console.log("  fyndData:", o.fyndData ? "attached" : "none");
    });
  }
  if (data.error) console.log("Error:", data.error);
  console.log("\nFull JSON (truncated fyndData):");
  const out = { ...data };
  if (out.orders) {
    out.orders = out.orders.map((o) => ({ ...o, fyndData: o.fyndData ? "[attached]" : null }));
  }
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
