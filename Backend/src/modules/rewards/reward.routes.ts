import type { FastifyPluginAsync } from "fastify";

import { authenticateRequest } from "../../plugins/authenticate.js";
import { checkAchievementsSafely } from "../achievements/achievement.service.js";
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

    const result = await claimDailyReward(session.userId);

    // The claim is already saved. A problem while checking achievements
    // must not fail it.
    const achievements = await checkAchievementsSafely(
      session.userId,
      (error) =>
        request.log.error({ err: error }, "Achievement check failed"),
    );

    return {
      success: true,
      data: { ...result, achievements },
    };
  });
};

export default rewardRoutes;
