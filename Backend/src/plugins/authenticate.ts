import type { FastifyRequest } from "fastify";

import { AppError } from "../errors/AppError.js";
import { sessionConfig } from "../config/session.js";
import {
  validateSession,
  type ValidatedSession,
} from "../services/session.service.js";

/**
 * Shared authentication for protected routes. Reads the Bearer token,
 * validates the session (including the owning user's status) and returns
 * it, or throws a 401 AppError. Every module must use this function
 * instead of parsing the Authorization header itself.
 */
export async function authenticateRequest(
  request: FastifyRequest,
): Promise<ValidatedSession> {
  const header = request.headers.authorization;

  if (!header?.startsWith("Bearer ")) {
    throw new AppError(
      "UNAUTHORIZED",
      "Authentication is required.",
      401,
    );
  }

  const token = header.slice(7);

  let session: ValidatedSession | null;

  try {
    session = await validateSession(token, sessionConfig);
  } catch {
    throw new AppError(
      "INVALID_SESSION",
      "Session is invalid or expired.",
      401,
    );
  }

  if (!session) {
    throw new AppError(
      "INVALID_SESSION",
      "Session is invalid or expired.",
      401,
    );
  }

  return session;
}
