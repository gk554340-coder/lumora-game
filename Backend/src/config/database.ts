import { env } from "./env.js";

export const databaseConfig = {
  url: env.databaseUrl,
  maxConnections: 10,
  connectionTimeoutMs: 10_000
} as const;
