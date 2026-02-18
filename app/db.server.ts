import { PrismaClient } from "@prisma/client";

declare global {
  var prismaGlobal: PrismaClient;
}

const prisma =
  process.env.NODE_ENV !== "production"
    ? (global.prismaGlobal ??= new PrismaClient())
    : new PrismaClient();

export default prisma;
