import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";

import { env } from "./config/env.js";

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: env.logLevel
    }
  });

  app.register(helmet);

  app.register(cors, {
    origin: env.corsOrigin ?? false
  });

  app.register(rateLimit, {
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

  return app;
}
