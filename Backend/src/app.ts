import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";

import { env } from "./config/env.js";
import routes from "./routes/index.js";
import { registerErrorHandler } from "./plugins/error-handler.js";

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: env.logLevel,
    },
    // Enable only behind a trusted reverse proxy or load balancer.
    // Otherwise every client appears to share the proxy IP address and
    // rate limiting would apply to all users at once.
    trustProxy: env.trustProxy,
  });

  app.register(helmet);

  app.register(cors, {
    origin: env.corsOrigin ?? false,
  });

  app.register(rateLimit, {
    max: env.rateLimitMax,
    timeWindow: env.rateLimitTimeWindow,
  });

  registerErrorHandler(app);

  app.register(routes, {
    prefix: "/api",
  });

  return app;
}
