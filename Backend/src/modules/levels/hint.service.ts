import { prisma } from "../../config/prisma.js";
import { AppError } from "../../errors/AppError.js";
import { debitWallet, getWalletBalances } from "../wallet/wallet.service.js";
import { MAX_ATTEMPT_AGE_MS } from "./level.service.js";
import {
  MAX_MOVES,
  applyMoves,
  parseLevelConfiguration,
  simulate,
} from "./lumen-engine.js";

/**
 * Hints: a stuck player pays tokens to learn one correct tile to flip.
 *
 * Rules
 *  - The hint is worked out on the server from the stored solution and
 *    the moves the player has made so far. It names the first solution
 *    tile that is not flipped yet.
 *  - A hint costs HINT_COST_TOKENS, paid through the wallet with the key
 *    "hint:<attemptId>:<tile>". Asking again for the same tile, for
 *    example after a lost response, is free.
 *  - At most MAX_HINTS_PER_ATTEMPT hints per attempt.
 *  - Hints do not change the stars a player can earn.
 */

export const HINT_COST_TOKENS = 15;
export const MAX_HINTS_PER_ATTEMPT = 10;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type HintResult = {
  tile: number;
  x: number;
  y: number;
  cost: number;
  tokenBalance: number;
  hintsUsed: number;
  hintsRemaining: number;
};

export async function requestHint(
  userId: string,
  attemptId: string,
  moves: readonly number[],
  now: Date = new Date(),
): Promise<HintResult> {
  if (!UUID_PATTERN.test(attemptId)) {
    throw new AppError("ATTEMPT_NOT_FOUND", "Attempt not found.", 404);
  }

  if (
    !Array.isArray(moves) ||
    moves.length > MAX_MOVES ||
    !moves.every((move) => Number.isSafeInteger(move))
  ) {
    throw new AppError(
      "MOVES_INVALID",
      "The list of moves is not valid.",
      400,
    );
  }

  const attempt = await prisma.levelAttempt.findFirst({
    where: { id: attemptId, userId },
    include: { level: { select: { configuration: true } } },
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

  if (now.getTime() - attempt.startedAt.getTime() > MAX_ATTEMPT_AGE_MS) {
    throw new AppError(
      "ATTEMPT_EXPIRED",
      "This attempt has expired. Start the level again.",
      409,
    );
  }

  const configuration = parseLevelConfiguration(attempt.level.configuration);

  if (!configuration) {
    throw new AppError(
      "LEVEL_CORRUPT",
      "The level data is not valid.",
      500,
    );
  }

  const current = applyMoves(
    {
      width: configuration.width,
      height: configuration.height,
      tiles: configuration.tiles,
    },
    moves,
  );

  if (!current) {
    throw new AppError(
      "MOVES_INVALID",
      "The list of moves is not valid.",
      400,
    );
  }

  const notNeeded = (): AppError =>
    new AppError(
      "HINT_NOT_NEEDED",
      "The level is already solved. Submit your moves.",
      409,
    );

  if (simulate(current).solved) {
    throw notNeeded();
  }

  const flips = new Map<number, number>();

  for (const move of moves) {
    flips.set(move, (flips.get(move) ?? 0) + 1);
  }

  const tile = configuration.solution.find(
    (index) => (flips.get(index) ?? 0) % 2 === 0,
  );

  if (tile === undefined) {
    throw notNeeded();
  }

  const keyPrefix = `hint:${attempt.id}:`;
  const key = `${keyPrefix}${tile}`;

  const alreadyPaid = await prisma.walletTransaction.findUnique({
    where: { idempotencyKey: key },
    select: { id: true },
  });

  if (!alreadyPaid) {
    const used = await prisma.walletTransaction.count({
      where: { userId, idempotencyKey: { startsWith: keyPrefix } },
    });

    if (used >= MAX_HINTS_PER_ATTEMPT) {
      throw new AppError(
        "HINT_LIMIT_REACHED",
        "No more hints are available for this attempt.",
        409,
      );
    }
  }

  const payment = await debitWallet({
    userId,
    currency: "TOKEN",
    source: "GAMEPLAY",
    amount: HINT_COST_TOKENS,
    idempotencyKey: key,
    description: "Level hint",
  });

  const hintsUsed = await prisma.walletTransaction.count({
    where: { userId, idempotencyKey: { startsWith: keyPrefix } },
  });

  return {
    tile,
    x: tile % configuration.width,
    y: Math.floor(tile / configuration.width),
    cost: payment.replayed ? 0 : HINT_COST_TOKENS,
    tokenBalance: (await getWalletBalances(userId)).tokenBalance,
    hintsUsed,
    hintsRemaining: Math.max(0, MAX_HINTS_PER_ATTEMPT - hintsUsed),
  };
}
