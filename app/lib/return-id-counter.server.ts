import prisma from "../db.server";

/**
 * Atomically increment the return ID counter for a shop and return the new value.
 * Uses raw SQL for atomicity — safe for concurrent return creation.
 */
export async function nextReturnIdCounter(shopSettingsId: string): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<{ returnIdCounter: number }[]>(
    `UPDATE "ShopSettings" SET "returnIdCounter" = "returnIdCounter" + 1, "updatedAt" = NOW() WHERE "id" = $1 RETURNING "returnIdCounter"`,
    shopSettingsId,
  );
  if (!rows || rows.length === 0) {
    throw new Error(`ShopSettings not found for counter increment: ${shopSettingsId}`);
  }
  return rows[0].returnIdCounter;
}
