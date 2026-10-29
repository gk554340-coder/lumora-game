import type {
  FastifyPluginAsync,
  FastifyRequest,
} from "fastify";

import { AppError } from "../errors/AppError.js";
import { env } from "../config/env.js";
import { sessionConfig } from "../config/session.js";
import { validateSession, revokeSession } from "../services/session.service.js";
import {
  getCurrentUser,
  loginUser,
  registerUser,
} from "../services/auth.service.js";

const emailSchema = {
  type: "string",
  minLength: 3,
  maxLength: 320,
  format: "email",
};

const passwordSchema = {
  type: "string",
  minLength: 12,
  maxLength: 128,
};

// Stricter limit for credential endpoints. Password hashing is CPU
// heavy, so these routes must not share the generous global limit.
const authRateLimit = {
  max: env.authRateLimitMax,
  timeWindow: env.authRateLimitTimeWindow,
};

const authRoutes: FastifyPluginAsync = async (app) => {
  const authenticate = async (request: FastifyRequest) => {
    const header = request.headers.authorization;

    if (!header?.startsWith("Bearer ")) {
      throw new AppError(
        "UNAUTHORIZED",
        "Authentication is required.",
        401,
      );
    }

    const token = header.slice(7);

    try {
      return await validateSession(token, sessionConfig).then(
        (session) => {
          if (!session) {
            throw new AppError(
              "INVALID_SESSION",
              "Session is invalid or expired.",
              401,
            );
          }

          return session;
        },
      );
    } catch (error) {
      if (error instanceof AppError) throw error;

      throw new AppError(
        "INVALID_SESSION",
        "Session is invalid or expired.",
        401,
      );
    }
  };

  app.post<{
    Body: { email: string; password: string; username?: string };
  }>(
    "/auth/register",
    {
      config: {
        rateLimit: authRateLimit,
      },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email", "password"],
          properties: {
            email: emailSchema,
            password: passwordSchema,
            username: {
              type: "string",
              minLength: 3,
              maxLength: 32,
              pattern: "^[A-Za-z0-9_]+$",
            },
          },
        },
      },
    },
    async (request, reply) => {
      const result = await registerUser(request.body);

      return reply.code(201).send({
        success: true,
        data: result,
      });
    },
  );

  app.post<{
    Body: { email: string; password: string };
  }>(
    "/auth/login",
    {
      config: {
        rateLimit: authRateLimit,
      },
      schema: {
        body: {
          type: "object",
          additionalProperties: false,
          required: ["email", "password"],
          properties: {
            email: emailSchema,
            password: {
              type: "string",
              minLength: 1,
              maxLength: 128,
            },
          },
        },
      },
    },
    async (request) => ({
      success: true,
      data: await loginUser(request.body),
    }),
  );

  app.get("/auth/me", async (request) => {
    const session = await authenticate(request);

    return {
      success: true,
      data: await getCurrentUser(session.userId),
    };
  });

  app.post("/auth/logout", async (request) => {
    const session = await authenticate(request);
    await revokeSession(session.sessionId);

    return {
      success: true,
      message: "Logged out successfully.",
    };
  });
};

export default authRoutes;
