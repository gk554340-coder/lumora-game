import { createHash, randomBytes } from "node:crypto";

import { SessionStatus, UserStatus } from "../generated/prisma/client.js";
import { prisma } from "../config/prisma.js";

export interface SessionServiceConfig {
  tokenBytes: number;
  ttlSeconds: number;
  maxTokenLength: number;
  lastUsedUpdateIntervalSeconds: number;
}

export interface CreatedSession {
  sessionId: string;
  token: string;
  expiresAt: Date;
}

export interface ValidatedSession {
  sessionId: string;
  userId: string;
  expiresAt: Date;
}

const MAX_SESSION_TOKEN_BYTES = 64;
const MAX_SESSION_TTL_SECONDS = 31_536_000;
const MAX_SESSION_TOKEN_LENGTH = 1024;

function hashSessionToken(token: string): string {
  return createHash("sha256")
    .update(token, "utf8")
    .digest("hex");
}

function createSessionExpiry(
  now: Date,
  ttlSeconds: number,
): Date {
  const expiresAt = new Date(
    now.getTime() + ttlSeconds * 1000,
  );

  if (!Number.isFinite(expiresAt.getTime())) {
    throw new Error("Invalid session expiration time.");
  }

  return expiresAt;
}

function validateConfiguration(
  config: SessionServiceConfig,
): void {
  if (
    !Number.isSafeInteger(config.tokenBytes) ||
    config.tokenBytes < 1 ||
    config.tokenBytes > MAX_SESSION_TOKEN_BYTES
  ) {
    throw new Error("Invalid session token byte configuration.");
  }

  if (
    !Number.isSafeInteger(config.ttlSeconds) ||
    config.ttlSeconds < 1 ||
    config.ttlSeconds > MAX_SESSION_TTL_SECONDS
  ) {
    throw new Error("Invalid session TTL configuration.");
  }

  if (
    !Number.isSafeInteger(config.maxTokenLength) ||
    config.maxTokenLength < 1 ||
    config.maxTokenLength > MAX_SESSION_TOKEN_LENGTH
  ) {
    throw new Error("Invalid session token length configuration.");
  }

  if (
    !Number.isSafeInteger(config.lastUsedUpdateIntervalSeconds) ||
    config.lastUsedUpdateIntervalSeconds < 0
  ) {
    throw new Error(
      "Invalid session last-used update interval configuration.",
    );
  }

  const minimumEncodedTokenLength = Math.ceil(
    (config.tokenBytes * 8) / 6,
  );

  if (config.maxTokenLength < minimumEncodedTokenLength) {
    throw new Error(
      "Session token length is too small for the configured token size.",
    );
  }
}

function validateToken(
  token: string,
  config: SessionServiceConfig,
): string | null {
  if (
    typeof token !== "string" ||
    token.length === 0 ||
    token.length > config.maxTokenLength ||
    token.trim() !== token ||
    !/^[A-Za-z0-9_-]+$/.test(token)
  ) {
    return null;
  }

  return token;
}

export async function createSession(
  userId: string,
  config: SessionServiceConfig,
): Promise<CreatedSession> {
  validateConfiguration(config);

  if (
    typeof userId !== "string" ||
    userId.trim().length === 0
  ) {
    throw new Error("User ID is required to create a session.");
  }

  const now = new Date();
  const token = randomBytes(config.tokenBytes).toString("base64url");
  const tokenHash = hashSessionToken(token);
  const expiresAt = createSessionExpiry(now, config.ttlSeconds);

  const session = await prisma.session.create({
    data: {
      userId,
      tokenHash,
      status: SessionStatus.ACTIVE,
      expiresAt,
      lastUsedAt: now,
    },
    select: {
      id: true,
      expiresAt: true,
    },
  });

  return {
    sessionId: session.id,
    token,
    expiresAt: session.expiresAt,
  };
}

/**
 * Returns the session only when the session is ACTIVE, not expired, and
 * its owning user is ACTIVE. A suspended or deleted user loses access on
 * the very next request, even if the session row itself is still valid.
 */
export async function validateSession(
  token: string,
  config: SessionServiceConfig,
): Promise<ValidatedSession | null> {
  validateConfiguration(config);

    const normalizedToken = validateToken(token, config);

  if (normalizedToken === null) {
    return null;
  }
  const tokenHash = hashSessionToken(normalizedToken);
  const now = new Date();

  const session = await prisma.session.findUnique({
    where: {
      tokenHash,
    },
    select: {
      id: true,
      userId: true,
      status: true,
      expiresAt: true,
      lastUsedAt: true,
      user: {
        select: {
          status: true,
        },
      },
    },
  });

  if (
    !session ||
    session.status !== SessionStatus.ACTIVE ||
    session.user.status !== UserStatus.ACTIVE
  ) {
    return null;
  }

  if (session.expiresAt <= now) {
    await prisma.session.updateMany({
      where: {
        id: session.id,
        status: SessionStatus.ACTIVE,
        expiresAt: {
          lte: now,
        },
      },
      data: {
        status: SessionStatus.EXPIRED,
      },
    });

    return null;
  }

  const lastUsedUpdateDue =
    session.lastUsedAt === null ||
    now.getTime() - session.lastUsedAt.getTime() >=
      config.lastUsedUpdateIntervalSeconds * 1000;

  if (lastUsedUpdateDue) {
    const updateResult = await prisma.session.updateMany({
      where: {
        id: session.id,
        status: SessionStatus.ACTIVE,
        expiresAt: {
          gt: now,
        },
      },
      data: {
        lastUsedAt: now,
      },
    });

    if (updateResult.count === 0) {
      return null;
    }
  }

  return {
    sessionId: session.id,
    userId: session.userId,
    expiresAt: session.expiresAt,
  };
}

export async function revokeSession(
  sessionId: string,
): Promise<boolean> {
  if (
    typeof sessionId !== "string" ||
    sessionId.trim().length === 0
  ) {
    return false;
  }

  const result = await prisma.session.updateMany({
    where: {
      id: sessionId,
      status: SessionStatus.ACTIVE,
    },
    data: {
      status: SessionStatus.REVOKED,
      revokedAt: new Date(),
    },
  });

  return result.count > 0;
}

export async function revokeAllUserSessions(
  userId: string,
): Promise<number> {
  if (
    typeof userId !== "string" ||
    userId.trim().length === 0
  ) {
    return 0;
  }

  const result = await prisma.session.updateMany({
    where: {
      userId,
      status: SessionStatus.ACTIVE,
    },
    data: {
      status: SessionStatus.REVOKED,
      revokedAt: new Date(),
    },
  });

  return result.count;
}
