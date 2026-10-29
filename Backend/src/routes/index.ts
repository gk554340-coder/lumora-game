import type { FastifyPluginAsync } from "fastify";

import healthRoutes from "./health.js";
import authRoutes from "./auth.routes.js";

const routes: FastifyPluginAsync = async (app) => {
  await app.register(healthRoutes);
  await app.register(authRoutes);
};

export default routes;
