#!/usr/bin/env node
import { config } from "dotenv";
config(); // Load FYND_* from .env if present

/**
 * End-to-end test of Fynd Platform Order APIs (same flow as the app).
 * Uses: orders-listing, shipments-listing, order-details, shipment/status-internal
 *
 * Usage (with credentials from Settings → Integrations):
 *   FYND_CLIENT_ID=xxx FYND_CLIENT_SECRET=xxx node scripts/test-fynd-apis.mjs
 *
 * Optional: FYND_BASE_URL, FYND_COMPANY_ID, FYND_APPLICATION_ID, FYND_ORDER_ID
 * Set FYND_TEST_UPDATE=1 to run the update-shipment-status step (creates actual return on Fynd).
 */

const BASE_URL = process.env.FYND_BASE_URL || "https://api.uat.fyndx1.de";
const COMPANY_ID = process.env.FYND_COMPANY_ID || "2263";
const APPLICATION_ID = process.env.FYND_APPLICATION_ID || "67a09b70c8ea7c9123f00fab";
const ORDER_ID = process.env.FYND_ORDER_ID || "FYMP698CC01401C9F4A1";
const EXTERNAL_ORDER_ID = process.env.FYND_EXTERNAL_ORDER_ID;
const CLIENT_ID = process.env.FYND_CLIENT_ID;
const CLIENT_SECRET = process.env.FYND_CLIENT_SECRET;
const TEST_UPDATE = process.env.FYND_TEST_UPDATE === "1";
const WEBHOOK_URL = process.env.FYND_WEBHOOK_URL || process.env.SHOPIFY_APP_URL;
const TEST_WEBHOOK = process.env.FYND_TEST_WEBHOOK === "1";

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error("Error: FYND_CLIENT_ID and FYND_CLIENT_SECRET are required.");
  console.error("Usage: FYND_CLIENT_ID=xxx FYND_CLIENT_SECRET=xxx node scripts/test-fynd-apis.mjs");
  process.exit(1);
}

const platformOrderPath = `/service/platform/order/v1.0/company/${COMPANY_ID}`;
const platformOrderManagePath = `/service/platform/order-manage/v1.0/company/${COMPANY_ID}`;

console.log("=== Fynd Platform Order API – End-to-End Test ===\n");
console.log("Order ID:", ORDER_ID);
if (EXTERNAL_ORDER_ID) console.log("External Order ID (extra test):", EXTERNAL_ORDER_ID);
console.log("Base URL:", BASE_URL);
console.log("Company ID:", COMPANY_ID);
console.log("Application ID:", APPLICATION_ID);
console.log("Test Update (return_initiated):", TEST_UPDATE);
console.log("Test Webhook (list + register):", TEST_WEBHOOK);
if (TEST_WEBHOOK) console.log("Webhook URL:", WEBHOOK_URL || "(FYND_WEBHOOK_URL or SHOPIFY_APP_URL required)");
console.log("");

async function run() {
  // 1. OAuth Token
  console.log("--- 1. OAuth Token ---");
  const tokenRes = await fetch(`${BASE_URL}/service/panel/authentication/v1.0/company/${COMPANY_ID}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Basic " + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString("base64"),
    },
    body: JSON.stringify({ grant_type: "client_credentials" }),
  });
  const tokenData = await tokenRes.json();
  if (!tokenData.access_token) {
    console.error("FAIL:", tokenRes.status, tokenData);
    process.exit(1);
  }
  const token = tokenData.access_token;
  console.log("OK: Token obtained\n");

  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}` };

  // 2. Test connection (orders-listing – same as app)
  console.log("--- 2. Test Connection (orders-listing) ---");
  const r2 = await fetch(`${BASE_URL}${platformOrderPath}/orders-listing?page_no=1&page_size=1`, { headers });
  const body2 = await r2.text();
  console.log(r2.ok ? "OK" : "FAIL", "HTTP", r2.status);
  if (!r2.ok) console.log(body2.slice(0, 300));
  console.log("");

  // 3. Search Shipments (shipments-listing – same as app)
  const now = new Date().toISOString();
  const start = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const searchType = /^FY[A-Z0-9]{10,}/i.test(ORDER_ID) ? "order_id" : "external_order_id";
  const searchParams = new URLSearchParams({
    group_entity: "shipments",
    page_no: "1",
    page_size: "10",
    start_date: start,
    end_date: now,
    search_value: ORDER_ID,
    search_type: searchType,
    sort_type: "sla_asc",
  });

  console.log("--- 3. Search Shipments (shipments-listing, search_type=" + searchType + ") ---");
  const r3 = await fetch(`${BASE_URL}${platformOrderPath}/shipments-listing?${searchParams}`, { headers });
  const body3 = await r3.text();
  console.log(r3.ok ? "OK" : "FAIL", "HTTP", r3.status);
  let searchData = null;
  try {
    searchData = JSON.parse(body3);
  } catch {}
  const items = searchData?.items ?? searchData?.shipments ?? searchData?.data?.items ?? searchData?.results ?? [];
  const firstItem = Array.isArray(items) ? items[0] : null;
  const shipmentId = firstItem && typeof firstItem === "object"
    ? (firstItem.id ?? firstItem.shipment_id ?? firstItem.shipmentId ?? firstItem.channel_shipment_id)
    : null;
  const orderIdFromSearch = firstItem && typeof firstItem === "object"
    ? (firstItem.order_id ?? firstItem.orderId ?? firstItem.channel_order_id)
    : null;
  console.log("Items found:", Array.isArray(items) ? items.length : 0);
  if (firstItem) {
    console.log("First shipment ID:", shipmentId ?? "(none)");
    console.log("Order ID from search:", orderIdFromSearch ?? "(none)");
  }
  console.log(body3.slice(0, 500) + (body3.length > 500 ? "..." : ""), "\n");

  // 4. Get Order Details (order-details – same as app getShipments)
  const orderIdForDetails = orderIdFromSearch ?? ORDER_ID;
  console.log("--- 4. Get Order Details (order-details, order_id=" + orderIdForDetails + ") ---");
  const r4 = await fetch(
    `${BASE_URL}${platformOrderPath}/order-details?order_id=${encodeURIComponent(orderIdForDetails)}`,
    { headers }
  );
  const body4 = await r4.text();
  console.log(r4.ok ? "OK" : "FAIL", "HTTP", r4.status);
  let orderData = null;
  try {
    orderData = JSON.parse(body4);
  } catch {}
  const shipments = orderData?.shipments ?? orderData?.order ?? [];
  const shipmentList = Array.isArray(shipments) ? shipments : (shipments && typeof shipments === "object" ? [shipments] : []);
  const firstShipment = shipmentList[0];
  const resolvedShipmentId = firstShipment && typeof firstShipment === "object"
    ? (firstShipment.id ?? firstShipment.identifier ?? firstShipment.shipment_id ?? firstShipment.shipmentId ?? firstShipment._id)
    : shipmentId;
  console.log("Shipments in response:", shipmentList.length);
  if (firstShipment) console.log("Resolved shipment ID for update:", resolvedShipmentId);
  console.log(body4.slice(0, 600) + (body4.length > 600 ? "..." : ""), "\n");

  // 3b. Optional: Search by external_order_id (when Shopify order # is used)
  if (EXTERNAL_ORDER_ID) {
    const extParams = new URLSearchParams({
      group_entity: "shipments",
      page_no: "1",
      page_size: "10",
      start_date: start,
      end_date: now,
      search_value: EXTERNAL_ORDER_ID.trim(),
      search_type: "external_order_id",
      sort_type: "sla_asc",
    });
    console.log("--- 3b. Search by external_order_id (" + EXTERNAL_ORDER_ID + ") ---");
    const r3b = await fetch(`${BASE_URL}${platformOrderPath}/shipments-listing?${extParams}`, { headers });
    const body3b = await r3b.text();
    console.log(r3b.ok ? "OK" : "FAIL", "HTTP", r3b.status);
    try {
      const d = JSON.parse(body3b);
      const extItems = d?.items ?? d?.shipments ?? [];
      console.log("Items found:", Array.isArray(extItems) ? extItems.length : 0);
      if (extItems[0]) console.log("Resolved order_id:", extItems[0].order_id ?? extItems[0].orderId);
    } catch {}
    console.log("");
  }

  // 5. Update Shipment Status (return_initiated – creates return on Fynd)
  console.log("--- 5. Update Shipment Status (return_initiated) ---");
  if (!TEST_UPDATE) {
    console.log("SKIPPED (would create return). Set FYND_TEST_UPDATE=1 to run.\n");
  } else if (!resolvedShipmentId) {
    console.log("SKIPPED: No shipment ID from steps 3 or 4.\n");
  } else {
    const payload = {
      statuses: [
        {
          shipments: [
            {
              identifier: String(resolvedShipmentId),
              products: [{ line_number: 1, quantity: 1, identifier: "default" }],
              reasons: {
                products: [
                  {
                    filters: [{ identifier: "default", line_number: 1, quantity: 1 }],
                    data: { reason_id: 122, reason_text: "Other" },
                  },
                ],
              },
            },
          ],
          status: "return_initiated",
        },
      ],
      task: false,
      force_transition: false,
      lock_after_transition: false,
      unlock_before_transition: false,
    };
    const r5 = await fetch(`${BASE_URL}${platformOrderManagePath}/shipment/status-internal`, {
      method: "PUT",
      headers,
      body: JSON.stringify(payload),
    });
    const body5 = await r5.text();
    console.log(r5.ok ? "OK" : "FAIL", "HTTP", r5.status);
    console.log(body5.slice(0, 600) + (body5.length > 600 ? "..." : ""));
    if (!r5.ok) {
      console.error("\nUpdate failed. Check scopes (company/orders/read, company/orders/write) in Fynd Partners.");
    }
    console.log("");
  }

  // 6. Webhook: List subscribers
  console.log("--- 6. Webhook: List Subscribers ---");
  const r6 = await fetch(`${BASE_URL}/service/platform/webhook/v1.0/company/${COMPANY_ID}/subscriber/?page_no=1&page_size=10`, {
    headers,
  });
  const body6 = await r6.text();
  console.log(r6.ok ? "OK" : "FAIL", "HTTP", r6.status);
  try {
    const d6 = JSON.parse(body6);
    const items = d6?.items ?? [];
    console.log("Subscribers found:", items.length);
    items.slice(0, 3).forEach((s, i) => {
      console.log(`  ${i + 1}. ${s.name ?? "(unnamed)"} → ${s.webhook_url ?? "(no url)"}`);
    });
  } catch {
    console.log(body6.slice(0, 300));
  }
  console.log("");

  // 7. Webhook: Register (optional, when FYND_TEST_WEBHOOK=1 and URL set)
  if (TEST_WEBHOOK && WEBHOOK_URL) {
    console.log("--- 7. Webhook: Register Subscriber ---");
    const urlClean = String(WEBHOOK_URL).trim().replace(/\/$/, "") + "/api/webhooks/fynd";
    const registerBody = {
      webhook_config: {
        notification_email: "webhooks@test.local",
        name: "Fynd Returns (Test)",
        status: "active",
        association: {
          application_id: [APPLICATION_ID],
          criteria: "SPECIFIC-EVENTS",
        },
        event_map: {
          rest: {
            webhook_url: urlClean,
            type: "rest",
            events: [
              { event_category: "application", event_name: "refund", event_type: "refund_initiated", version: 1 },
              { event_category: "application", event_name: "refund", event_type: "refund_pending", version: 1 },
              { event_category: "application", event_name: "refund", event_type: "refund_done", version: 1 },
              { event_category: "application", event_name: "shipment", event_type: "update", version: 1 },
            ],
          },
        },
      },
    };
    const r7 = await fetch(`${BASE_URL}/service/platform/webhook/v3.0/company/${COMPANY_ID}/subscriber/`, {
      method: "PUT",
      headers,
      body: JSON.stringify(registerBody),
    });
    const body7 = await r7.text();
    console.log(r7.ok ? "OK" : "FAIL", "HTTP", r7.status);
    if (!r7.ok) {
      try {
        const err = JSON.parse(body7);
        console.log("Error:", JSON.stringify(err.err ?? err, null, 2));
      } catch {
        console.log(body7);
      }
    } else {
      try {
        const res = JSON.parse(body7);
        console.log("Response:", res.message ?? res.status ?? "Success");
      } catch {}
    }
    console.log("");
  } else if (TEST_WEBHOOK && !WEBHOOK_URL) {
    console.log("--- 7. Webhook: Register ---");
    console.log("SKIPPED: Set FYND_WEBHOOK_URL or SHOPIFY_APP_URL to test registration.\n");
  }

  console.log("=== End-to-End Test Complete ===");
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
