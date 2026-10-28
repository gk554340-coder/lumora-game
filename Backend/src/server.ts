import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";

import { env, requireProductionSecrets } from "./config/env.js";

const app = Fastify({
  logger: {
    level: env.logLevel
  }
});

await app.register(helmet);

await app.register(cors, {
  origin: env.corsOrigin ?? false
});

await app.register(rateLimit, {
  max: 100,
  timeWindow: "1 minute"
});

app.get("/health", async () => {
  return {
    status: "ok",
    service: env.appName,
    version: env.appVersion,
    environment: env.nodeEnv
  };
});

const start = async (): Promise<void> => {
  try {
    requireProductionSecrets();

    await app.listen({
      port: env.port,
      host: "0.0.0.0"
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

await start();
