#!/usr/bin/env bash
# Deploy to Render using the Render CLI
# Usage: ./scripts/render-deploy.sh [--clear-cache]
#
# Prerequisites:
#   1. render CLI installed: brew tap render-oss/render && brew install render
#   2. Authenticated: render login
#   3. RENDER_SERVICE_ID set in your environment or .env.local
#
# Set RENDER_SERVICE_ID in your shell:
#   export RENDER_SERVICE_ID=srv-xxxxxxxxxxxxxxxxx

set -euo pipefail

CLEAR_CACHE=false
if [[ "${1:-}" == "--clear-cache" ]]; then
  CLEAR_CACHE=true
fi

# Try to load RENDER_SERVICE_ID from .env.local if not already set
if [[ -z "${RENDER_SERVICE_ID:-}" ]] && [[ -f .env.local ]]; then
  export $(grep -E '^RENDER_SERVICE_ID=' .env.local | xargs)
fi

if [[ -z "${RENDER_SERVICE_ID:-}" ]]; then
  echo "Error: RENDER_SERVICE_ID is not set."
  echo "  Set it in your environment: export RENDER_SERVICE_ID=srv-xxxx"
  echo "  Or add it to .env.local: RENDER_SERVICE_ID=srv-xxxx"
  echo ""
  echo "  Find your service ID in the Render dashboard URL:"
  echo "  https://dashboard.render.com/web/srv-XXXXXXXXXX"
  exit 1
fi

echo "Deploying service $RENDER_SERVICE_ID to Render..."

if $CLEAR_CACHE; then
  render deploys create "$RENDER_SERVICE_ID" --clear-cache --confirm
else
  render deploys create "$RENDER_SERVICE_ID" --confirm
fi

echo ""
echo "Deploy triggered. Stream logs with:"
echo "  npm run render:logs"
