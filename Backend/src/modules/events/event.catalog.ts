import type { RewardDefault } from "../rewards/reward.catalog.js";

/**
 * Weekly event: "Weekly Light Rush".
 *
 * A new event runs every week from Monday 00:00 UTC to the next
 * Monday 00:00 UTC. The score is built only from verified play: for
 * every level a player completed for the FIRST time during the week,
 * the best score of their attempts counts. Replaying old levels adds
 * nothing, so new and old players compete on progress made this week.
 *
 * When the week ends, every player with a score gets one reward based
 * on final rank. Amounts live in the database as reward definitions
 * and can be tuned there; the values below are the defaults.
 */

export const WEEKLY_EVENT_NAME = "Weekly Light Rush";
export const WEEKLY_EVENT_KIND = "weekly_rush";

export const EVENT_REWARD_CODES = {
  RANK_1: "event.rank1",
  TOP_3: "event.top3",
  TOP_10: "event.top10",
  TOP_100: "event.top100",
  PARTICIPANT: "event.participant",
} as const;

export interface EventRewardTier {
  code: string;
  fromRank: number;
  /** null means "and everyone below". */
  toRank: number | null;
}

export const EVENT_REWARD_TIERS: readonly EventRewardTier[] = [
  { code: EVENT_REWARD_CODES.RANK_1, fromRank: 1, toRank: 1 },
  { code: EVENT_REWARD_CODES.TOP_3, fromRank: 2, toRank: 3 },
  { code: EVENT_REWARD_CODES.TOP_10, fromRank: 4, toRank: 10 },
  { code: EVENT_REWARD_CODES.TOP_100, fromRank: 11, toRank: 100 },
  { code: EVENT_REWARD_CODES.PARTICIPANT, fromRank: 101, toRank: null },
];

export const EVENT_REWARD_DEFAULTS: readonly RewardDefault[] = [
  {
    code: EVENT_REWARD_CODES.RANK_1,
    name: "Weekly event: first place",
    description: "Paid once to the player in first place.",
    configuration: {
      currencies: [
        { currency: "GEM", amount: 50 },
        { currency: "TOKEN", amount: 300 },
      ],
    },
  },
  {
    code: EVENT_REWARD_CODES.TOP_3,
    name: "Weekly event: top 3",
    description: "Paid once to the players in second and third place.",
    configuration: {
      currencies: [
        { currency: "GEM", amount: 30 },
        { currency: "TOKEN", amount: 200 },
      ],
    },
  },
  {
    code: EVENT_REWARD_CODES.TOP_10,
    name: "Weekly event: top 10",
    description: "Paid once to the players from fourth to tenth place.",
    configuration: {
      currencies: [
        { currency: "GEM", amount: 15 },
        { currency: "TOKEN", amount: 150 },
      ],
    },
  },
  {
    code: EVENT_REWARD_CODES.TOP_100,
    name: "Weekly event: top 100",
    description: "Paid once to the players from 11th to 100th place.",
    configuration: {
      currencies: [
        { currency: "GEM", amount: 5 },
        { currency: "TOKEN", amount: 100 },
      ],
    },
  },
  {
    code: EVENT_REWARD_CODES.PARTICIPANT,
    name: "Weekly event: participant",
    description: "Paid once to every other player who scored.",
    configuration: {
      currencies: [{ currency: "TOKEN", amount: 50 }],
    },
  },
];

export function rewardCodeForRank(rank: number): string {
  for (const tier of EVENT_REWARD_TIERS) {
    if (
      rank >= tier.fromRank &&
      (tier.toRank === null || rank <= tier.toRank)
    ) {
      return tier.code;
    }
  }

  return EVENT_REWARD_CODES.PARTICIPANT;
}

const DAY_MS = 86_400_000;

/** The Monday-to-Monday week (UTC) that contains the given moment. */
export function weeklyWindow(now: Date): {
  start: Date;
  end: Date;
  key: string;
} {
  const midnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const sinceMonday = (new Date(midnight).getUTCDay() + 6) % 7;
  const start = new Date(midnight - sinceMonday * DAY_MS);
  const end = new Date(start.getTime() + 7 * DAY_MS);

  return {
    start,
    end,
    key: `weekly:${start.toISOString().slice(0, 10)}`,
  };
}
