import { createHash, timingSafeEqual } from "node:crypto";

import type { FastifyRequest } from "fastify";

import { AppError } from "../errors/AppError.js";

/**
 * Admin access.
 *
 * Admin endpoints are protected by one secret key sent in the
 * "x-admin-key" header. If ADMIN_API_KEY is not set, the admin
 * endpoints do not exist (404). A key shorter than 32 characters is
 * refused when the server starts, so a weak key never goes live.
 *
 * The key is compared in constant time. Admin routes also have a
 * strict rate limit, and every admin action is written to the audit
 * log.
 *
 * Keep the admin endpoints off the public internet where possible,
 * for example by only allowing your office network at the proxy.
 */

export const MIN_ADMIN_KEY_LENGTH = 32;
export const ADMIN_ACTOR = "admin-key";

export function getAdminKey(): string | null {
  const key = process.env.ADMIN_API_KEY?.trim();

  if (!key) {
    return null;
  }

  if (key.length < MIN_ADMIN_KEY_LENGTH) {
    throw new Error(
      `ADMIN_API_KEY must be at least ${MIN_ADMIN_KEY_LENGTH} characters.`,
    );
  }

  return key;
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function authenticateAdmin(request: FastifyRequest): void {
  const expected = getAdminKey();

  if (expected === null) {
    throw new AppError("NOT_FOUND", "Not found.", 404);
  }

  const header = request.headers["x-admin-key"];
  const provided = typeof header === "string" ? header : "";

  if (!timingSafeEqual(digest(provided), digest(expected))) {
    throw new AppError(
      "ADMIN_UNAUTHORIZED",
      "Admin authentication failed.",
      401,
    );
  }
}
