import { prisma } from "../../config/prisma.js";
import { AppError } from "../../errors/AppError.js";
import type {
  CurrencyType,
  WalletTransactionSource,
  WalletTransactionType,
} from "../../generated/prisma/client.js";

/**
 * Wallet service. This is the ONLY place that changes balances.
 *
 * Invariants:
 *  - Every balance change writes exactly one WalletTransaction row in
 *    the same database transaction (ledger and balance never diverge).
 *  - A balance never goes below zero or above the INTEGER maximum. The
 *    check is part of the UPDATE itself, so concurrent requests cannot
 *    bypass it.
 *  - An idempotency key makes a transaction apply at most once.
 *  - Only TOKEN and GEM are supported.
 *
 * creditWallet and debitWallet are for server-side modules only
 * (rewards, payments, game). They must never be exposed over HTTP.
 * Callers decide whether the user's account status allows the change.
 */

export type SupportedCurrency = "TOKEN" | "GEM";

export interface WalletTransactionInput {
  userId: string;
  currency: CurrencyType;
  type: WalletTransactionType;
  source: WalletTransactionSource;
  amount: number;
  idempotencyKey?: string;
  description?: string;
  rewardGrantId?: string;
  purchaseId?: string;
}

export interface WalletTransactionResult {
  transactionId: string;
  currency: SupportedCurrency;
  type: WalletTransactionType;
  amount: number;
  balanceAfter: number;
  replayed: boolean;
}

interface StoredTransaction {
  id: string;
  userId: string;
  currency: CurrencyType;
  type: WalletTransactionType;
  source: WalletTransactionSource;
  amount: number;
  balanceAfter: number;
}

const MAX_BALANCE = 2_147_483_647;
const DESCRIPTION_MAX_LENGTH = 500;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9:_.-]{1,128}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TRANSACTION_OPTIONS = {
  maxWait: 5_000,
  timeout: 10_000,
};

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function toSupportedCurrency(
  currency: CurrencyType,
): SupportedCurrency {
  if (currency === "TOKEN" || currency === "GEM") {
    return currency;
  }

  throw new AppError(
    "CURRENCY_NOT_SUPPORTED",
    "This currency is not supported.",
    400,
  );
}

function validateUuid(value: string | undefined, name: string): void {
  if (value !== undefined && !UUID_PATTERN.test(value)) {
    throw new AppError(
      "INVALID_REFERENCE",
      `Invalid ${name}.`,
      400,
    );
  }
}

function validateInput(input: WalletTransactionInput): void {
  if (typeof input.userId !== "string" || !UUID_PATTERN.test(input.userId)) {
    throw new AppError("INVALID_USER", "A valid user is required.", 400);
  }

  if (input.type !== "CREDIT" && input.type !== "DEBIT") {
    throw new AppError(
      "INVALID_TRANSACTION_TYPE",
      "Transaction type must be CREDIT or DEBIT.",
      400,
    );
  }

  if (
    !Number.isSafeInteger(input.amount) ||
    input.amount < 1 ||
    input.amount > MAX_BALANCE
  ) {
    throw new AppError(
      "INVALID_AMOUNT",
      "Amount must be a positive whole number.",
      400,
    );
  }

  if (
    input.idempotencyKey !== undefined &&
    !IDEMPOTENCY_KEY_PATTERN.test(input.idempotencyKey)
  ) {
    throw new AppError(
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency key format is invalid.",
      400,
    );
  }

  if (
    input.description !== undefined &&
    input.description.length > DESCRIPTION_MAX_LENGTH
  ) {
    throw new AppError(
      "INVALID_DESCRIPTION",
      "Description is too long.",
      400,
    );
  }

  validateUuid(input.rewardGrantId, "reward grant");
  validateUuid(input.purchaseId, "purchase");
}

/**
 * Builds the guarded balance update. The WHERE clause is the safety
 * check: a debit only matches when enough balance exists, a credit only
 * when the result stays within the INTEGER range. If no row matches,
 * nothing is changed.
 */
function balanceChange(
  currency: SupportedCurrency,
  type: WalletTransactionType,
  amount: number,
) {
  const isDebit = type === "DEBIT";
  const change = isDebit ? { decrement: amount } : { increment: amount };
  const guard = isDebit
    ? { gte: amount }
    : { lte: MAX_BALANCE - amount };

  if (currency === "TOKEN") {
    return {
      where: { tokenBalance: guard },
      data: {
        tokenBalance: change,
        version: { increment: 1 },
      },
    };
  }

  return {
    where: { gemBalance: guard },
    data: {
      gemBalance: change,
      version: { increment: 1 },
    },
  };
}

function limitError(type: WalletTransactionType): AppError {
  if (type === "DEBIT") {
    return new AppError(
      "INSUFFICIENT_FUNDS",
      "Not enough balance for this transaction.",
      409,
    );
  }

  return new AppError(
    "BALANCE_LIMIT_EXCEEDED",
    "The balance limit has been reached.",
    409,
  );
}

function toReplayResult(
  existing: StoredTransaction,
  input: WalletTransactionInput,
): WalletTransactionResult {
  if (
    existing.userId !== input.userId ||
    existing.currency !== input.currency ||
    existing.type !== input.type ||
    existing.source !== input.source ||
    existing.amount !== input.amount
  ) {
    throw new AppError(
      "IDEMPOTENCY_KEY_REUSED",
      "This idempotency key was already used for a different transaction.",
      409,
    );
  }

  return {
    transactionId: existing.id,
    currency: toSupportedCurrency(existing.currency),
    type: existing.type,
    amount: existing.amount,
    balanceAfter: existing.balanceAfter,
    replayed: true,
  };
}

export async function applyWalletTransaction(
  input: WalletTransactionInput,
): Promise<WalletTransactionResult> {
  const currency = toSupportedCurrency(input.currency);
  validateInput(input);

  const description = input.description?.trim() || undefined;

  try {
    return await prisma.$transaction(
      async (tx): Promise<WalletTransactionResult> => {
        if (input.idempotencyKey !== undefined) {
          const existing = await tx.walletTransaction.findUnique({
            where: { idempotencyKey: input.idempotencyKey },
          });

          if (existing) {
            return toReplayResult(existing, input);
          }
        }

        // Wallets are created at registration. This covers accounts that
        // were created before that, and is safe under concurrency.
        await tx.wallet.upsert({
          where: { userId: input.userId },
          create: { userId: input.userId },
          update: {},
        });

        const change = balanceChange(
          currency,
          input.type,
          input.amount,
        );

        const updated = await tx.wallet.updateMany({
          where: { userId: input.userId, ...change.where },
          data: change.data,
        });

        if (updated.count === 0) {
          throw limitError(input.type);
        }

        // Our UPDATE holds the row lock until commit, so this read sees
        // exactly the balance we produced.
        const wallet = await tx.wallet.findUniqueOrThrow({
          where: { userId: input.userId },
          select: {
            id: true,
            tokenBalance: true,
            gemBalance: true,
          },
        });

        const balanceAfter =
          currency === "TOKEN" ? wallet.tokenBalance : wallet.gemBalance;

        const created = await tx.walletTransaction.create({
          data: {
            walletId: wallet.id,
            userId: input.userId,
            currency,
            type: input.type,
            source: input.source,
            amount: input.amount,
            balanceAfter,
            description,
            rewardGrantId: input.rewardGrantId,
            purchaseId: input.purchaseId,
            idempotencyKey: input.idempotencyKey,
          },
          select: { id: true },
        });

        return {
          transactionId: created.id,
          currency,
          type: input.type,
          amount: input.amount,
          balanceAfter,
          replayed: false,
        };
      },
      TRANSACTION_OPTIONS,
    );
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    // Two requests with the same key raced: the loser's whole database
    // transaction (balance change included) was rolled back. Return the
    // winner's result.
    if (
      input.idempotencyKey !== undefined &&
      hasErrorCode(error, "P2002")
    ) {
      const existing = await prisma.walletTransaction.findUnique({
        where: { idempotencyKey: input.idempotencyKey },
      });

      if (existing) {
        return toReplayResult(existing, input);
      }
    }

    if (hasErrorCode(error, "P2003")) {
      throw new AppError("USER_NOT_FOUND", "User not found.", 404);
    }

    throw error;
  }
}

export function creditWallet(
  input: Omit<WalletTransactionInput, "type">,
): Promise<WalletTransactionResult> {
  return applyWalletTransaction({ ...input, type: "CREDIT" });
}

export function debitWallet(
  input: Omit<WalletTransactionInput, "type">,
): Promise<WalletTransactionResult> {
  return applyWalletTransaction({ ...input, type: "DEBIT" });
}

export async function getWalletBalances(userId: string) {
  const wallet = await prisma.wallet.findUnique({
    where: { userId },
    select: {
      tokenBalance: true,
      gemBalance: true,
    },
  });

  return {
    tokenBalance: wallet?.tokenBalance ?? 0,
    gemBalance: wallet?.gemBalance ?? 0,
  };
}

export async function listWalletTransactions(
  userId: string,
  options: {
    limit: number;
    cursor?: string;
    currency?: SupportedCurrency;
  },
) {
  const rows = await prisma.walletTransaction.findMany({
    where: {
      userId,
      currency: options.currency,
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: options.limit + 1,
    cursor: options.cursor ? { id: options.cursor } : undefined,
    skip: options.cursor ? 1 : 0,
    select: {
      id: true,
      currency: true,
      type: true,
      source: true,
      amount: true,
      balanceAfter: true,
      description: true,
      createdAt: true,
    },
  });

  const hasMore = rows.length > options.limit;
  const items = hasMore ? rows.slice(0, options.limit) : rows;
  const last = items[items.length - 1];

  return {
    items,
    nextCursor: hasMore && last ? last.id : null,
  };
}

export interface WalletReconciliation {
  consistent: boolean;
  token: { balance: number; ledgerTotal: number };
  gem: { balance: number; ledgerTotal: number };
}

/**
 * Audit check: compares each stored balance with the net total of its
 * ledger rows (credits minus debits). They must always match. A
 * mismatch means data was changed outside this service and must be
 * investigated. Server-side only; never expose this over HTTP.
 */
export async function reconcileWallet(
  userId: string,
): Promise<WalletReconciliation> {
  if (!UUID_PATTERN.test(userId)) {
    throw new AppError("INVALID_USER", "A valid user is required.", 400);
  }

  const [balances, rows] = await Promise.all([
    getWalletBalances(userId),
    prisma.$queryRaw<{ currency: string; net: unknown }[]>`
      SELECT "currency"::text AS "currency",
             COALESCE(
               SUM(
                 CASE WHEN "type" = 'CREDIT' THEN "amount" ELSE -"amount" END
               ),
               0
             ) AS "net"
      FROM "WalletTransaction"
      WHERE "userId" = ${userId}::uuid
      GROUP BY "currency"
    `,
  ]);

  const ledgerTotal = (currency: SupportedCurrency): number => {
    const row = rows.find((entry) => entry.currency === currency);
    return row ? Number(row.net) : 0;
  };

  const token = {
    balance: balances.tokenBalance,
    ledgerTotal: ledgerTotal("TOKEN"),
  };

  const gem = {
    balance: balances.gemBalance,
    ledgerTotal: ledgerTotal("GEM"),
  };

  return {
    consistent:
      token.balance === token.ledgerTotal &&
      gem.balance === gem.ledgerTotal,
    token,
    gem,
  };
}
