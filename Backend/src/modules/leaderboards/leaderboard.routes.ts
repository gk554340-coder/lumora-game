import type { FastifyPluginAsync } from "fastify";

import { authenticateRequest } from "../../plugins/authenticate.js";
import {
  DEFAULT_LEADERBOARD_LIMIT,
  MAX_LEADERBOARD_LIMIT,
  getGlobalLeaderboard,
  getLevelLeaderboard,
} from "./leaderboard.service.js";

const limitQuery = {
  type: "object",
  properties: {
    limit: {
      type: "integer",
      minimum: 1,
      maximum: MAX_LEADERBOARD_LIMIT,
      default: DEFAULT_LEADERBOARD_LIMIT,
    },
  },
};

// Read-only. Rankings are computed from verified player progress.
const leaderboardRoutes: FastifyPluginAsync = async (app) => {
  app.get<{ Querystring: { limit?: number } }>(
    "/leaderboards/global",
    { schema: { querystring: limitQuery } },
    async (request) => {
      const session = await authenticateRequest(request);

      return {
        success: true,
        data: await getGlobalLeaderboard(
          session.userId,
          request.query.limit,
        ),
      };
    },
  );

  app.get<{
    Params: { levelNumber: number };
    Querystring: { limit?: number };
  }>(
    "/leaderboards/levels/:levelNumber",
    {
      schema: {
        params: {
          type: "object",
          required: ["levelNumber"],
          properties: {
            levelNumber: { type: "integer", minimum: 1 },
          },
        },
        querystring: limitQuery,
      },
    },
    async (request) => {
      const session = await authenticateRequest(request);

      return {
        success: true,
        data: await getLevelLeaderboard(
          session.userId,
          request.params.levelNumber,
          request.query.limit,
        ),
      };
    },
  );
};

export default leaderboardRoutes;
