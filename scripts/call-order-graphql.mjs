#!/usr/bin/env node
/**
 * Call Shopify Admin GraphQL orders query and print response.
 * Requires: DATABASE_URL (e.g. from .env), and optionally SHOP (default fynd-store-1.myshopify.com)
 * Run from project root: node scripts/call-order-graphql.mjs
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

// Load .env if present
const envPath = resolve(process.cwd(), ".env");
if (existsSync(envPath)) {
  const content = readFileSync(envPath, "utf8");
  content.split("\n").forEach((line) => {
    const m = line.match(/^\s*([^#=]+)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, "");
  });
}

import { PrismaClient } from "@prisma/client";

const SHOP = process.env.SHOP || "fynd-store-1.myshopify.com";
const shopDomain = SHOP.includes(".") ? SHOP : `${SHOP}.myshopify.com`;
const API_VERSION = "2026-01";

const QUERY = `query {
  orders(first: 1, query: "name:#FYNDSHOPIFYX14122") {
    edges {
      node {
        id
        name
        legacyResourceId
      }
    }
  }
}`;

async function main() {
  const prisma = new PrismaClient();
  try {
    const session = await prisma.session.findFirst({
      where: { shop: shopDomain, isOnline: false },
      select: { accessToken: true },
    });
    if (!session?.accessToken) {
      console.error("No offline session found for shop:", shopDomain);
      process.exit(1);
    }

    const url = `https://${shopDomain}/admin/api/${API_VERSION}/graphql.json`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": session.accessToken,
      },
      body: JSON.stringify({ query: QUERY }),
    });

    const data = await res.json();
    console.log(JSON.stringify(data, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
