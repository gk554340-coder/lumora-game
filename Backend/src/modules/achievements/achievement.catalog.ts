/**
 * Achievement catalog: the default achievements.
 *
 * Each achievement watches one metric that the server already knows
 * from verified play, and completes when the metric reaches the target.
 * The reward is stored as a reward definition named
 * "achievement.<code>", so amounts can be tuned in the database.
 *
 * Metrics
 *  - COMPLETED_LEVELS   levels completed at least once
 *  - TOTAL_STARS        stars summed over all levels
 *  - THREE_STAR_LEVELS  levels completed with three stars
 *  - DAILY_STREAK       the daily reward streak (the best value reached
 *                       is remembered even if the streak later restarts)
 */

import type { RewardCurrencyAmount } from "../rewards/reward.catalog.js";

export type AchievementMetric =
  | "COMPLETED_LEVELS"
  | "TOTAL_STARS"
  | "THREE_STAR_LEVELS"
  | "DAILY_STREAK";

export type AchievementDefault = {
  code: string;
  name: string;
  description: string;
  metric: AchievementMetric;
  target: number;
  reward: RewardCurrencyAmount[];
};

export const ACHIEVEMENT_METRICS: readonly AchievementMetric[] = [
  "COMPLETED_LEVELS",
  "TOTAL_STARS",
  "THREE_STAR_LEVELS",
  "DAILY_STREAK",
];

export function achievementRewardCode(code: string): string {
  return `achievement.${code}`;
}

export const ACHIEVEMENTS: readonly AchievementDefault[] = [
  {
    code: "first_light",
    name: "First Light",
    description: "Complete your first level.",
    metric: "COMPLETED_LEVELS",
    target: 1,
    reward: [{ currency: "TOKEN", amount: 10 }],
  },
  {
    code: "pathfinder_10",
    name: "Pathfinder",
    description: "Complete 10 levels.",
    metric: "COMPLETED_LEVELS",
    target: 10,
    reward: [{ currency: "TOKEN", amount: 50 }],
  },
  {
    code: "pathfinder_50",
    name: "Trailblazer",
    description: "Complete 50 levels.",
    metric: "COMPLETED_LEVELS",
    target: 50,
    reward: [{ currency: "GEM", amount: 5 }],
  },
  {
    code: "pathfinder_100",
    name: "Beam Master",
    description: "Complete 100 levels.",
    metric: "COMPLETED_LEVELS",
    target: 100,
    reward: [{ currency: "GEM", amount: 10 }],
  },
  {
    code: "pathfinder_250",
    name: "Lumen Legend",
    description: "Complete 250 levels.",
    metric: "COMPLETED_LEVELS",
    target: 250,
    reward: [{ currency: "GEM", amount: 25 }],
  },
  {
    code: "star_collector_50",
    name: "Star Collector",
    description: "Earn 50 stars.",
    metric: "TOTAL_STARS",
    target: 50,
    reward: [{ currency: "TOKEN", amount: 40 }],
  },
  {
    code: "star_collector_250",
    name: "Star Hoarder",
    description: "Earn 250 stars.",
    metric: "TOTAL_STARS",
    target: 250,
    reward: [{ currency: "GEM", amount: 5 }],
  },
  {
    code: "star_collector_1000",
    name: "Constellation",
    description: "Earn 1000 stars.",
    metric: "TOTAL_STARS",
    target: 1000,
    reward: [{ currency: "GEM", amount: 15 }],
  },
  {
    code: "perfectionist_10",
    name: "Perfectionist",
    description: "Complete 10 levels with three stars.",
    metric: "THREE_STAR_LEVELS",
    target: 10,
    reward: [{ currency: "TOKEN", amount: 50 }],
  },
  {
    code: "perfectionist_50",
    name: "Flawless",
    description: "Complete 50 levels with three stars.",
    metric: "THREE_STAR_LEVELS",
    target: 50,
    reward: [{ currency: "GEM", amount: 5 }],
  },
  {
    code: "streak_3",
    name: "Warming Up",
    description: "Claim the daily reward 3 days in a row.",
    metric: "DAILY_STREAK",
    target: 3,
    reward: [{ currency: "TOKEN", amount: 30 }],
  },
  {
    code: "streak_7",
    name: "Devoted",
    description: "Claim the daily reward 7 days in a row.",
    metric: "DAILY_STREAK",
    target: 7,
    reward: [{ currency: "GEM", amount: 5 }],
  },
  {
    code: "streak_30",
    name: "Unbroken",
    description: "Claim the daily reward 30 days in a row.",
    metric: "DAILY_STREAK",
    target: 30,
    reward: [{ currency: "GEM", amount: 20 }],
  },
];
