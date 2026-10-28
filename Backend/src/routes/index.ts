import type { FastifyPluginAsync } from "fastify";

import healthRoutes from "./health.js";

const routes: FastifyPluginAsync = async (app) => {
  await app.register(healthRoutes);
};

export default routes;
