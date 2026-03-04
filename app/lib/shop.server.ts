import prisma from "../db.server";
import type { Shop, ShopSettings } from "@prisma/client";

type ShopWithSettings = Shop & { settings: ShopSettings | null };

/**
 * Find or create a Shop record with settings.
 * Consolidates the repeated pattern used across all settings routes.
 */
export async function findOrCreateShop(shopDomain: string): Promise<ShopWithSettings> {
  const existing = await prisma.shop.findUnique({
    where: { shopDomain },
    include: { settings: true },
  });
  if (existing) return existing;
  return prisma.shop.create({
    data: { shopDomain },
    include: { settings: true },
  });
}
