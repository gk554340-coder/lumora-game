import type { FastifyPluginAsync } from "fastify";

import { authenticateRequest } from "../../plugins/authenticate.js";
import {
  getCurrentEvent,
  getEventLeaderboard,
} from "./event.service.js";

// Read-only. Scores come from verified play, never from the app.
const eventRoutes: FastifyPluginAsync = async (app) => {
  app.get("/events/current", async (request) => {
    const session = await authenticateRequest(request);

    return {
      success: true,
      data: await getCurrentEvent(session.userId),
    };
  });

  app.get<{
    Params: { eventId: string };
    Querystring: { limit?: number };
  }>(
    "/events/:eventId/leaderboard",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer" },
          },
        },
      },
    },
    async (request) => {
      const session = await authenticateRequest(request);

      return {
        success: true,
        data: await getEventLeaderboard(
          session.userId,
          request.params.eventId,
          request.query.limit,
        ),
      };
    },
  );
};

export default eventRoutes;
