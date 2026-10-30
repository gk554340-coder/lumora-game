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
 *                                used by the daily reward streak
 */

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
];
