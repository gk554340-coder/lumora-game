import { prisma } from "../../config/prisma.js";
import { AppError } from "../../errors/AppError.js";
import { ADMIN_ACTOR } from "../../plugins/authenticate-admin.js";
import {
  creditWallet,
  debitWallet,
  getWalletBalances,
  reconcileWallet,
} from "../wallet/wallet.service.js";

/**
 * Support and moderation tools for the admin key holder.
 *
 * Every change is written to the audit log with the reason. Changes
 * that can be repeated by mistake (suspend, reactivate, wallet
 * adjustment) are safe to send twice.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

const MIN_REASON_LENGTH = 3;
const MAX_REASON_LENGTH = 300;
export const MAX_ADMIN_ADJUSTMENT = 100_000;
export const DEFAULT_UNRECOVERED_LIMIT = 50;
export const MAX_UNRECOVERED_LIMIT = 200;

export type AdjustCurrency = "TOKEN" | "GEM";
export type AdjustDirection = "CREDIT" | "DEBIT";

function validationError(message: string): AppError {
  return new AppError("VALIDATION_ERROR", message, 400);
}

function cleanReason(reason: string): string {
  const clean = reason.trim();

  if (
    clean.length < MIN_REASON_LENGTH ||
    clean.length > MAX_REASON_LENGTH
  ) {
    throw validationError(
      `A reason of ${MIN_REASON_LENGTH} to ${MAX_REASON_LENGTH} characters is required.`,
    );
  }

  return clean;
}

function requireUserId(userId: string): void {
  if (!UUID_PATTERN.test(userId)) {
    throw new AppError("USER_NOT_FOUND", "User not found.", 404);
  }
}

async function writeAudit(
  userId: string,
  action: string,
  reason: string,
  details: Record<string, string | number | boolean | null> = {},
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      userId,
      action: "ADMIN_ACTION",
      entityType: "User",
      entityId: userId,
      metadata: { actor: ADMIN_ACTOR, action, reason, ...details },
    },
  });
}

export async function lookupUser(query: { email?: string; id?: string }) {
  const hasEmail = query.email !== undefined && query.email.trim() !== "";
  const hasId = query.id !== undefined && query.id.trim() !== "";

  if (hasEmail === hasId) {
    throw validationError("Provide exactly one of email or id.");
  }

  let user;

  if (hasId) {
    const id = (query.id ?? "").trim();
    requireUserId(id);
    user = await prisma.user.findUnique({ where: { id } });
  } else {
    user = await prisma.user.findUnique({
      where: { email: (query.email ?? "").trim().toLowerCase() },
    });
  }

  if (!user) {
    throw new AppError("USER_NOT_FOUND", "User not found.", 404);
  }

  const [balances, reconciliation, purchases, completedLevels, sessions] =
    await Promise.all([
      getWalletBalances(user.id),
      reconcileWallet(user.id),
      prisma.purchase.count({ where: { userId: user.id } }),
      prisma.playerProgress.count({
        where: { userId: user.id, completed: true },
      }),
      prisma.session.count({
        where: { userId: user.id, status: "ACTIVE" },
      }),
    ]);

  return {
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      status: user.status,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    },
    wallet: { ...balances, ledgerConsistent: reconciliation.consistent },
    activity: { purchases, completedLevels, activeSessions: sessions },
  };
}

export async function suspendUser(userId: string, reason: string) {
  requireUserId(userId);
  const clean = cleanReason(reason);

  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user) {
    throw new AppError("USER_NOT_FOUND", "User not found.", 404);
  }

  if (user.status === "DELETED") {
    throw new AppError("USER_DELETED", "This account is deleted.", 409);
  }

  if (user.status === "SUSPENDED") {
    return { userId, status: "SUSPENDED" as const, changed: false };
  }

  const changed = await prisma.$transaction(async (tx) => {
    const updated = await tx.user.updateMany({
      where: { id: userId, status: "ACTIVE" },
      data: { status: "SUSPENDED" },
    });

    if (updated.count === 0) {
      return false;
    }

    // The player is logged out everywhere at once.
    await tx.session.updateMany({
      where: { userId, status: "ACTIVE" },
      data: { status: "REVOKED", revokedAt: new Date() },
    });

    return true;
  });

  if (changed) {
    await writeAudit(userId, "suspend", clean);
  }

  return { userId, status: "SUSPENDED" as const, changed };
}

export async function reactivateUser(userId: string, reason: string) {
  requireUserId(userId);
  const clean = cleanReason(reason);

  const user = await prisma.user.findUnique({ where: { id: userId } });

  if (!user) {
    throw new AppError("USER_NOT_FOUND", "User not found.", 404);
  }

  if (user.status === "DELETED") {
    throw new AppError("USER_DELETED", "This account is deleted.", 409);
  }

  if (user.status === "ACTIVE") {
    return { userId, status: "ACTIVE" as const, changed: false };
  }

  const updated = await prisma.user.updateMany({
    where: { id: userId, status: "SUSPENDED" },
    data: { status: "ACTIVE" },
  });

  if (updated.count > 0) {
    await writeAudit(userId, "reactivate", clean);
  }

  return {
    userId,
    status: "ACTIVE" as const,
    changed: updated.count > 0,
  };
}

export interface AdjustWalletInput {
  userId: string;
  currency: AdjustCurrency;
  direction: AdjustDirection;
  amount: number;
  reason: string;
  requestId: string;
}

/**
 * Adds or removes currency by hand. The caller sends a request id of
 * its own for every adjustment. Sending the same id again never
 * applies the change twice.
 */
export async function adjustWallet(input: AdjustWalletInput) {
  requireUserId(input.userId);
  const reason = cleanReason(input.reason);

  if (input.currency !== "TOKEN" && input.currency !== "GEM") {
    throw validationError("Currency must be TOKEN or GEM.");
  }

  if (input.direction !== "CREDIT" && input.direction !== "DEBIT") {
    throw validationError("Direction must be CREDIT or DEBIT.");
  }

  if (
    !Number.isSafeInteger(input.amount) ||
    input.amount < 1 ||
    input.amount > MAX_ADMIN_ADJUSTMENT
  ) {
    throw validationError(
      `Amount must be a whole number from 1 to ${MAX_ADMIN_ADJUSTMENT}.`,
    );
  }

  if (!REQUEST_ID_PATTERN.test(input.requestId)) {
    throw validationError(
      "requestId must be 8 to 64 letters, digits, dashes or underscores.",
    );
  }

  const apply = input.direction === "CREDIT" ? creditWallet : debitWallet;

  const result = await apply({
    userId: input.userId,
    currency: input.currency,
    source: "ADMIN",
    amount: input.amount,
    idempotencyKey: `admin:${input.requestId}`,
    description: `Admin: ${reason}`,
  });

  if (!result.replayed) {
    await writeAudit(input.userId, "wallet-adjust", reason, {
      currency: input.currency,
      direction: input.direction,
      amount: input.amount,
      requestId: input.requestId,
    });
  }

  return {
    transactionId: result.transactionId,
    replayed: result.replayed,
    balances: await getWalletBalances(input.userId),
  };
}

/**
 * Refunded purchases where the player had already spent some of the
 * gems or tokens, so they could not be taken back in full.
 */
export async function listUnrecoveredRefunds(
  limit: number = DEFAULT_UNRECOVERED_LIMIT,
) {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_UNRECOVERED_LIMIT
  ) {
    throw new AppError(
      "INVALID_LIMIT",
      `The limit must be between 1 and ${MAX_UNRECOVERED_LIMIT}.`,
      400,
    );
  }

  const payments = await prisma.payment.findMany({
    where: {
      status: "REFUNDED",
      OR: [
        { metadata: { path: ["refund", "unrecoveredGems"], gt: 0 } },
        { metadata: { path: ["refund", "unrecoveredTokens"], gt: 0 } },
      ],
    },
    orderBy: { refundedAt: "desc" },
    take: limit,
    include: { purchase: { include: { product: true } } },
  });

  return {
    items: payments.map((payment) => {
      const refund =
        typeof payment.metadata === "object" &&
        payment.metadata !== null &&
        !Array.isArray(payment.metadata)
          ? ((payment.metadata as Record<string, unknown>).refund as
              | Record<string, unknown>
              | undefined)
          : undefined;

      return {
        paymentId: payment.id,
        purchaseId: payment.purchaseId,
        userId: payment.userId,
        sku: payment.purchase.product.sku,
        refundedAt: payment.refundedAt,
        unrecoveredGems: Number(refund?.unrecoveredGems ?? 0),
        unrecoveredTokens: Number(refund?.unrecoveredTokens ?? 0),
      };
    }),
  };
}
