import { prisma } from "../../config/prisma.js";
import { AppError } from "../../errors/AppError.js";
import {
  debitWallet,
  getWalletBalances,
} from "../wallet/wallet.service.js";
import type {
  PlayVoidedPurchaseSource,
  VoidedPurchaseRecord,
} from "./google-play.client.js";
import { hashPurchaseToken } from "./payment.service.js";

/**
 * Refunds and charge-backs.
 *
 * When Google voids a purchase, the gems it gave are taken back, but
 * only what is still in the wallet. Gems the player already spent are
 * not recovered, and the missing amount is written down on the payment
 * so support can see it. A balance never goes below zero.
 *
 * Everything here is safe to run again and again: the reversal uses a
 * fixed idempotency key per purchase and currency, and a purchase that
 * is already REFUNDED is skipped.
 */

type JsonScalar = string | number | boolean | null;
type JsonObject = { [key: string]: JsonScalar | { [key: string]: JsonScalar } };

export type ReversalOutcome =
  | "REVERSED"
  | "ALREADY_REVERSED"
  | "UNKNOWN_TOKEN";

export interface ReversalResult {
  outcome: ReversalOutcome;
  purchaseId: string | null;
  recovered: { gems: number; tokens: number };
  unrecovered: { gems: number; tokens: number };
}

export interface VoidedSyncSummary {
  fetched: number;
  reversed: number;
  alreadyReversed: number;
  unknown: number;
}

const MAX_DEBIT_ATTEMPTS = 3;
const DEFAULT_LOOKBACK_DAYS = 28;
const MAX_LOOKBACK_DAYS = 30;
const DEFAULT_MAX_PAGES = 50;
const DAY_MS = 86_400_000;

function asObject(value: unknown): JsonObject {
  return typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function none(outcome: ReversalOutcome, purchaseId: string | null) {
  return {
    outcome,
    purchaseId,
    recovered: { gems: 0, tokens: 0 },
    unrecovered: { gems: 0, tokens: 0 },
  } satisfies ReversalResult;
}

/**
 * Takes back what is left of one credit. Skips if it was already done.
 * Returns how much was actually taken back.
 */
async function reverseCredit(
  purchase: { id: string; userId: string },
  currency: "GEM" | "TOKEN",
  creditedAmount: number,
): Promise<number> {
  const key = `refund:${purchase.id}:${currency}`;

  const existing = await prisma.walletTransaction.findUnique({
    where: { idempotencyKey: key },
    select: { amount: true },
  });

  if (existing) {
    return existing.amount;
  }

  for (let attempt = 0; attempt < MAX_DEBIT_ATTEMPTS; attempt += 1) {
    const balances = await getWalletBalances(purchase.userId);
    const available =
      currency === "GEM" ? balances.gemBalance : balances.tokenBalance;
    const amount = Math.min(available, creditedAmount);

    if (amount <= 0) {
      return 0;
    }

    try {
      const result = await debitWallet({
        userId: purchase.userId,
        currency,
        source: "REVERSAL",
        amount,
        idempotencyKey: key,
        description: "Purchase refunded",
        purchaseId: purchase.id,
      });

      return result.amount;
    } catch (error) {
      if (!(error instanceof AppError)) {
        throw error;
      }

      if (error.code === "IDEMPOTENCY_KEY_REUSED") {
        // A parallel run did it with another amount. Use its result.
        const done = await prisma.walletTransaction.findUnique({
          where: { idempotencyKey: key },
          select: { amount: true },
        });

        return done?.amount ?? 0;
      }

      // The player spent gems at the same moment. Look again.
      if (error.code !== "INSUFFICIENT_FUNDS") {
        throw error;
      }
    }
  }

  return 0;
}

export async function reverseVoidedPurchase(
  record: VoidedPurchaseRecord,
): Promise<ReversalResult> {
  const payment = await prisma.payment.findUnique({
    where: { providerPaymentId: hashPurchaseToken(record.purchaseToken) },
    include: { purchase: true },
  });

  if (!payment || payment.provider !== "GOOGLE_PLAY") {
    return none("UNKNOWN_TOKEN", null);
  }

  const { purchase } = payment;

  if (purchase.status === "REFUNDED") {
    return none("ALREADY_REVERSED", purchase.id);
  }

  const credits = await prisma.walletTransaction.findMany({
    where: { purchaseId: purchase.id, type: "CREDIT" },
    select: { currency: true, amount: true },
  });

  const recovered = { gems: 0, tokens: 0 };
  const unrecovered = { gems: 0, tokens: 0 };

  for (const credit of credits) {
    if (credit.currency !== "GEM" && credit.currency !== "TOKEN") {
      continue;
    }

    const taken = await reverseCredit(
      purchase,
      credit.currency,
      credit.amount,
    );
    const missing = credit.amount - taken;

    if (credit.currency === "GEM") {
      recovered.gems += taken;
      unrecovered.gems += missing;
    } else {
      recovered.tokens += taken;
      unrecovered.tokens += missing;
    }
  }

  const refundInfo = {
    voidedTimeMillis: record.voidedTimeMillis,
    voidedSource: record.voidedSource,
    voidedReason: record.voidedReason,
    recoveredGems: recovered.gems,
    recoveredTokens: recovered.tokens,
    unrecoveredGems: unrecovered.gems,
    unrecoveredTokens: unrecovered.tokens,
  };

  const finalized = await prisma.$transaction(async (tx) => {
    const claimed = await tx.purchase.updateMany({
      where: { id: purchase.id, status: { not: "REFUNDED" } },
      data: { status: "REFUNDED", refundedAt: new Date() },
    });

    if (claimed.count === 0) {
      return false;
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: "REFUNDED",
        refundedAt: new Date(),
        metadata: { ...asObject(payment.metadata), refund: refundInfo },
      },
    });

    await tx.auditLog.create({
      data: {
        userId: purchase.userId,
        action: "REFUND",
        entityType: "Purchase",
        entityId: purchase.id,
        metadata: { ...refundInfo, provider: "GOOGLE_PLAY" },
      },
    });

    return true;
  });

  if (!finalized) {
    return none("ALREADY_REVERSED", purchase.id);
  }

  return {
    outcome: "REVERSED",
    purchaseId: purchase.id,
    recovered,
    unrecovered,
  };
}

export interface SyncOptions {
  lookbackDays?: number;
  maxPages?: number;
  now?: () => number;
}

/**
 * Reads Google's list of voided purchases and reverses each one that
 * belongs to us. Run it on a schedule, for example once a day.
 */
export async function syncVoidedPurchases(
  source: PlayVoidedPurchaseSource,
  options: SyncOptions = {},
): Promise<VoidedSyncSummary> {
  const lookbackDays = Math.min(
    Math.max(options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS, 1),
    MAX_LOOKBACK_DAYS,
  );
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const now = options.now ?? Date.now;

  const startTimeMillis = now() - lookbackDays * DAY_MS;

  const summary: VoidedSyncSummary = {
    fetched: 0,
    reversed: 0,
    alreadyReversed: 0,
    unknown: 0,
  };

  let pageToken: string | undefined;

  for (let page = 0; page < maxPages; page += 1) {
    const result = await source.listVoidedPurchases({
      startTimeMillis,
      pageToken,
    });

    for (const record of result.items) {
      summary.fetched += 1;

      const outcome = (await reverseVoidedPurchase(record)).outcome;

      if (outcome === "REVERSED") {
        summary.reversed += 1;
      } else if (outcome === "ALREADY_REVERSED") {
        summary.alreadyReversed += 1;
      } else {
        summary.unknown += 1;
      }
    }

    if (!result.nextPageToken) {
      break;
    }

    pageToken = result.nextPageToken;
  }

  return summary;
}
