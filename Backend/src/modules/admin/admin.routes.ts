import type { FastifyPluginAsync } from "fastify";

import {
  authenticateAdmin,
  getAdminKey,
} from "../../plugins/authenticate-admin.js";
import {
  adjustWallet,
  listUnrecoveredRefunds,
  lookupUser,
  reactivateUser,
  suspendUser,
  type AdjustCurrency,
  type AdjustDirection,
} from "./admin.service.js";

const DEFAULT_ADMIN_RATE_LIMIT = 20;

// Strict limit: this also slows down anybody guessing the admin key.
// ADMIN_RATE_LIMIT_MAX (1 to 10000) can change it, for example in tests.
function readAdminRateLimit(): { max: number; timeWindow: number } {
  const raw = process.env.ADMIN_RATE_LIMIT_MAX?.trim();
  const value = raw ? Number(raw) : DEFAULT_ADMIN_RATE_LIMIT;

  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new Error(
      "Invalid ADMIN_RATE_LIMIT_MAX. Expected an integer between 1 and 10000.",
    );
  }

  return { max: value, timeWindow: 60_000 };
}

const reasonBody = {
  type: "object",
  additionalProperties: false,
  required: ["reason"],
  properties: {
    reason: { type: "string", minLength: 1, maxLength: 500 },
  },
};

const adminRoutes: FastifyPluginAsync = async (app) => {
  // Checks the key length once at startup. A short key throws here, so
  // the server refuses to start.
  getAdminKey();

  const adminRateLimit = readAdminRateLimit();

  app.get<{ Querystring: { email?: string; id?: string } }>(
    "/admin/users/lookup",
    {
      config: { rateLimit: adminRateLimit },
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            email: { type: "string", maxLength: 320 },
            id: { type: "string", maxLength: 64 },
          },
        },
      },
    },
    async (request) => {
      authenticateAdmin(request);

      return { success: true, data: await lookupUser(request.query) };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    "/admin/users/:id/suspend",
    {
      config: { rateLimit: adminRateLimit },
      schema: { body: reasonBody },
    },
    async (request) => {
      authenticateAdmin(request);

      return {
        success: true,
        data: await suspendUser(request.params.id, request.body.reason),
      };
    },
  );

  app.post<{ Params: { id: string }; Body: { reason: string } }>(
    "/admin/users/:id/reactivate",
    {
      config: { rateLimit: adminRateLimit },
      schema: { body: reasonBody },
    },
    async (request) => {
      authenticateAdmin(request);

      return {
        success: true,
        data: await reactivateUser(request.params.id, request.body.reason),
      };
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      currency: AdjustCurrency;
      direction: AdjustDirection;
      amount: number;
      reason: string;
      requestId: string;
    };
  }>(
    "/admin/users/:id/wallet-adjust",
    {
      config: { rateLimit: adminRateLimit },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: [
            "currency",
            "direction",
            "amount",
            "reason",
            "requestId",
          ],
          properties: {
            currency: { type: "string", maxLength: 10 },
            direction: { type: "string", maxLength: 10 },
            amount: { type: "integer" },
            reason: { type: "string", minLength: 1, maxLength: 500 },
            requestId: { type: "string", minLength: 1, maxLength: 100 },
          },
        },
      },
    },
    async (request) => {
      authenticateAdmin(request);

      return {
        success: true,
        data: await adjustWallet({
          userId: request.params.id,
          ...request.body,
        }),
      };
    },
  );

  app.get<{ Querystring: { limit?: number } }>(
    "/admin/refunds/unrecovered",
    {
      config: { rateLimit: adminRateLimit },
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: { limit: { type: "integer" } },
        },
      },
    },
    async (request) => {
      authenticateAdmin(request);

      return {
        success: true,
        data: await listUnrecoveredRefunds(request.query.limit),
      };
    },
  );
};

export default adminRoutes;
