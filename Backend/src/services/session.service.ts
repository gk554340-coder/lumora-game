import { createHash, randomBytes } from "node:crypto";

import {
  Prisma,
  SessionStatus,
} from "../generated/prisma/client";
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

function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function createSessionExpiry(
  now: Date,
  ttlSeconds: number,
): Date {
  return new Date(now.getTime() + ttlSeconds * 1000);
}

function validateConfiguration(
  config: SessionServiceConfig,
): void {
  if (!Number.isInteger(config.tokenBytes) || config.tokenBytes <= 0) {
    throw new Error("Invalid session token byte configuration.");
  }

  if (!Number.isInteger(config.ttlSeconds) || config.ttlSeconds <= 0) {
    throw new Error("Invalid session TTL configuration.");
  }

  if (
    !Number.isInteger(config.maxTokenLength) ||
    config.maxTokenLength <= 0
  ) {
    throw new Error("Invalid session token length configuration.");
  }

  if (
    !Number.isInteger(config.lastUsedUpdateIntervalSeconds) ||
    config.lastUsedUpdateIntervalSeconds < 0
  ) {
    throw new Error(
      "Invalid session last-used update interval configuration.",
    );
  }
}

function validateToken(
  token: string,
  config: SessionServiceConfig,
): string {
  if (typeof token !== "string") {
    throw new Error("Invalid session token.");
  }

  const normalizedToken = token.trim();

  if (
    normalizedToken.length === 0 ||
    normalizedToken.length > config.maxTokenLength
  ) {
    throw new Error("Invalid session token.");
  }

  return normalizedToken;
}

export async function createSession(
  userId: string,
  config: SessionServiceConfig,
): Promise<CreatedSession> {
  validateConfiguration(config);

  if (!userId) {
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

export async function validateSession(
  token: string,
  config: SessionServiceConfig,
): Promise<ValidatedSession | null> {
  validateConfiguration(config);

  const normalizedToken = validateToken(token, config);
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
    },
  });

  if (!session) {
    return null;
  }

  if (session.status !== SessionStatus.ACTIVE) {
    return null;
  }

  if (session.expiresAt <= now) {
    await prisma.session.updateMany({
      where: {
        id: session.id,
        status: SessionStatus.ACTIVE,
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
    await prisma.session.updateMany({
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
  if (!sessionId) {
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
  if (!userId) {
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
