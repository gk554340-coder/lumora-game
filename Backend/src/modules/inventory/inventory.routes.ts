import type { FastifyPluginAsync } from "fastify";

import { authenticateRequest } from "../../plugins/authenticate.js";
import {
  equipItem,
  getInventory,
  listShop,
  purchaseItem,
  unequipSlot,
} from "./inventory.service.js";

const purchaseRateLimit = { max: 30, timeWindow: 60_000 };

const skuBody = {
  type: "object",
  additionalProperties: false,
  required: ["sku"],
  properties: {
    sku: { type: "string", minLength: 1, maxLength: 100 },
  },
};

// The server sets prices and checks ownership. The app only asks.
const inventoryRoutes: FastifyPluginAsync = async (app) => {
  app.get("/shop", async (request) => {
    const session = await authenticateRequest(request);

    return { success: true, data: await listShop(session.userId) };
  });

  app.post<{ Body: { sku: string } }>(
    "/shop/purchase",
    {
      config: { rateLimit: purchaseRateLimit },
      schema: { body: skuBody },
    },
    async (request) => {
      const session = await authenticateRequest(request);

      return {
        success: true,
        data: await purchaseItem(session.userId, request.body.sku),
      };
    },
  );

  app.get("/inventory", async (request) => {
    const session = await authenticateRequest(request);

    return { success: true, data: await getInventory(session.userId) };
  });

  app.post<{ Body: { sku: string } }>(
    "/inventory/equip",
    { schema: { body: skuBody } },
    async (request) => {
      const session = await authenticateRequest(request);

      return {
        success: true,
        data: await equipItem(session.userId, request.body.sku),
      };
    },
  );

  app.post<{ Body: { slot: string } }>(
    "/inventory/unequip",
    {
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["slot"],
          properties: {
            slot: { type: "string", minLength: 1, maxLength: 50 },
          },
        },
      },
    },
    async (request) => {
      const session = await authenticateRequest(request);

      return {
        success: true,
        data: await unequipSlot(session.userId, request.body.slot),
      };
    },
  );
};

export default inventoryRoutes;
