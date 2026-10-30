import type { FastifyPluginAsync } from "fastify";

import { authenticateRequest } from "../../plugins/authenticate.js";
import {
  claimDailyReward,
  getDailyRewardStatus,
} from "./daily-reward.service.js";

// Players can claim and look at rewards. Granting itself is internal.
const rewardRoutes: FastifyPluginAsync = async (app) => {
  app.get("/rewards/daily", async (request) => {
    const session = await authenticateRequest(request);

    return {
      success: true,
      data: await getDailyRewardStatus(session.userId),
    };
  });

  app.post("/rewards/daily/claim", async (request) => {
    const session = await authenticateRequest(request);

    return {
      success: true,
      data: await claimDailyReward(session.userId),
    };
  });
};

export default rewardRoutes;
