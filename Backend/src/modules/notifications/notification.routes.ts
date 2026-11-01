import type { FastifyPluginAsync } from "fastify";

import { authenticateRequest } from "../../plugins/authenticate.js";
import {
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from "./notification.service.js";

// Players read and mark their own notifications. Creating them is
// done by the server only.
const notificationRoutes: FastifyPluginAsync = async (app) => {
  app.get<{
    Querystring: { limit?: number; cursor?: string; unreadOnly?: boolean };
  }>(
    "/notifications",
    {
      schema: {
        querystring: {
          type: "object",
          additionalProperties: false,
          properties: {
            limit: { type: "integer" },
            cursor: { type: "string", maxLength: 300 },
            unreadOnly: { type: "boolean" },
          },
        },
      },
    },
    async (request) => {
      const session = await authenticateRequest(request);

      return {
        success: true,
        data: await listNotifications(session.userId, request.query),
      };
    },
  );

  app.get("/notifications/unread-count", async (request) => {
    const session = await authenticateRequest(request);

    return {
      success: true,
      data: { unread: await getUnreadCount(session.userId) },
    };
  });

  app.post("/notifications/read-all", async (request) => {
    const session = await authenticateRequest(request);

    return {
      success: true,
      data: await markAllNotificationsRead(session.userId),
    };
  });

  app.post<{ Params: { id: string } }>(
    "/notifications/:id/read",
    async (request) => {
      const session = await authenticateRequest(request);

      return {
        success: true,
        data: await markNotificationRead(
          session.userId,
          request.params.id,
        ),
      };
    },
  );
};

export default notificationRoutes;
