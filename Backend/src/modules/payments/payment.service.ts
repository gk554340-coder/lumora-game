import { createHash } from "node:crypto";

import { prisma } from "../../config/prisma.js";
import { AppError } from "../../errors/AppError.js";
import { getWalletBalances, creditWallet } from "../wallet/wallet.service.js";
import { PlayApiError } from "./google-play.client.js";
import {
  getPaymentsRuntime,
  obfuscatedAccountId,
  type PaymentsRuntime,
} from "./payments.runtime.js";
import { ensureDefaultProducts } from "./product.catalog.js";

/**
 * Google Play purchase verification.
 *
 * The app never decides what it was paid for. It sends the purchase
 * token, and the server asks Google, checks everything, grants the
 * gems exactly once and then consumes the purchase so it can be bought
 * again.
 *
 * Safety rules:
 *  - The raw purchase token is never stored. Only its SHA-256 hash.
 *  - One token belongs to one user, forever.
 *  - Gems are granted with a fixed idempotency key per purchase, so a
 *    retry, a double tap or a crash in the middle never pays twice.
 *  - Google's answer must match: sku, paid state, quantity 1 and the
 *    obfuscated account id that this user's app was given.
 */

const SKU_PATTERN = /^[a-z0-9._]{1,100}$/;
const MAX_TOKEN_LENGTH = 2048;

const PURCHASE_STATE_PURCHASED = 0;
const PURCHASE_STATE_PENDING = 2;
const CONSUMPTION_STATE_CONSUMED = 1;
const PURCHASE_TYPE_TEST = 0;

export interface VerifyPurchaseResult {
  purchaseId: string;
  sku: string;
  status: "COMPLETED";
  granted: { gems: number; tokens: number };
  balances: { tokenBalance: number; gemBalance: number };
  consumed: boolean;
  replayed: boolean;
}

export function hashPurchaseToken(purchaseToken: string): string {
  return createHash("sha256").update(purchaseToken).digest("hex");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function isConsumed(metadata: unknown): boolean {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    !Array.isArray(metadata) &&
    (metadata as Record<string, unknown>).consumed === true
  );
}

function requireRuntime(): PaymentsRuntime {
  const runtime = getPaymentsRuntime();

  if (!runtime) {
    throw new AppError(
      "PAYMENTS_NOT_CONFIGURED",
      "Payments are not available right now.",
      503,
    );
  }

  return runtime;
}

export function getGooglePlayAccountId(userId: string): string {
  return obfuscatedAccountId(requireRuntime().accountSecret, userId);
}

export async function listProducts() {
  await ensureDefaultProducts();

  const products = await prisma.purchaseProduct.findMany({
    where: { isActive: true, gemAmount: { gt: 0 } },
    orderBy: { priceMinorUnit: "asc" },
  });

  return {
    enabled: getPaymentsRuntime() !== null,
    products: products.map((product) => ({
      sku: product.sku,
      name: product.name,
      gemAmount: product.gemAmount,
      tokenAmount: product.tokenAmount,
      referencePrice: {
        currency: product.currency,
        minorUnit: product.priceMinorUnit,
      },
    })),
  };
}

function providerError(error: unknown): AppError {
  if (
    error instanceof PlayApiError &&
    error.status !== null &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 401 &&
    error.status !== 403 &&
    error.status !== 429
  ) {
    return new AppError(
      "PAYMENT_PROVIDER_ERROR",
      "The payment provider rejected the request.",
      502,
    );
  }

  return new AppError(
    "PAYMENT_PROVIDER_UNAVAILABLE",
    "The payment provider is not reachable right now. Please try again.",
    503,
  );
}

function invalidPurchase(message: string): AppError {
  return new AppError("PURCHASE_INVALID", message, 422);
}

type StoredPayment = NonNullable<
  Awaited<ReturnType<typeof findPaymentByHash>>
>;

function findPaymentByHash(tokenHash: string) {
  return prisma.payment.findUnique({
    where: { providerPaymentId: tokenHash },
    include: { purchase: { include: { product: true } } },
  });
}

/**
 * Asks Google if the purchase is real, paid, for this product and
 * started by this user. Throws a clear AppError otherwise.
 */
async function verifyWithGoogle(
  runtime: PaymentsRuntime,
  userId: string,
  sku: string,
  purchaseToken: string,
) {
  let purchase;

  try {
    purchase = await runtime.client.getProductPurchase(
      sku,
      purchaseToken,
    );
  } catch (error) {
    throw providerError(error);
  }

  if (!purchase) {
    throw invalidPurchase("This purchase could not be found.");
  }

  if (purchase.purchaseState === PURCHASE_STATE_PENDING) {
    throw new AppError(
      "PURCHASE_PENDING",
      "This purchase is still pending. Gems will be added after it is paid.",
      409,
    );
  }

  if (purchase.purchaseState !== PURCHASE_STATE_PURCHASED) {
    throw invalidPurchase("This purchase was not paid.");
  }

  if (purchase.productId !== sku) {
    throw invalidPurchase("This purchase is for a different product.");
  }

  if (purchase.quantity !== 1) {
    throw invalidPurchase("Only a quantity of 1 is supported.");
  }

  if (purchase.purchaseType !== null) {
    const allowed =
      purchase.purchaseType === PURCHASE_TYPE_TEST &&
      runtime.allowTestPurchases;

    if (!allowed) {
      throw invalidPurchase("This kind of purchase is not accepted.");
    }
  }

  const expectedAccountId = obfuscatedAccountId(
    runtime.accountSecret,
    userId,
  );

  if (purchase.obfuscatedExternalAccountId !== expectedAccountId) {
    throw new AppError(
      "PURCHASE_ACCOUNT_MISMATCH",
      "This purchase belongs to a different account.",
      403,
    );
  }

  return purchase;
}

/** Gives the goods (idempotent) and marks the purchase completed. */
async function grantAndComplete(stored: StoredPayment): Promise<{
  gems: number;
  tokens: number;
}> {
  const { purchase } = stored;
  const { product } = purchase;

  const credits: Array<{ currency: "GEM" | "TOKEN"; amount: number }> = [
    { currency: "GEM", amount: product.gemAmount },
    { currency: "TOKEN", amount: product.tokenAmount },
  ];

  for (const credit of credits) {
    if (credit.amount <= 0) {
      continue;
    }

    await creditWallet({
      userId: purchase.userId,
      currency: credit.currency,
      source: "PURCHASE",
      amount: credit.amount,
      idempotencyKey: `purchase:${purchase.id}:${credit.currency}`,
      description: `Purchase ${product.sku}`,
      purchaseId: purchase.id,
    });
  }

  await prisma.purchase.updateMany({
    where: { id: purchase.id, status: "PENDING" },
    data: { status: "COMPLETED", completedAt: new Date() },
  });

  return { gems: product.gemAmount, tokens: product.tokenAmount };
}

/**
 * Consumes the purchase at Google so the player can buy it again. A
 * failure here never fails the player's request: the gems are already
 * granted, and the next verify for the same token retries.
 */
async function consumeSafely(
  runtime: PaymentsRuntime,
  stored: StoredPayment,
  purchaseToken: string,
): Promise<boolean> {
  if (isConsumed(stored.metadata)) {
    return true;
  }

  const sku = stored.purchase.product.sku;
  let consumed = false;

  try {
    await runtime.client.consume(sku, purchaseToken);
    consumed = true;
  } catch {
    // Maybe it was already consumed by an earlier attempt.
    try {
      const current = await runtime.client.getProductPurchase(
        sku,
        purchaseToken,
      );
      consumed = current?.consumptionState === CONSUMPTION_STATE_CONSUMED;
    } catch {
      consumed = false;
    }
  }

  if (consumed) {
    await prisma.payment.update({
      where: { id: stored.id },
      data: {
        metadata: {
          ...(typeof stored.metadata === "object" &&
          stored.metadata !== null &&
          !Array.isArray(stored.metadata)
            ? (stored.metadata as Record<string, string | number | boolean | null>)
            : {}),
          consumed: true,
        },
      },
    });
  }

  return consumed;
}

async function finish(
  runtime: PaymentsRuntime,
  stored: StoredPayment,
  purchaseToken: string,
  replayed: boolean,
): Promise<VerifyPurchaseResult> {
  const granted = await grantAndComplete(stored);
  const consumed = await consumeSafely(runtime, stored, purchaseToken);

  return {
    purchaseId: stored.purchase.id,
    sku: stored.purchase.product.sku,
    status: "COMPLETED",
    granted,
    balances: await getWalletBalances(stored.purchase.userId),
    consumed,
    replayed,
  };
}

export async function verifyGooglePlayPurchase(
  userId: string,
  sku: string,
  purchaseToken: string,
): Promise<VerifyPurchaseResult> {
  if (!SKU_PATTERN.test(sku)) {
    throw new AppError("VALIDATION_ERROR", "Invalid product id.", 400);
  }

  const token = purchaseToken.trim();

  if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    throw new AppError("VALIDATION_ERROR", "Invalid purchase token.", 400);
  }

  const runtime = requireRuntime();
  const tokenHash = hashPurchaseToken(token);

  await ensureDefaultProducts();

  const product = await prisma.purchaseProduct.findUnique({
    where: { sku },
  });

  if (!product || !product.isActive || product.gemAmount <= 0) {
    throw new AppError("PRODUCT_NOT_FOUND", "Product not found.", 404);
  }

  const resume = async (
    stored: StoredPayment,
  ): Promise<VerifyPurchaseResult> => {
    if (stored.userId !== userId) {
      throw new AppError(
        "PURCHASE_TOKEN_IN_USE",
        "This purchase was already used by another account.",
        409,
      );
    }

    if (stored.purchase.productId !== product.id) {
      throw invalidPurchase("This purchase is for a different product.");
    }

    if (stored.purchase.status === "REFUNDED") {
      throw invalidPurchase("This purchase was refunded.");
    }

    // Google already confirmed this purchase on an earlier request,
    // so a replay or an interrupted grant is finished without asking
    // Google again.
    return finish(
      runtime,
      stored,
      token,
      stored.purchase.status === "COMPLETED",
    );
  };

  const existing = await findPaymentByHash(tokenHash);

  if (existing) {
    return resume(existing);
  }

  const verified = await verifyWithGoogle(runtime, userId, sku, token);

  try {
    await prisma.$transaction(async (tx) => {
      const purchase = await tx.purchase.create({
        data: {
          userId,
          productId: product.id,
          status: "PENDING",
          amountMinorUnit: product.priceMinorUnit,
          currency: product.currency,
          idempotencyKey: `gp:${tokenHash}`,
        },
      });

      await tx.payment.create({
        data: {
          userId,
          purchaseId: purchase.id,
          provider: "GOOGLE_PLAY",
          status: "CAPTURED",
          providerOrderId:
            verified.orderId ?? `gp-token:${tokenHash}`,
          providerPaymentId: tokenHash,
          amountMinorUnit: product.priceMinorUnit,
          currency: product.currency,
          verificationReference: verified.orderId,
          capturedAt: new Date(),
        },
      });
    });
  } catch (error) {
    // A parallel request for the same token created the rows first.
    if (hasErrorCode(error, "P2002")) {
      const winner = await findPaymentByHash(tokenHash);

      if (winner) {
        return resume(winner);
      }
    }

    throw error;
  }

  const created = await findPaymentByHash(tokenHash);

  if (!created) {
    throw new AppError(
      "PAYMENT_PROVIDER_ERROR",
      "The purchase could not be recorded.",
      502,
    );
  }

  return finish(runtime, created, token, false);
}
