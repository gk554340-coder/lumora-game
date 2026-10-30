import { prisma } from "../../config/prisma.js";
import { AppError } from "../../errors/AppError.js";
import type { WalletTransactionSource } from "../../generated/prisma/client.js";
import { creditWallet } from "../wallet/wallet.service.js";
import {
  REWARD_DEFAULTS,
  type RewardCurrency,
  type RewardCurrencyAmount,
} from "./reward.catalog.js";

/**
 * Reward service. Grants rewards to players.
 *
 * Guarantees:
 *  - A reward exists at most once per (user, reward, source id). The
 *    database enforces this with a unique key, so a repeated or parallel
 *    request cannot create a second grant.
 *  - Currency is paid through the wallet service with the idempotency
 *    key "reward:<grantId>:<currency>", so a retry never pays twice.
 *  - A grant is created first (PENDING) and marked GRANTED after the
 *    wallet is credited. If the process stops in between, calling
 *    grantReward again with the same source completes the grant.
 *
 * Server-side only. Never expose grantReward over HTTP.
 */

export type GrantRewardInput = {
  userId: string;
  rewardCode: string;
  sourceId: string;
  sourceType: WalletTransactionSource;
  cycleDay?: number;
};

export type GrantRewardResult = {
  grantId: string;
  alreadyGranted: boolean;
  rewards: RewardCurrencyAmount[];
};

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SOURCE_ID_PATTERN = /^[A-Za-z0-9:_.-]{1,128}$/;

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function invalidConfiguration(): AppError {
  return new AppError(
    "REWARD_CONFIGURATION_INVALID",
    "The reward is not configured correctly.",
    500,
  );
}

function toRewardCurrency(value: unknown): RewardCurrency | null {
  if (value === "TOKEN") {
    return "TOKEN";
  }

  if (value === "GEM") {
    return "GEM";
  }

  return null;
}

function parseCurrencyAmounts(value: unknown): RewardCurrencyAmount[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidConfiguration();
  }

  return value.map((entry: unknown): RewardCurrencyAmount => {
    if (!isRecord(entry)) {
      throw invalidConfiguration();
    }

    const currency = toRewardCurrency(entry.currency);
    const amount = entry.amount;

    if (
      currency === null ||
      typeof amount !== "number" ||
      !Number.isSafeInteger(amount) ||
      amount < 1
    ) {
      throw invalidConfiguration();
    }

    return { currency, amount };
  });
}

/**
 * Reads the currencies a reward pays out. Configuration comes from the
 * database, so it is validated instead of trusted.
 */
export function resolveRewardCurrencies(
  configuration: unknown,
  cycleDay?: number,
): RewardCurrencyAmount[] {
  if (!isRecord(configuration)) {
    throw invalidConfiguration();
  }

  if ("cycle" in configuration) {
    const cycle = configuration.cycle;

    if (!Array.isArray(cycle) || cycle.length === 0) {
      throw invalidConfiguration();
    }

    if (
      cycleDay === undefined ||
      !Number.isSafeInteger(cycleDay) ||
      cycleDay < 1 ||
      cycleDay > cycle.length
    ) {
      throw new AppError(
        "INVALID_CYCLE_DAY",
        "The cycle day is not valid for this reward.",
        400,
      );
    }

    const entry: unknown = cycle[cycleDay - 1];

    if (!isRecord(entry)) {
      throw invalidConfiguration();
    }

    return parseCurrencyAmounts(entry.currencies);
  }

  return parseCurrencyAmounts(configuration.currencies);
}

/**
 * Loads a reward definition by code. If no row exists yet, the default
 * from the catalog is stored first.
 */
export async function getRewardDefinition(code: string) {
  const existing = await prisma.rewardDefinition.findUnique({
    where: { code },
  });

  if (existing) {
    return existing;
  }

  const defaults = REWARD_DEFAULTS.find((entry) => entry.code === code);

  if (!defaults) {
    throw new AppError("REWARD_NOT_FOUND", "Reward not found.", 404);
  }

  try {
    return await prisma.rewardDefinition.create({
      data: {
        code: defaults.code,
        name: defaults.name,
        description: defaults.description,
        type: "CURRENCY",
        configuration: defaults.configuration,
      },
    });
  } catch (error) {
    // Another request created the same definition first.
    if (hasErrorCode(error, "P2002")) {
      return prisma.rewardDefinition.findUniqueOrThrow({
        where: { code },
      });
    }

    throw error;
  }
}

function validateGrantInput(input: GrantRewardInput): void {
  if (!UUID_PATTERN.test(input.userId)) {
    throw new AppError("INVALID_USER", "A valid user is required.", 400);
  }

  if (!SOURCE_ID_PATTERN.test(input.sourceId)) {
    throw new AppError(
      "INVALID_SOURCE",
      "The reward source is not valid.",
      400,
    );
  }
}

async function findOrCreateGrant(
  input: GrantRewardInput,
  rewardDefinitionId: string,
) {
  try {
    return await prisma.rewardGrant.create({
      data: {
        userId: input.userId,
        rewardDefinitionId,
        status: "PENDING",
        sourceType: input.sourceType,
        sourceId: input.sourceId,
      },
      select: { id: true, status: true },
    });
  } catch (error) {
    if (hasErrorCode(error, "P2003")) {
      throw new AppError("USER_NOT_FOUND", "User not found.", 404);
    }

    if (!hasErrorCode(error, "P2002")) {
      throw error;
    }

    const existing = await prisma.rewardGrant.findFirst({
      where: {
        userId: input.userId,
        rewardDefinitionId,
        sourceId: input.sourceId,
      },
      select: { id: true, status: true },
    });

    if (!existing) {
      throw error;
    }

    return existing;
  }
}

async function readGrantedAmounts(
  grantId: string,
): Promise<RewardCurrencyAmount[]> {
  const rows = await prisma.walletTransaction.findMany({
    where: { rewardGrantId: grantId, type: "CREDIT" },
    orderBy: { createdAt: "asc" },
    select: { currency: true, amount: true },
  });

  return rows.flatMap((row) => {
    const currency = toRewardCurrency(row.currency);

    return currency === null ? [] : [{ currency, amount: row.amount }];
  });
}

export async function grantReward(
  input: GrantRewardInput,
): Promise<GrantRewardResult> {
  validateGrantInput(input);

  const definition = await getRewardDefinition(input.rewardCode);

  if (!definition.isActive) {
    throw new AppError(
      "REWARD_UNAVAILABLE",
      "This reward is not available.",
      409,
    );
  }

  const rewards = resolveRewardCurrencies(
    definition.configuration,
    input.cycleDay,
  );

  const grant = await findOrCreateGrant(input, definition.id);

  if (grant.status === "GRANTED" || grant.status === "CLAIMED") {
    return {
      grantId: grant.id,
      alreadyGranted: true,
      rewards: await readGrantedAmounts(grant.id),
    };
  }

  if (grant.status !== "PENDING") {
    throw new AppError(
      "REWARD_UNAVAILABLE",
      "This reward is not available.",
      409,
    );
  }

  for (const reward of rewards) {
    await creditWallet({
      userId: input.userId,
      currency: reward.currency,
      source: "REWARD",
      amount: reward.amount,
      idempotencyKey: `reward:${grant.id}:${reward.currency}`,
      description: definition.name,
      rewardGrantId: grant.id,
    });
  }

  await prisma.rewardGrant.updateMany({
    where: { id: grant.id, status: "PENDING" },
    data: { status: "GRANTED", grantedAt: new Date() },
  });

  return {
    grantId: grant.id,
    alreadyGranted: false,
    rewards,
  };
}
