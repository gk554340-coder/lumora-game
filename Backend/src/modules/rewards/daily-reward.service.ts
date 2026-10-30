import { prisma } from "../../config/prisma.js";
import { AppError } from "../../errors/AppError.js";
import {
  DAILY_CYCLE_LENGTH,
  REWARD_CODES,
  type RewardCurrencyAmount,
} from "./reward.catalog.js";
import {
  getRewardDefinition,
  grantReward,
  resolveRewardCurrencies,
} from "./reward.service.js";

/**
 * Daily reward with a seven day streak.
 *
 * Rules:
 *  - The day boundary is UTC.
 *  - A claim on the day after the last claim continues the streak. A
 *    longer gap restarts it at day 1. After day 7 the cycle restarts.
 *  - One claim per day. Two things enforce it: the profile is advanced
 *    with a conditional update (only one request can win), and the
 *    reward grant is unique per (user, reward, date).
 *  - If a claim is interrupted after the profile was advanced, the next
 *    call for the same day completes the pending reward.
 */

export type DailyRewardStatus = {
  claimedToday: boolean;
  canClaim: boolean;
  streak: number;
  nextCycleDay: number;
  rewards: RewardCurrencyAmount[];
  resetsAt: string;
};

export type DailyClaimResult = {
  claimed: boolean;
  streak: number;
  cycleDay: number;
  rewards: RewardCurrencyAmount[];
  resetsAt: string;
};

type ProfileState = {
  dailyStreak: number;
  lastDailyClaimOn: Date | null;
};

const DAY_MS = 86_400_000;
const MAX_CLAIM_ATTEMPTS = 3;

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function utcDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function utcMidnight(dateString: string): Date {
  return new Date(`${dateString}T00:00:00.000Z`);
}

function cycleDayFor(streak: number): number {
  return ((streak - 1) % DAILY_CYCLE_LENGTH) + 1;
}

function describeDay(profile: ProfileState, now: Date) {
  const today = utcDateString(now);
  const yesterday = utcDateString(new Date(now.getTime() - DAY_MS));
  const last = profile.lastDailyClaimOn
    ? utcDateString(profile.lastDailyClaimOn)
    : null;

  const claimedToday = last === today;
  const streakAlive = claimedToday || last === yesterday;

  return {
    today,
    claimedToday,
    streak: streakAlive ? profile.dailyStreak : 0,
    resetsAt: new Date(utcMidnight(today).getTime() + DAY_MS).toISOString(),
  };
}

async function loadProfile(userId: string): Promise<ProfileState> {
  const select = { dailyStreak: true, lastDailyClaimOn: true };

  const existing = await prisma.playerProfile.findUnique({
    where: { userId },
    select,
  });

  if (existing) {
    return existing;
  }

  try {
    return await prisma.playerProfile.create({
      data: { userId },
      select,
    });
  } catch (error) {
    if (hasErrorCode(error, "P2003")) {
      throw new AppError("USER_NOT_FOUND", "User not found.", 404);
    }

    if (hasErrorCode(error, "P2002")) {
      return prisma.playerProfile.findUniqueOrThrow({
        where: { userId },
        select,
      });
    }

    throw error;
  }
}

export async function getDailyRewardStatus(
  userId: string,
  now: Date = new Date(),
): Promise<DailyRewardStatus> {
  const profile = await loadProfile(userId);
  const day = describeDay(profile, now);
  const nextCycleDay = cycleDayFor(day.streak + 1);

  const definition = await getRewardDefinition(REWARD_CODES.DAILY);
  const rewards = resolveRewardCurrencies(
    definition.configuration,
    nextCycleDay,
  );

  return {
    claimedToday: day.claimedToday,
    canClaim: !day.claimedToday,
    streak: day.streak,
    nextCycleDay,
    rewards,
    resetsAt: day.resetsAt,
  };
}

export async function claimDailyReward(
  userId: string,
  now: Date = new Date(),
): Promise<DailyClaimResult> {
  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt += 1) {
    const profile = await loadProfile(userId);
    const day = describeDay(profile, now);

    if (day.claimedToday) {
      // Already claimed today. Finish the reward if an earlier claim was
      // interrupted; otherwise this only reports what was paid.
      const cycleDay = cycleDayFor(profile.dailyStreak);
      const granted = await grantReward({
        userId,
        rewardCode: REWARD_CODES.DAILY,
        sourceId: day.today,
        sourceType: "BONUS",
        cycleDay,
      });

      return {
        claimed: false,
        streak: profile.dailyStreak,
        cycleDay,
        rewards: granted.rewards,
        resetsAt: day.resetsAt,
      };
    }

    const newStreak = day.streak + 1;
    const cycleDay = cycleDayFor(newStreak);

    // Only one request can move the profile from this exact state.
    const advanced = await prisma.playerProfile.updateMany({
      where: {
        userId,
        dailyStreak: profile.dailyStreak,
        lastDailyClaimOn: profile.lastDailyClaimOn,
      },
      data: {
        dailyStreak: newStreak,
        lastDailyClaimOn: utcMidnight(day.today),
      },
    });

    if (advanced.count === 0) {
      // Another request changed the profile first. Look again.
      continue;
    }

    const granted = await grantReward({
      userId,
      rewardCode: REWARD_CODES.DAILY,
      sourceId: day.today,
      sourceType: "BONUS",
      cycleDay,
    });

    return {
      claimed: true,
      streak: newStreak,
      cycleDay,
      rewards: granted.rewards,
      resetsAt: day.resetsAt,
    };
  }

  throw new AppError(
    "DAILY_CLAIM_CONFLICT",
    "The daily reward could not be claimed. Please try again.",
    409,
  );
}
