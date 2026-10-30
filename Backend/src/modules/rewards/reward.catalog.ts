/**
 * Reward catalog: the default reward definitions.
 *
 * Definitions live in the database (RewardDefinition) so amounts can be
 * tuned without a release. The first time a reward is used and no row
 * exists yet, the default below is stored. After that the database row
 * is the source of truth and changes made there take effect immediately.
 *
 * Configuration shapes:
 *  - { currencies: [...] }      a fixed reward
 *  - { cycle: [{ currencies }] } a reward that depends on the cycle day,
 *                                used by the daily reward streak and by
 *                                the level star reward (cycle day = star)
 *
 * Achievement rewards are added from the achievement catalog, one
 * definition per achievement, named "achievement.<code>".
 */

import {
  ACHIEVEMENTS,
  achievementRewardCode,
} from "../achievements/achievement.catalog.js";

export type RewardCurrency = "TOKEN" | "GEM";

export type RewardCurrencyAmount = {
  currency: RewardCurrency;
  amount: number;
};

export type RewardConfiguration =
  | { currencies: RewardCurrencyAmount[] }
  | { cycle: { currencies: RewardCurrencyAmount[] }[] };

export type RewardDefault = {
  code: string;
  name: string;
  description: string;
  configuration: RewardConfiguration;
};

export const DAILY_CYCLE_LENGTH = 7;

export const REWARD_CODES = {
  DAILY: "daily.reward",
  LEVEL_STAR: "level.star",
  LEVEL_MILESTONE_10: "level.milestone10",
  LEVEL_MILESTONE_50: "level.milestone50",
} as const;

export const REWARD_DEFAULTS: readonly RewardDefault[] = [
  {
    code: REWARD_CODES.DAILY,
    name: "Daily reward",
    description: "Seven day streak reward, claimed once per UTC day.",
    configuration: {
      cycle: [
        { currencies: [{ currency: "TOKEN", amount: 20 }] },
        { currencies: [{ currency: "TOKEN", amount: 25 }] },
        { currencies: [{ currency: "TOKEN", amount: 30 }] },
        { currencies: [{ currency: "TOKEN", amount: 35 }] },
        { currencies: [{ currency: "TOKEN", amount: 40 }] },
        { currencies: [{ currency: "TOKEN", amount: 50 }] },
        {
          currencies: [
            { currency: "TOKEN", amount: 100 },
            { currency: "GEM", amount: 5 },
          ],
        },
      ],
    },
  },
  {
    code: REWARD_CODES.LEVEL_STAR,
    name: "Level star",
    description:
      "Paid once per star of a level. The cycle day is the star number, so the first star pays 10 tokens and the second and third pay 5 each.",
    configuration: {
      cycle: [
        { currencies: [{ currency: "TOKEN", amount: 10 }] },
        { currencies: [{ currency: "TOKEN", amount: 5 }] },
        { currencies: [{ currency: "TOKEN", amount: 5 }] },
      ],
    },
  },
  {
    code: REWARD_CODES.LEVEL_MILESTONE_10,
    name: "Level milestone",
    description: "Paid once when a player first completes every 10th level.",
    configuration: {
      currencies: [{ currency: "TOKEN", amount: 50 }],
    },
  },
  {
    code: REWARD_CODES.LEVEL_MILESTONE_50,
    name: "Level major milestone",
    description: "Paid once when a player first completes every 50th level.",
    configuration: {
      currencies: [{ currency: "GEM", amount: 5 }],
    },
  },
  ...ACHIEVEMENTS.map(
    (entry): RewardDefault => ({
      code: achievementRewardCode(entry.code),
      name: `Achievement: ${entry.name}`,
      description: entry.description,
      configuration: { currencies: entry.reward },
    }),
  ),
];
