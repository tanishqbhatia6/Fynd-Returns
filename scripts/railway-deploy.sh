#!/usr/bin/env bash
# Deploy to Railway using the Railway CLI
# Usage: ./scripts/railway-deploy.sh
#
# Prerequisites:
#   1. Railway CLI installed: npm install -g @railway/cli
#   2. Authenticated: railway login
#   3. Linked to a project: railway link
#
# Environment variables (optional):
#   RAILWAY_TOKEN — for CI/headless deploys

set -euo pipefail

echo "Deploying to Railway..."

railway up --detach

echo ""
echo "Deploy triggered. View logs with:"
echo "  npm run railway:logs"
