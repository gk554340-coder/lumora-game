import type { FastifyPluginAsync } from "fastify";

import healthRoutes from "./health.js";
import authRoutes from "./auth.routes.js";
import walletRoutes from "../modules/wallet/wallet.routes.js";
import rewardRoutes from "../modules/rewards/reward.routes.js";
import levelRoutes from "../modules/levels/level.routes.js";
import hintRoutes from "../modules/levels/hint.routes.js";
import leaderboardRoutes from "../modules/leaderboards/leaderboard.routes.js";
import achievementRoutes from "../modules/achievements/achievement.routes.js";
import paymentRoutes from "../modules/payments/payment.routes.js";
import inventoryRoutes from "../modules/inventory/inventory.routes.js";
import eventRoutes from "../modules/events/event.routes.js";
import notificationRoutes from "../modules/notifications/notification.routes.js";
import adminRoutes from "../modules/admin/admin.routes.js";

const routes: FastifyPluginAsync = async (app) => {
  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(walletRoutes);
  await app.register(rewardRoutes);
  await app.register(levelRoutes);
  await app.register(hintRoutes);
  await app.register(leaderboardRoutes);
  await app.register(achievementRoutes);
  await app.register(paymentRoutes);
  await app.register(inventoryRoutes);
  await app.register(eventRoutes);
  await app.register(notificationRoutes);
  await app.register(adminRoutes);
};

export default routes;
