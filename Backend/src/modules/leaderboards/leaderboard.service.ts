import { prisma } from "../../config/prisma.js";
import { AppError } from "../../errors/AppError.js";

/**
 * Leaderboards, computed from player progress so they are always
 * consistent with the game data and need no separate bookkeeping.
 *
 *  - Global board: total stars, then the lower user id wins a tie so
 *    the order is stable.
 *  - Level board: best score (stars first, then fewer moves), then the
 *    faster best time, then the lower user id.
 *
 * Only display names are returned, never ids or e-mail addresses. If a
 * player has not chosen a name, a short neutral name is shown.
 *
 * Finding a player's own rank reads every player at or above them. That
 * is fine at launch size. When the player base grows, keep the totals
 * in LeaderboardEntry and rank with an indexed count instead.
 */

export const DEFAULT_LEADERBOARD_LIMIT = 20;
export const MAX_LEADERBOARD_LIMIT = 100;

export type GlobalEntry = {
  rank: number;
  displayName: string;
  totalStars: number;
  completedLevels: number;
  isYou: boolean;
};

export type GlobalLeaderboard = {
  entries: GlobalEntry[];
  you: {
    rank: number;
    totalStars: number;
    completedLevels: number;
  } | null;
};

export type LevelEntry = {
  rank: number;
  displayName: string;
  stars: number;
  score: number;
  timeMs: number | null;
  isYou: boolean;
};

export type LevelLeaderboard = {
  levelNumber: number;
  entries: LevelEntry[];
  you: {
    rank: number;
    stars: number;
    score: number;
    timeMs: number | null;
  } | null;
};

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) {
    return DEFAULT_LEADERBOARD_LIMIT;
  }

  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_LEADERBOARD_LIMIT
  ) {
    throw new AppError(
      "INVALID_LIMIT",
      `The limit must be between 1 and ${MAX_LEADERBOARD_LIMIT}.`,
      400,
    );
  }

  return limit;
}

async function displayNames(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) {
    return new Map();
  }

  const users = await prisma.user.findMany({
    where: { id: { in: userIds } },
    select: {
      id: true,
      username: true,
      profile: { select: { displayName: true } },
    },
  });

  return new Map(
    users.map((user) => [
      user.id,
      user.profile?.displayName?.trim() ||
        user.username ||
        `Player ${user.id.slice(0, 6)}`,
    ]),
  );
}

export async function getGlobalLeaderboard(
  userId: string,
  limit?: number,
): Promise<GlobalLeaderboard> {
  const size = normalizeLimit(limit);

  const top = await prisma.playerProgress.groupBy({
    by: ["userId"],
    where: { completed: true },
    _sum: { stars: true },
    _count: { _all: true },
    orderBy: [{ _sum: { stars: "desc" } }, { userId: "asc" }],
    take: size,
  });

  const names = await displayNames(top.map((row) => row.userId));

  const entries = top.map(
    (row, index): GlobalEntry => ({
      rank: index + 1,
      displayName: names.get(row.userId) ?? "Player",
      totalStars: row._sum.stars ?? 0,
      completedLevels: row._count._all,
      isYou: row.userId === userId,
    }),
  );

  const mine = await prisma.playerProgress.aggregate({
    where: { userId, completed: true },
    _sum: { stars: true },
    _count: { _all: true },
  });

  if (mine._count._all === 0) {
    return { entries, you: null };
  }

  const myStars = mine._sum.stars ?? 0;

  const atOrAbove = await prisma.playerProgress.groupBy({
    by: ["userId"],
    where: { completed: true },
    _sum: { stars: true },
    having: { stars: { _sum: { gte: myStars } } },
  });

  const ahead = atOrAbove.filter((row) => {
    const stars = row._sum.stars ?? 0;

    return stars > myStars || (stars === myStars && row.userId < userId);
  }).length;

  return {
    entries,
    you: {
      rank: ahead + 1,
      totalStars: myStars,
      completedLevels: mine._count._all,
    },
  };
}

export async function getLevelLeaderboard(
  userId: string,
  levelNumber: number,
  limit?: number,
): Promise<LevelLeaderboard> {
  const size = normalizeLimit(limit);

  if (!Number.isSafeInteger(levelNumber) || levelNumber < 1) {
    throw new AppError(
      "INVALID_LEVEL",
      "The level number is not valid.",
      400,
    );
  }

  const level = await prisma.gameLevel.findUnique({
    where: { levelNumber },
    select: { id: true },
  });

  if (!level) {
    throw new AppError("LEVEL_NOT_FOUND", "Level not found.", 404);
  }

  const rows = await prisma.playerProgress.findMany({
    where: { levelId: level.id, completed: true },
    orderBy: [
      { bestScore: "desc" },
      { bestTimeMs: { sort: "asc", nulls: "last" } },
      { userId: "asc" },
    ],
    take: size,
    select: { userId: true, stars: true, bestScore: true, bestTimeMs: true },
  });

  const names = await displayNames(rows.map((row) => row.userId));

  const entries = rows.map(
    (row, index): LevelEntry => ({
      rank: index + 1,
      displayName: names.get(row.userId) ?? "Player",
      stars: row.stars,
      score: row.bestScore,
      timeMs: row.bestTimeMs,
      isYou: row.userId === userId,
    }),
  );

  const mine = await prisma.playerProgress.findUnique({
    where: { userId_levelId: { userId, levelId: level.id } },
    select: { completed: true, stars: true, bestScore: true, bestTimeMs: true },
  });

  if (!mine || !mine.completed) {
    return { levelNumber, entries, you: null };
  }

  const sameScoreAhead =
    mine.bestTimeMs === null
      ? {
          OR: [
            { bestTimeMs: { not: null } },
            { bestTimeMs: null, userId: { lt: userId } },
          ],
        }
      : {
          OR: [
            { bestTimeMs: { lt: mine.bestTimeMs } },
            { bestTimeMs: mine.bestTimeMs, userId: { lt: userId } },
          ],
        };

  const ahead = await prisma.playerProgress.count({
    where: {
      levelId: level.id,
      completed: true,
      OR: [
        { bestScore: { gt: mine.bestScore } },
        { bestScore: mine.bestScore, ...sameScoreAhead },
      ],
    },
  });

  return {
    levelNumber,
    entries,
    you: {
      rank: ahead + 1,
      stars: mine.stars,
      score: mine.bestScore,
      timeMs: mine.bestTimeMs,
    },
  };
}
