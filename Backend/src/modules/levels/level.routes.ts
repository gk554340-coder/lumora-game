import type { FastifyPluginAsync } from "fastify";

import { authenticateRequest } from "../../plugins/authenticate.js";
import { checkAchievementsSafely } from "../achievements/achievement.service.js";
import {
  MAX_LEVEL_NUMBER,
  getLevelProgress,
  startLevel,
  submitAttempt,
} from "./level.service.js";
import { MAX_MOVES } from "./lumen-engine.js";

const startSchema = {
  params: {
    type: "object",
    required: ["levelNumber"],
    properties: {
      levelNumber: { type: "integer", minimum: 1, maximum: MAX_LEVEL_NUMBER },
    },
  },
};

const submitSchema = {
  params: {
    type: "object",
    required: ["attemptId"],
    properties: {
      attemptId: {
        type: "string",
        pattern:
          "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
      },
    },
  },
  body: {
    type: "object",
    required: ["moves"],
    properties: {
      moves: {
        type: "array",
        minItems: 1,
        maxItems: MAX_MOVES,
        items: { type: "integer", minimum: 0 },
      },
    },
  },
};

// The client sends moves only. Results, stars, time and rewards are all
// decided by the server.
const levelRoutes: FastifyPluginAsync = async (app) => {
  app.get("/levels/progress", async (request) => {
    const session = await authenticateRequest(request);

    return {
      success: true,
      data: await getLevelProgress(session.userId),
    };
  });

  app.post<{ Params: { levelNumber: number } }>(
    "/levels/:levelNumber/start",
    { schema: startSchema },
    async (request, reply) => {
      const session = await authenticateRequest(request);

      const data = await startLevel(
        session.userId,
        request.params.levelNumber,
      );

      return reply.code(201).send({ success: true, data });
    },
  );

  app.post<{ Params: { attemptId: string }; Body: { moves: number[] } }>(
    "/levels/attempts/:attemptId/submit",
    { schema: submitSchema },
    async (request) => {
      const session = await authenticateRequest(request);

      const result = await submitAttempt(
        session.userId,
        request.params.attemptId,
        request.body.moves,
      );

      // The level is already saved. A problem while checking
      // achievements must not fail the submission.
      const achievements = await checkAchievementsSafely(
        session.userId,
        (error) =>
          request.log.error({ err: error }, "Achievement check failed"),
      );

      return {
        success: true,
        data: { ...result, achievements },
      };
    },
  );
};

export default levelRoutes;
