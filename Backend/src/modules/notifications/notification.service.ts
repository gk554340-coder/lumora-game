import { prisma } from "../../config/prisma.js";
import { AppError } from "../../errors/AppError.js";
import type { NotificationType } from "../../generated/prisma/client.js";

/**
 * In-app notifications (the player's inbox).
 *
 * Other modules create notifications with createNotification. Players
 * can only read their own, list them, and mark them as read. A
 * notification created with a dedupe key exists at most once per
 * player and key, so a retried job never sends the same message twice.
 */

export const DEFAULT_NOTIFICATION_LIMIT = 20;
export const MAX_NOTIFICATION_LIMIT = 50;

const MAX_TITLE_LENGTH = 200;
const MAX_MESSAGE_LENGTH = 1000;
const DEDUPE_KEY_PATTERN = /^[A-Za-z0-9:_.-]{1,100}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type JsonScalar = string | number | boolean | null;

export interface CreateNotificationInput {
  userId: string;
  type: NotificationType;
  title: string;
  message: string;
  data?: Record<string, JsonScalar>;
  dedupeKey?: string;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function shorten(text: string, max: number): string {
  const clean = text.trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

export async function createNotification(
  input: CreateNotificationInput,
): Promise<{ id: string; created: boolean }> {
  const title = shorten(input.title, MAX_TITLE_LENGTH);
  const message = shorten(input.message, MAX_MESSAGE_LENGTH);

  if (title.length === 0 || message.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "A notification needs a title and a message.",
      400,
    );
  }

  if (
    input.dedupeKey !== undefined &&
    !DEDUPE_KEY_PATTERN.test(input.dedupeKey)
  ) {
    throw new AppError("VALIDATION_ERROR", "Invalid dedupe key.", 400);
  }

  const data = {
    ...(input.data ?? {}),
    ...(input.dedupeKey !== undefined
      ? { dedupeKey: input.dedupeKey }
      : {}),
  };

  try {
    return await prisma.$transaction(async (tx) => {
      if (input.dedupeKey !== undefined) {
        // One creator at a time per player and key.
        const lockKey = `notification:${input.userId}:${input.dedupeKey}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}::text))`;

        const existing = await tx.notification.findFirst({
          where: {
            userId: input.userId,
            data: { path: ["dedupeKey"], equals: input.dedupeKey },
          },
          select: { id: true },
        });

        if (existing) {
          return { id: existing.id, created: false };
        }
      }

      const created = await tx.notification.create({
        data: {
          userId: input.userId,
          type: input.type,
          status: "SENT",
          title,
          message,
          data,
          sentAt: new Date(),
        },
        select: { id: true },
      });

      return { id: created.id, created: true };
    });
  } catch (error) {
    if (hasErrorCode(error, "P2003")) {
      throw new AppError("USER_NOT_FOUND", "User not found.", 404);
    }

    throw error;
  }
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ t: createdAt.toISOString(), id }),
  ).toString("base64url");
}

function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  try {
    const parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as { t?: unknown; id?: unknown };

    if (typeof parsed.t === "string" && typeof parsed.id === "string") {
      const createdAt = new Date(parsed.t);

      if (
        !Number.isNaN(createdAt.getTime()) &&
        UUID_PATTERN.test(parsed.id)
      ) {
        return { createdAt, id: parsed.id };
      }
    }
  } catch {
    // Falls through to the error below.
  }

  throw new AppError("INVALID_CURSOR", "Invalid cursor.", 400);
}

function publicData(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }

  const { dedupeKey: _hidden, ...rest } = value as Record<string, unknown>;
  return rest;
}

export async function listNotifications(
  userId: string,
  options: { limit?: number; cursor?: string; unreadOnly?: boolean } = {},
) {
  const limit = options.limit ?? DEFAULT_NOTIFICATION_LIMIT;

  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_NOTIFICATION_LIMIT
  ) {
    throw new AppError(
      "INVALID_LIMIT",
      `The limit must be between 1 and ${MAX_NOTIFICATION_LIMIT}.`,
      400,
    );
  }

  const cursor =
    options.cursor !== undefined ? decodeCursor(options.cursor) : null;

  const rows = await prisma.notification.findMany({
    where: {
      userId,
      status: options.unreadOnly ? "SENT" : { in: ["SENT", "READ"] },
      ...(cursor
        ? {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
  });

  const page = rows.slice(0, limit);
  const last = page[page.length - 1];

  return {
    items: page.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      message: row.message,
      data: publicData(row.data),
      read: row.status === "READ",
      createdAt: row.createdAt,
    })),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor(last.createdAt, last.id)
        : null,
  };
}

export async function getUnreadCount(userId: string): Promise<number> {
  return prisma.notification.count({
    where: { userId, status: "SENT" },
  });
}

export async function markNotificationRead(userId: string, id: string) {
  if (!UUID_PATTERN.test(id)) {
    throw new AppError("NOTIFICATION_NOT_FOUND", "Notification not found.", 404);
  }

  const updated = await prisma.notification.updateMany({
    where: { id, userId, status: "SENT" },
    data: { status: "READ", readAt: new Date() },
  });

  if (updated.count === 0) {
    // Either already read (fine) or not this player's (not found).
    const existing = await prisma.notification.findFirst({
      where: { id, userId, status: "READ" },
      select: { id: true },
    });

    if (!existing) {
      throw new AppError(
        "NOTIFICATION_NOT_FOUND",
        "Notification not found.",
        404,
      );
    }
  }

  return { id, read: true };
}

export async function markAllNotificationsRead(userId: string) {
  const updated = await prisma.notification.updateMany({
    where: { userId, status: "SENT" },
    data: { status: "READ", readAt: new Date() },
  });

  return { updated: updated.count };
}

/**
 * Deletes read notifications older than the given number of days.
 * Meant for a periodic clean-up job so the table stays small.
 */
export async function purgeReadNotifications(
  olderThanDays: number,
  now: Date = new Date(),
): Promise<number> {
  if (!Number.isInteger(olderThanDays) || olderThanDays < 1) {
    throw new AppError(
      "VALIDATION_ERROR",
      "olderThanDays must be a positive integer.",
      400,
    );
  }

  const cutoff = new Date(now.getTime() - olderThanDays * 86_400_000);

  const deleted = await prisma.notification.deleteMany({
    where: { status: "READ", readAt: { lt: cutoff } },
  });

  return deleted.count;
}
