import type { FastifyPluginAsync } from "fastify";

import healthRoutes from "./health.js";
import authRoutes from "./auth.routes.js";
import walletRoutes from "../modules/wallet/wallet.routes.js";
import rewardRoutes from "../modules/rewards/reward.routes.js";
import levelRoutes from "../modules/levels/level.routes.js";
import hintRoutes from "../modules/levels/hint.routes.js";

const routes: FastifyPluginAsync = async (app) => {
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(walletRoutes);
  await app.register(rewardRoutes);
  await app.register(levelRoutes);
  await app.register(hintRoutes);
};

export default routes;
