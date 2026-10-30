import { prisma } from "../../config/prisma.js";
import { AppError } from "../../errors/AppError.js";
import {
  REWARD_CODES,
  type RewardCurrency,
  type RewardCurrencyAmount,
} from "../rewards/reward.catalog.js";
import { grantReward } from "../rewards/reward.service.js";
import {
  MAX_MOVES,
  generateLevel,
  parseLevelConfiguration,
  verifySolution,
  type LevelConfiguration,
  type Tile,
  type VerifyFailure,
} from "./lumen-engine.js";

/**
 * Level service: starting levels and judging submissions.
 *
 * Rules
 *  - Levels are generated on first use and stored, so a level never
 *    changes after players have seen it.
 *  - A player can open any level up to one past the highest level they
 *    have completed. Earlier levels can be replayed to earn more stars.
 *  - The client sends only its list of moves. The server replays them on
 *    the stored level and decides the result, the stars and the time
 *    (measured from the moment the attempt started).
 *  - Rewards are paid per star and per milestone through the reward
 *    service, keyed by level and star, so each is paid once per player
 *    however often a level is replayed or a request is repeated.
 *  - The stored solution is never sent to the client.
 */

export const MAX_LEVEL_NUMBER = 1_000_000;
export const MAX_ATTEMPT_AGE_MS = 24 * 3_600_000;

const MAX_TRANSACTION_TRIES = 3;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PublicLevel = {
  levelNumber: number;
  tier: number;
  width: number;
  height: number;
  tiles: Tile[];
  parMoves: number;
};

export type StartLevelResult = {
  attemptId: string;
  startedAt: string;
  bestStars: number;
  level: PublicLevel;
};

export type SubmitAttemptResult = {
  levelNumber: number;
  moves: number;
  parMoves: number;
  stars: number;
  score: number;
  timeMs: number;
  newBestStars: boolean;
  rewards: RewardCurrencyAmount[];
  nextLevel: number;
};

export type LevelProgressSummary = {
  nextLevel: number;
  completedLevels: number;
  totalStars: number;
};

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function assertLevelNumber(levelNumber: number): void {
  if (
    !Number.isSafeInteger(levelNumber) ||
    levelNumber < 1 ||
    levelNumber > MAX_LEVEL_NUMBER
  ) {
    throw new AppError(
      "INVALID_LEVEL",
      "The level number is not valid.",
      400,
    );
  }
}

function readConfiguration(stored: unknown): LevelConfiguration {
  const configuration = parseLevelConfiguration(stored);

  if (!configuration) {
    throw new AppError(
      "LEVEL_CORRUPT",
      "The level data is not valid.",
      500,
    );
  }

  return configuration;
}

/**
 * Score is derived from the verified result only. Stars dominate and
 * fewer moves break ties.
 */
function scoreFor(stars: number, moves: number): number {
  return stars * 1000 + Math.max(0, 100 - moves);
}

function rejectionFor(reason: VerifyFailure): AppError {
  switch (reason) {
    case "TOO_FAST":
      return new AppError(
        "SUBMISSION_TOO_FAST",
        "The solution arrived faster than the level can be played.",
        422,
      );
    case "NOT_SOLVED":
      return new AppError(
        "LEVEL_NOT_SOLVED",
        "These moves do not solve the level.",
        422,
      );
    default:
      return new AppError(
        "MOVES_INVALID",
        "The list of moves is not valid.",
        400,
      );
  }
}

/**
 * The first level a player cannot open yet: one past the highest level
 * they have completed.
 */
async function getNextLevel(userId: string): Promise<number> {
  const top = await prisma.playerProgress.findFirst({
    where: { userId, completed: true },
    orderBy: { level: { levelNumber: "desc" } },
    select: { level: { select: { levelNumber: true } } },
  });

  return (top?.level.levelNumber ?? 0) + 1;
}

/**
 * Returns the stored level, generating and storing it on first use.
 */
export async function getOrCreateLevel(levelNumber: number) {
  assertLevelNumber(levelNumber);

  const existing = await prisma.gameLevel.findUnique({
    where: { levelNumber },
  });

  if (existing) {
    return existing;
  }

  const generated = generateLevel(levelNumber);

  try {
    return await prisma.gameLevel.create({
      data: {
        levelNumber,
        status: "ACTIVE",
        type: "GENERATED",
        difficultyTier: generated.tier,
        difficultyScore: generated.difficultyScore,
        generationSeed: generated.seed,
        configuration: JSON.parse(JSON.stringify(generated.configuration)),
        publishedAt: new Date(),
      },
    });
  } catch (error) {
    // Another request stored the same level first.
    if (hasErrorCode(error, "P2002")) {
      return prisma.gameLevel.findUniqueOrThrow({ where: { levelNumber } });
    }

    throw error;
  }
}

export async function startLevel(
  userId: string,
  levelNumber: number,
  now: Date = new Date(),
): Promise<StartLevelResult> {
  assertLevelNumber(levelNumber);

  const nextLevel = await getNextLevel(userId);

  if (levelNumber > nextLevel) {
    throw new AppError(
      "LEVEL_LOCKED",
      "Complete the earlier levels first.",
      403,
    );
  }

  const level = await getOrCreateLevel(levelNumber);

  if (level.status !== "ACTIVE") {
    throw new AppError("LEVEL_NOT_FOUND", "Level not found.", 404);
  }

  const configuration = readConfiguration(level.configuration);

  const attempt = await prisma.$transaction(async (tx) => {
    // A player has one open attempt per level. Starting again closes
    // the earlier one.
    await tx.levelAttempt.updateMany({
      where: { userId, levelId: level.id, status: "STARTED" },
      data: { status: "ABANDONED" },
    });

    const previousAttempts = await tx.levelAttempt.count({
      where: { userId, levelId: level.id },
    });

    return tx.levelAttempt.create({
      data: {
        userId,
        levelId: level.id,
        attemptNumber: previousAttempts + 1,
        startedAt: now,
      },
      select: { id: true, startedAt: true },
    });
  });

  const progress = await prisma.playerProgress.findUnique({
    where: { userId_levelId: { userId, levelId: level.id } },
    select: { stars: true },
  });

  return {
    attemptId: attempt.id,
    startedAt: attempt.startedAt.toISOString(),
    bestStars: progress?.stars ?? 0,
    level: {
      levelNumber: level.levelNumber,
      tier: level.difficultyTier,
      width: configuration.width,
      height: configuration.height,
      tiles: configuration.tiles,
      parMoves: configuration.parMoves,
    },
  };
}

async function grantLevelRewards(
  userId: string,
  levelNumber: number,
  stars: number,
): Promise<RewardCurrencyAmount[]> {
  const granted: RewardCurrencyAmount[] = [];

  const collect = (
    result: { alreadyGranted: boolean; rewards: RewardCurrencyAmount[] },
  ): void => {
    if (!result.alreadyGranted) {
      granted.push(...result.rewards);
    }
  };

  for (let star = 1; star <= stars; star += 1) {
    collect(
      await grantReward({
        userId,
        rewardCode: REWARD_CODES.LEVEL_STAR,
        sourceId: `level:${levelNumber}:star:${star}`,
        sourceType: "GAMEPLAY",
        cycleDay: star,
      }),
    );
  }

  if (levelNumber % 10 === 0) {
    collect(
      await grantReward({
        userId,
        rewardCode: REWARD_CODES.LEVEL_MILESTONE_10,
        sourceId: `level:${levelNumber}`,
        sourceType: "GAMEPLAY",
      }),
    );
  }

  if (levelNumber % 50 === 0) {
    collect(
      await grantReward({
        userId,
        rewardCode: REWARD_CODES.LEVEL_MILESTONE_50,
        sourceId: `level:${levelNumber}`,
        sourceType: "GAMEPLAY",
      }),
    );
  }

  const totals = new Map<RewardCurrency, number>();

  for (const entry of granted) {
    totals.set(entry.currency, (totals.get(entry.currency) ?? 0) + entry.amount);
  }

  return [...totals].map(([currency, amount]) => ({ currency, amount }));
}

type CompletionInput = {
  userId: string;
  attemptId: string;
  levelId: string;
  stars: number;
  moves: number;
  score: number;
  timeMs: number;
  now: Date;
};

async function completeAttempt(input: CompletionInput): Promise<number> {
  for (let attemptNumber = 1; ; attemptNumber += 1) {
    try {
      return await prisma.$transaction(async (tx) => {
        // Only one request can move the attempt out of STARTED.
        const closed = await tx.levelAttempt.updateMany({
          where: { id: input.attemptId, status: "STARTED" },
          data: {
            status: "COMPLETED",
            score: input.score,
            timeMs: input.timeMs,
            moves: input.moves,
            completedAt: input.now,
          },
        });

        if (closed.count !== 1) {
          throw new AppError(
            "ATTEMPT_CLOSED",
            "This attempt is already finished.",
            409,
          );
        }

        const key = {
          userId_levelId: { userId: input.userId, levelId: input.levelId },
        };
        const previous = await tx.playerProgress.findUnique({ where: key });
        const attemptsCount = await tx.levelAttempt.count({
          where: { userId: input.userId, levelId: input.levelId },
        });

        await tx.playerProgress.upsert({
          where: key,
          create: {
            userId: input.userId,
            levelId: input.levelId,
            completed: true,
            bestScore: input.score,
            bestTimeMs: input.timeMs,
            attemptsCount,
            stars: input.stars,
            firstCompletedAt: input.now,
            lastPlayedAt: input.now,
          },
          update: {
            completed: true,
            bestScore: Math.max(previous?.bestScore ?? 0, input.score),
            bestTimeMs:
              previous?.bestTimeMs == null
                ? input.timeMs
                : Math.min(previous.bestTimeMs, input.timeMs),
            attemptsCount,
            stars: Math.max(previous?.stars ?? 0, input.stars),
            firstCompletedAt: previous?.firstCompletedAt ?? input.now,
            lastPlayedAt: input.now,
          },
        });

        return previous?.stars ?? 0;
      });
    } catch (error) {
      if (
        hasErrorCode(error, "P2002") &&
        attemptNumber < MAX_TRANSACTION_TRIES
      ) {
        continue;
      }

      throw error;
    }
  }
}

export async function submitAttempt(
  userId: string,
  attemptId: string,
  moves: readonly number[],
  now: Date = new Date(),
): Promise<SubmitAttemptResult> {
  if (!UUID_PATTERN.test(attemptId)) {
    throw new AppError("ATTEMPT_NOT_FOUND", "Attempt not found.", 404);
  }

  if (
    !Array.isArray(moves) ||
    moves.length === 0 ||
    moves.length > MAX_MOVES ||
    !moves.every((move) => Number.isSafeInteger(move))
  ) {
    throw rejectionFor("INVALID_MOVE");
  }

  const attempt = await prisma.levelAttempt.findFirst({
    where: { id: attemptId, userId },
    include: { level: true },
  });

  if (!attempt) {
    throw new AppError("ATTEMPT_NOT_FOUND", "Attempt not found.", 404);
  }

  if (attempt.status !== "STARTED") {
    throw new AppError(
      "ATTEMPT_CLOSED",
      "This attempt is already finished.",
      409,
    );
  }

  const timeMs = now.getTime() - attempt.startedAt.getTime();

  if (timeMs > MAX_ATTEMPT_AGE_MS) {
    throw new AppError(
      "ATTEMPT_EXPIRED",
      "This attempt has expired. Start the level again.",
      409,
    );
  }

  const configuration = readConfiguration(attempt.level.configuration);
  const verdict = verifySolution(configuration, moves, timeMs);

  if (!verdict.ok) {
    throw rejectionFor(verdict.reason);
  }

  const levelNumber = attempt.level.levelNumber;
  const score = scoreFor(verdict.stars, verdict.moves);

  // Rewards are paid before the attempt is closed. They are idempotent,
  // so if this request stops half way, submitting the same attempt
  // again finishes the job without paying twice.
  const rewards = await grantLevelRewards(userId, levelNumber, verdict.stars);

  const previousStars = await completeAttempt({
    userId,
    attemptId: attempt.id,
    levelId: attempt.levelId,
    stars: verdict.stars,
    moves: verdict.moves,
    score,
    timeMs,
    now,
  });

  return {
    levelNumber,
    moves: verdict.moves,
    parMoves: verdict.parMoves,
    stars: verdict.stars,
    score,
    timeMs,
    newBestStars: verdict.stars > previousStars,
    rewards,
    nextLevel: await getNextLevel(userId),
  };
}

export async function getLevelProgress(
  userId: string,
): Promise<LevelProgressSummary> {
  const [nextLevel, totals] = await Promise.all([
    getNextLevel(userId),
    prisma.playerProgress.aggregate({
      where: { userId, completed: true },
      _count: { _all: true },
      _sum: { stars: true },
    }),
  ]);

  return {
    nextLevel,
    completedLevels: totals._count._all,
    totalStars: totals._sum.stars ?? 0,
  };
}
