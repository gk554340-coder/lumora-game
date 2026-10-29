import type { FastifyPluginAsync } from "fastify";

import healthRoutes from "./health.js";
import authRoutes from "./auth.routes.js";
import walletRoutes from "../modules/wallet/wallet.routes.js";

const routes: FastifyPluginAsync = async (app) => {
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(walletRoutes);
};

export default routes;
