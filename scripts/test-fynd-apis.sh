#!/usr/bin/env bash
# End-to-end test of Fynd Platform Order APIs (same flow as the app).
# Uses: orders-listing, shipments-listing, order-details, shipment/status-internal
#
# Usage:
#   FYND_CLIENT_ID=xxx FYND_CLIENT_SECRET=xxx npm run test:fynd-api
#   FYND_CLIENT_ID=xxx FYND_CLIENT_SECRET=xxx ./scripts/test-fynd-apis.sh
#
# Optional: FYND_BASE_URL, FYND_COMPANY_ID, FYND_APPLICATION_ID, FYND_ORDER_ID
# Set FYND_TEST_UPDATE=1 to run the update-shipment-status step (creates actual return).

set -e

BASE_URL="${FYND_BASE_URL:-https://api.uat.fyndx1.de}"
COMPANY_ID="${FYND_COMPANY_ID:-2263}"
ORDER_ID="${FYND_ORDER_ID:-FYMP698CC01401C9F4A1}"
CLIENT_ID="${FYND_CLIENT_ID}"
CLIENT_SECRET="${FYND_CLIENT_SECRET}"
PLATFORM_ORDER="/service/platform/order/v1.0/company/$COMPANY_ID"
PLATFORM_ORDER_MANAGE="/service/platform/order-manage/v1.0/company/$COMPANY_ID"

if [ -z "$CLIENT_ID" ] || [ -z "$CLIENT_SECRET" ]; then
  echo "Error: FYND_CLIENT_ID and FYND_CLIENT_SECRET are required."
  echo "Usage: FYND_CLIENT_ID=xxx FYND_CLIENT_SECRET=xxx $0"
  echo "Or export them first."
  exit 1
fi

echo "=== Fynd Platform Order API – End-to-End Test ==="
echo "Order ID: $ORDER_ID"
echo "Base URL: $BASE_URL"
echo "Company ID: $COMPANY_ID"
echo "Test Update: ${FYND_TEST_UPDATE:-0}"
echo ""

# 1. OAuth Token
echo "--- 1. OAuth Token ---"
TOKEN_RESP=$(curl -s -X POST "$BASE_URL/service/panel/authentication/v1.0/company/$COMPANY_ID/oauth/token" \
  -H "Content-Type: application/json" \
  -H "Authorization: Basic $(echo -n "$CLIENT_ID:$CLIENT_SECRET" | base64)" \
  -d '{"grant_type":"client_credentials"}')

if echo "$TOKEN_RESP" | grep -q '"access_token"'; then
  TOKEN=$(echo "$TOKEN_RESP" | grep -o '"access_token":"[^"]*"' | cut -d'"' -f4)
  echo "OK: Token obtained"
else
  echo "FAIL: $TOKEN_RESP"
  exit 1
fi
echo ""

# 2. Test Connection (orders-listing)
echo "--- 2. Test Connection (orders-listing) ---"
R2=$(curl -s -w "\n%{http_code}" -X GET "$BASE_URL$PLATFORM_ORDER/orders-listing?page_no=1&page_size=1" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN")
HTTP2=$(echo "$R2" | tail -n1)
BODY2=$(echo "$R2" | sed '$d')
[ "$HTTP2" = "200" ] && echo "OK: HTTP $HTTP2" || { echo "FAIL: HTTP $HTTP2"; echo "$BODY2"; }
echo ""

# 3. Search Shipments (shipments-listing)
echo "--- 3. Search Shipments (shipments-listing) ---"
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
if date -v-1M >/dev/null 2>&1; then
  START=$(date -u -v-1M +"%Y-%m-%dT%H:%M:%S.000Z")
else
  START=$(date -u -d "1 month ago" +"%Y-%m-%dT%H:%M:%S.000Z" 2>/dev/null || echo "2025-01-23T00:00:00.000Z")
fi
SEARCH_TYPE="order_id"
SEARCH_URL="$BASE_URL$PLATFORM_ORDER/shipments-listing?group_entity=shipments&page_no=1&page_size=10&start_date=$START&end_date=$NOW&search_value=$ORDER_ID&search_type=$SEARCH_TYPE&sort_type=sla_asc"
R3=$(curl -s -w "\n%{http_code}" -X GET "$SEARCH_URL" -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN")
HTTP3=$(echo "$R3" | tail -n1)
BODY3=$(echo "$R3" | sed '$d')
[ "$HTTP3" = "200" ] && echo "OK: HTTP $HTTP3" || echo "FAIL: HTTP $HTTP3"
echo "$BODY3" | head -c 600
echo "..."
echo ""

# 4. Get Order Details (order-details)
echo "--- 4. Get Order Details (order-details) ---"
ORDER_ENC=$(echo "$ORDER_ID" | sed 's/:/%3A/g')
R4=$(curl -s -w "\n%{http_code}" -X GET "$BASE_URL$PLATFORM_ORDER/order-details?order_id=$ORDER_ENC" \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN")
HTTP4=$(echo "$R4" | tail -n1)
BODY4=$(echo "$R4" | sed '$d')
[ "$HTTP4" = "200" ] && echo "OK: HTTP $HTTP4" || echo "FAIL: HTTP $HTTP4"
echo "$BODY4" | head -c 800
echo "..."
echo ""

# 5. Update Shipment Status
echo "--- 5. Update Shipment Status (return_initiated) ---"
if [ "${FYND_TEST_UPDATE:-0}" = "1" ]; then
  echo "Running update (creates actual return on Fynd)..."
  PAYLOAD='{"statuses":[{"shipments":[{"identifier":"PLACEHOLDER","products":[{"line_number":1,"quantity":1,"identifier":"default"}],"reasons":{"products":[{"filters":[{"identifier":"default","line_number":1,"quantity":1}],"data":{"reason_id":122,"reason_text":"Other"}}]}}],"status":"return_initiated"}],"task":false,"force_transition":false,"lock_after_transition":false,"unlock_before_transition":false}'
  echo "Note: Bash script uses placeholder shipment ID. Use test-fynd-apis.mjs with FYND_TEST_UPDATE=1 for full flow."
  R5=$(curl -s -w "\n%{http_code}" -X PUT "$BASE_URL$PLATFORM_ORDER_MANAGE/shipment/status-internal" \
    -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" -d "$PAYLOAD")
  HTTP5=$(echo "$R5" | tail -n1)
  echo "HTTP $HTTP5"
else
  echo "SKIPPED (would create return). Set FYND_TEST_UPDATE=1 to run."
fi
echo ""

echo "=== End-to-End Test Complete ==="
