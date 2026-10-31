import type { FastifyPluginAsync } from "fastify";

import { authenticateRequest } from "../../plugins/authenticate.js";
import { getPaymentsRuntime } from "./payments.runtime.js";
import {
  getGooglePlayAccountId,
  listProducts,
  verifyGooglePlayPurchase,
} from "./payment.service.js";

const verifyRateLimit = {
  max: 30,
  timeWindow: 60_000,
};

const paymentRoutes: FastifyPluginAsync = async (app) => {
  // Reads the settings once at startup. A half-configured Google Play
  // setup throws here, so the server refuses to start.
  getPaymentsRuntime();

  app.get("/payments/products", async (request) => {
    await authenticateRequest(request);

    return { success: true, data: await listProducts() };
  });

  // The app passes this id to Google when it starts a purchase, so the
  // server can later check the purchase belongs to this player.
  app.get("/payments/google-play/account-id", async (request) => {
    const session = await authenticateRequest(request);

    return {
      success: true,
      data: { accountId: getGooglePlayAccountId(session.userId) },
    };
  });

  app.post<{ Body: { sku: string; purchaseToken: string } }>(
    "/payments/google-play/verify",
    {
      config: { rateLimit: verifyRateLimit },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["sku", "purchaseToken"],
          properties: {
            sku: { type: "string", minLength: 1, maxLength: 100 },
            purchaseToken: {
              type: "string",
              minLength: 1,
              maxLength: 2048,
            },
          },
        },
      },
    },
    async (request) => {
      const session = await authenticateRequest(request);

      const result = await verifyGooglePlayPurchase(
        session.userId,
        request.body.sku,
        request.body.purchaseToken,
      );

      return { success: true, data: result };
    },
  );
};

export default paymentRoutes;
