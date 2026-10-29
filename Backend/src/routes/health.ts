import type { FastifyPluginAsync } from "fastify";

import { env } from "../config/env.js";

const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get("/health", async () => {
    return {
      status: "ok",
      service: env.appName,
      version: env.appVersion,
      // The environment name is internal detail; do not expose it publicly.
      ...(env.nodeEnv === "production"
        ? {}
        : { environment: env.nodeEnv }),
    };
  });
};

export default healthRoutes;
