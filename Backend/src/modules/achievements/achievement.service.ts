import { prisma } from "../../config/prisma.js";
import {
  getRewardDefinition,
  grantReward,
  resolveRewardCurrencies,
} from "../rewards/reward.service.js";
import type { RewardCurrencyAmount } from "../rewards/reward.catalog.js";
import {
  ACHIEVEMENTS,
  ACHIEVEMENT_METRICS,
  achievementRewardCode,
  type AchievementMetric,
} from "./achievement.catalog.js";

/**
 * Achievements.
 *
 * Progress is worked out from data the server already trusts (verified
 * level results and the daily streak), never from anything the client
 * reports.
 *
 * Completing an achievement pays its reward once:
 *  1. the reward is granted (idempotent, keyed by the achievement),
 *  2. then the achievement is marked COMPLETED with a conditional write
 *     that only one request can win.
 * If a request stops between the two steps, the next check repeats
 * step 1 harmlessly and finishes step 2.
 *
 * Checking is safe to repeat and safe to run in parallel.
 */

export type AchievementStatusName = "LOCKED" | "IN_PROGRESS" | "COMPLETED";

export type CompletedAchievement = {
  code: string;
  name: string;
  rewards: RewardCurrencyAmount[];
};

export type AchievementView = {
  code: string;
  name: string;
  description: string | null;
  status: AchievementStatusName;
  progress: number;
  target: number;
  reward: RewardCurrencyAmount[];
};

type Metrics = Record<AchievementMetric, number>;

type Evaluated = {
  code: string;
  name: string;
  description: string | null;
  target: number;
  progress: number;
  completed: boolean;
  newlyCompleted: CompletedAchievement | null;
};

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function parseConfiguration(
  value: unknown,
): { metric: AchievementMetric; target: number } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const { metric, target } = value as Record<string, unknown>;

  if (
    typeof metric !== "string" ||
    !ACHIEVEMENT_METRICS.includes(metric as AchievementMetric) ||
    typeof target !== "number" ||
    !Number.isSafeInteger(target) ||
    target < 1
  ) {
    return null;
  }

  return { metric: metric as AchievementMetric, target };
}

async function ensureDefinitions(): Promise<void> {
  const existing = await prisma.achievement.findMany({
    select: { code: true },
  });
  const known = new Set(existing.map((row) => row.code));
  const missing = ACHIEVEMENTS.filter((entry) => !known.has(entry.code));

  if (missing.length === 0) {
    return;
  }

  await prisma.achievement.createMany({
    data: missing.map((entry) => ({
      code: entry.code,
      name: entry.name,
      description: entry.description,
      configuration: { metric: entry.metric, target: entry.target },
    })),
    skipDuplicates: true,
  });
}

async function readMetrics(userId: string): Promise<Metrics> {
  const [completed, perfect, profile] = await Promise.all([
    prisma.playerProgress.aggregate({
      where: { userId, completed: true },
      _count: { _all: true },
      _sum: { stars: true },
    }),
    prisma.playerProgress.count({
      where: { userId, completed: true, stars: 3 },
    }),
    prisma.playerProfile.findUnique({
      where: { userId },
      select: { dailyStreak: true },
    }),
  ]);

  return {
    COMPLETED_LEVELS: completed._count._all,
    TOTAL_STARS: completed._sum.stars ?? 0,
    THREE_STAR_LEVELS: perfect,
    DAILY_STREAK: profile?.dailyStreak ?? 0,
  };
}

/**
 * Marks the achievement completed. Returns true only for the request
 * that actually changed it.
 */
async function markCompleted(
  userId: string,
  achievementId: string,
  target: number,
  now: Date,
): Promise<boolean> {
  try {
    await prisma.playerAchievement.create({
      data: {
        userId,
        achievementId,
        status: "COMPLETED",
        progressValue: target,
        completedAt: now,
      },
    });

    return true;
  } catch (error) {
    if (!hasErrorCode(error, "P2002")) {
      throw error;
    }

    const updated = await prisma.playerAchievement.updateMany({
      where: { userId, achievementId, status: { not: "COMPLETED" } },
      data: {
        status: "COMPLETED",
        progressValue: target,
        completedAt: now,
      },
    });

    return updated.count === 1;
  }
}

/**
 * Stores progress. The value only ever goes up, and a completed
 * achievement is never touched.
 */
async function saveProgress(
  userId: string,
  achievementId: string,
  progress: number,
  hasRow: boolean,
): Promise<void> {
  if (progress < 1) {
    return;
  }

  if (!hasRow) {
    try {
      await prisma.playerAchievement.create({
        data: {
          userId,
          achievementId,
          status: "IN_PROGRESS",
          progressValue: progress,
        },
      });

      return;
    } catch (error) {
      if (!hasErrorCode(error, "P2002")) {
        throw error;
      }
    }
  }

  await prisma.playerAchievement.updateMany({
    where: {
      userId,
      achievementId,
      status: { not: "COMPLETED" },
      progressValue: { lt: progress },
    },
    data: { status: "IN_PROGRESS", progressValue: progress },
  });
}

async function evaluate(userId: string): Promise<Evaluated[]> {
  await ensureDefinitions();

  const order = new Map(
    ACHIEVEMENTS.map((entry, index) => [entry.code, index]),
  );

  const rows = (
    await prisma.achievement.findMany({
      where: { isActive: true, code: { in: [...order.keys()] } },
    })
  ).sort((a, b) => (order.get(a.code) ?? 0) - (order.get(b.code) ?? 0));

  const [metrics, stored] = await Promise.all([
    readMetrics(userId),
    prisma.playerAchievement.findMany({ where: { userId } }),
  ]);

  const storedBy = new Map(stored.map((row) => [row.achievementId, row]));
  const now = new Date();
  const results: Evaluated[] = [];

  for (const row of rows) {
    const config = parseConfiguration(row.configuration);

    if (!config) {
      continue;
    }

    const base = {
      code: row.code,
      name: row.name,
      description: row.description,
      target: config.target,
    };
    const existing = storedBy.get(row.id);

    if (existing?.status === "COMPLETED") {
      results.push({
        ...base,
        progress: config.target,
        completed: true,
        newlyCompleted: null,
      });
      continue;
    }

    const value = metrics[config.metric];

    if (value >= config.target) {
      const grant = await grantReward({
        userId,
        rewardCode: achievementRewardCode(row.code),
        sourceId: `achievement:${row.code}`,
        sourceType: "ACHIEVEMENT",
      });

      const changed = await markCompleted(userId, row.id, config.target, now);

      results.push({
        ...base,
        progress: config.target,
        completed: true,
        newlyCompleted: changed
          ? { code: row.code, name: row.name, rewards: grant.rewards }
          : null,
      });
      continue;
    }

    const progress = Math.max(existing?.progressValue ?? 0, value);

    await saveProgress(userId, row.id, progress, existing !== undefined);

    results.push({
      ...base,
      progress,
      completed: false,
      newlyCompleted: null,
    });
  }

  return results;
}

function collectNewlyCompleted(results: Evaluated[]): CompletedAchievement[] {
  return results.flatMap((entry) =>
    entry.newlyCompleted ? [entry.newlyCompleted] : [],
  );
}

/**
 * Completes every achievement whose goal has been reached and pays the
 * rewards. Returns only the ones completed by this call.
 */
export async function checkAchievements(
  userId: string,
): Promise<CompletedAchievement[]> {
  return collectNewlyCompleted(await evaluate(userId));
}

/**
 * Same as checkAchievements, for use right after another action such as
 * submitting a level. A failure here must never undo or fail that
 * action, so it is reported through onError and an empty list returned.
 * The next check completes anything that was missed.
 */
export async function checkAchievementsSafely(
  userId: string,
  onError: (error: unknown) => void,
): Promise<CompletedAchievement[]> {
  try {
    return await checkAchievements(userId);
  } catch (error) {
    onError(error);

    return [];
  }
}

/**
 * The player's achievements with progress and rewards. It also
 * completes any achievement whose goal has been reached, so the list is
 * never behind the game data.
 */
export async function listAchievements(userId: string): Promise<{
  achievements: AchievementView[];
  newlyCompleted: CompletedAchievement[];
}> {
  const results = await evaluate(userId);

  const achievements = await Promise.all(
    results.map(async (entry): Promise<AchievementView> => {
      const definition = await getRewardDefinition(
        achievementRewardCode(entry.code),
      );

      return {
        code: entry.code,
        name: entry.name,
        description: entry.description,
        status: entry.completed
          ? "COMPLETED"
          : entry.progress > 0
            ? "IN_PROGRESS"
            : "LOCKED",
        progress: entry.progress,
        target: entry.target,
        reward: resolveRewardCurrencies(definition.configuration),
      };
    }),
  );

  return { achievements, newlyCompleted: collectNewlyCompleted(results) };
}
