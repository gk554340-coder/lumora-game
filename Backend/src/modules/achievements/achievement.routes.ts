import type { FastifyPluginAsync } from "fastify";

import { authenticateRequest } from "../../plugins/authenticate.js";
import { listAchievements } from "./achievement.service.js";

// Players can look at their achievements. Progress and rewards are
// decided by the server from verified play.
const achievementRoutes: FastifyPluginAsync = async (app) => {
  app.get("/achievements", async (request) => {
    const session = await authenticateRequest(request);

    return {
      success: true,
      data: await listAchievements(session.userId),
    };
  });
};

export default achievementRoutes;
