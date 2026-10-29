import type { FastifyPluginAsync } from "fastify";

import { authenticateRequest } from "../../plugins/authenticate.js";
import {
  getWalletBalances,
  listWalletTransactions,
  type SupportedCurrency,
} from "./wallet.service.js";

const DEFAULT_PAGE_SIZE = 20;

// Read-only. Balances are never changed from the client.
const walletRoutes: FastifyPluginAsync = async (app) => {
  app.get("/wallet", async (request) => {
    const session = await authenticateRequest(request);

    return {
      success: true,
      data: await getWalletBalances(session.userId),
    };
  });

  app.get<{
    Querystring: {
      limit?: number;
      cursor?: string;
      currency?: SupportedCurrency;
    };
  }>(
    "/wallet/transactions",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: {
              type: "integer",
              minimum: 1,
              maximum: 100,
              default: DEFAULT_PAGE_SIZE,
            },
            cursor: {
              type: "string",
              format: "uuid",
            },
            currency: {
              type: "string",
              enum: ["TOKEN", "GEM"],
            },
          },
        },
      },
    },
    async (request) => {
      const session = await authenticateRequest(request);

      const result = await listWalletTransactions(session.userId, {
        limit: request.query.limit ?? DEFAULT_PAGE_SIZE,
        cursor: request.query.cursor,
        currency: request.query.currency,
      });

      return {
        success: true,
        data: result,
      };
    },
  );
};

export default walletRoutes;
