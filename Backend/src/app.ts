import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";

import { env } from "./config/env.js";
import routes from "./routes/index.js";
import errorHandler from "./plugins/error-handler.js";

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

  app.register(errorHandler);

  app.register(routes, {
    prefix: "/api"
  });

  return app;
}
