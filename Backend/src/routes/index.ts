import type { FastifyPluginAsync } from "fastify";

import healthRoutes from "./health.js";
import authRoutes from "./auth.routes.js";
import walletRoutes from "../modules/wallet/wallet.routes.js";
import rewardRoutes from "../modules/rewards/reward.routes.js";

const routes: FastifyPluginAsync = async (app) => {
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(walletRoutes);
  await app.register(rewardRoutes);
};

export default routes;
