
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";
import { env } from "./env.js";
import { databaseConfig } from "./database.js";

const adapter = new PrismaPg({
  connectionString: databaseConfig.url,
  max: databaseConfig.maxConnections,
  connectionTimeoutMillis: databaseConfig.connectionTimeoutMs,
});

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    adapter,
    log:
      env.nodeEnv === "production"
        ? ["error"]
        : ["warn", "error"],
  });

if (env.nodeEnv !== "production") {
  globalForPrisma.prisma = prisma;
}

export async function connectDatabase(): Promise<void> {
  await prisma.$connect();
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}
