import type { FastifyPluginAsync } from "fastify";

import { authenticateRequest } from "../../plugins/authenticate.js";
import { requestHint } from "./hint.service.js";
import { MAX_MOVES } from "./lumen-engine.js";

const hintSchema = {
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
        maxItems: MAX_MOVES,
        items: { type: "integer", minimum: 0 },
      },
    },
  },
};

// The player sends the moves made so far. The server names one tile to
// flip next and charges tokens for it.
const hintRoutes: FastifyPluginAsync = async (app) => {
  app.post<{ Params: { attemptId: string }; Body: { moves: number[] } }>(
    "/levels/attempts/:attemptId/hint",
    { schema: hintSchema },
    async (request) => {
      const session = await authenticateRequest(request);

      return {
        success: true,
        data: await requestHint(
          session.userId,
          request.params.attemptId,
          request.body.moves,
        ),
      };
    },
  );
};

export default hintRoutes;
