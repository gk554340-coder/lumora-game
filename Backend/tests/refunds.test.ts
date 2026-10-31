import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { prisma } from "../src/config/prisma.js";
import type {
  PlayBillingClient,
  PlayProductPurchase,
  PlayVoidedPurchaseSource,
  VoidedPurchasePage,
  VoidedPurchaseRecord,
} from "../src/modules/payments/google-play.client.js";
import {
  hashPurchaseToken,
  verifyGooglePlayPurchase,
} from "../src/modules/payments/payment.service.js";
import {
  obfuscatedAccountId,
  setPaymentsRuntime,
} from "../src/modules/payments/payments.runtime.js";
import {
  reverseVoidedPurchase,
  syncVoidedPurchases,
} from "../src/modules/payments/refund.service.js";
import {
  debitWallet,
  getWalletBalances,
  reconcileWallet,
} from "../src/modules/wallet/wallet.service.js";
import {
  expectAppError,
  registerTestUser,
  startApp,
  stopApp,
} from "./helpers.js";

const SECRET = "refund-secret-".padEnd(40, "x");

class FakeClient implements PlayBillingClient {
  purchases = new Map<string, PlayProductPurchase>();

  async getProductPurchase(
    _sku: string,
    token: string,
  ): Promise<PlayProductPurchase | null> {
    return this.purchases.get(token) ?? null;
  }

  async consume(): Promise<void> {}
}

class FakeVoidedSource implements PlayVoidedPurchaseSource {
  pages: VoidedPurchasePage[] = [];
  requests: Array<{ startTimeMillis: number; pageToken?: string }> = [];

  async listVoidedPurchases(options: {
    startTimeMillis: number;
    pageToken?: string;
  }): Promise<VoidedPurchasePage> {
    this.requests.push(options);
    const index = options.pageToken ? Number(options.pageToken) : 0;
    return this.pages[index] ?? { items: [], nextPageToken: null };
  }
}

function voided(token: string): VoidedPurchaseRecord {
  return {
    purchaseToken: token,
    orderId: null,
    voidedTimeMillis: 1_700_000_000_000,
    voidedSource: 0,
    voidedReason: 1,
  };
}

describe("refunds and voided purchases", () => {
  let app: FastifyInstance;
  let client: FakeClient;

  before(async () => {
    app = await startApp();
  });

  after(async () => {
    setPaymentsRuntime(null);
    await stopApp(app);
  });

  beforeEach(() => {
    client = new FakeClient();
    setPaymentsRuntime({
      client,
      accountSecret: SECRET,
      allowTestPurchases: true,
    });
  });

  async function buy(userId: string, sku: string): Promise<string> {
    const token = `token-${randomUUID()}`;

    client.purchases.set(token, {
      orderId: `GPA.${randomUUID()}`,
      productId: sku,
      purchaseState: 0,
      consumptionState: 0,
      quantity: 1,
      obfuscatedExternalAccountId: obfuscatedAccountId(SECRET, userId),
      purchaseType: null,
    });

    await verifyGooglePlayPurchase(userId, sku, token);
    return token;
  }

  it("takes the gems back and records the refund", async () => {
    const { userId } = await registerTestUser(app);
    const token = await buy(userId, "lumora_gems_60");

    const result = await reverseVoidedPurchase(voided(token));

    assert.equal(result.outcome, "REVERSED");
    assert.equal(result.recovered.gems, 60);
    assert.equal(result.unrecovered.gems, 0);
    assert.equal((await getWalletBalances(userId)).gemBalance, 0);

    const purchase = await prisma.purchase.findUniqueOrThrow({
      where: { id: result.purchaseId ?? "" },
      include: { payments: true },
    });
    assert.equal(purchase.status, "REFUNDED");
    assert.ok(purchase.refundedAt);
    assert.equal(purchase.payments[0]?.status, "REFUNDED");

    const ledger = await prisma.walletTransaction.findMany({
      where: { userId, source: "REVERSAL" },
    });
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]?.type, "DEBIT");

    assert.equal(
      await prisma.auditLog.count({
        where: { userId, action: "REFUND" },
      }),
      1,
    );

    assert.equal((await reconcileWallet(userId)).consistent, true);
  });

  it("takes back only what is left and writes down the rest", async () => {
    const { userId } = await registerTestUser(app);
    const token = await buy(userId, "lumora_gems_150");

    await debitWallet({
      userId,
      currency: "GEM",
      source: "GAMEPLAY",
      amount: 100,
    });

    const result = await reverseVoidedPurchase(voided(token));

    assert.equal(result.recovered.gems, 50);
    assert.equal(result.unrecovered.gems, 100);
    assert.equal((await getWalletBalances(userId)).gemBalance, 0);

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { providerPaymentId: hashPurchaseToken(token) },
    });
    const metadata = payment.metadata as {
      refund: { unrecoveredGems: number };
    };
    assert.equal(metadata.refund.unrecoveredGems, 100);

    assert.equal((await reconcileWallet(userId)).consistent, true);
  });

  it("does nothing when everything was already spent", async () => {
    const { userId } = await registerTestUser(app);
    const token = await buy(userId, "lumora_gems_60");

    await debitWallet({
      userId,
      currency: "GEM",
      source: "GAMEPLAY",
      amount: 60,
    });

    const result = await reverseVoidedPurchase(voided(token));

    assert.equal(result.outcome, "REVERSED");
    assert.equal(result.recovered.gems, 0);
    assert.equal(result.unrecovered.gems, 60);
    assert.equal(
      await prisma.walletTransaction.count({
        where: { userId, source: "REVERSAL" },
      }),
      0,
    );
  });

  it("is safe to repeat and to run in parallel", async () => {
    const { userId } = await registerTestUser(app);
    const token = await buy(userId, "lumora_gems_400");

    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        reverseVoidedPurchase(voided(token)),
      ),
    );

    const reversed = results.filter(
      (result) => result.outcome === "REVERSED",
    );
    assert.equal(reversed.length, 1);

    const again = await reverseVoidedPurchase(voided(token));
    assert.equal(again.outcome, "ALREADY_REVERSED");

    assert.equal((await getWalletBalances(userId)).gemBalance, 0);
    assert.equal(
      await prisma.auditLog.count({
        where: { userId, action: "REFUND" },
      }),
      1,
    );
    assert.equal(
      await prisma.walletTransaction.count({
        where: { userId, source: "REVERSAL" },
      }),
      1,
    );
  });

  it("finishes after an interrupted reversal without taking twice", async () => {
    const { userId } = await registerTestUser(app);
    const token = await buy(userId, "lumora_gems_60");

    const payment = await prisma.payment.findUniqueOrThrow({
      where: { providerPaymentId: hashPurchaseToken(token) },
    });

    // State after a crash: gems taken back, purchase not yet marked.
    await debitWallet({
      userId,
      currency: "GEM",
      source: "REVERSAL",
      amount: 60,
      idempotencyKey: `refund:${payment.purchaseId}:GEM`,
      purchaseId: payment.purchaseId,
    });

    const result = await reverseVoidedPurchase(voided(token));

    assert.equal(result.outcome, "REVERSED");
    assert.equal(result.unrecovered.gems, 0);
    assert.equal((await getWalletBalances(userId)).gemBalance, 0);
    assert.equal(
      await prisma.walletTransaction.count({
        where: { userId, source: "REVERSAL" },
      }),
      1,
    );

    const purchase = await prisma.purchase.findUniqueOrThrow({
      where: { id: payment.purchaseId },
    });
    assert.equal(purchase.status, "REFUNDED");
  });

  it("ignores tokens that are not ours", async () => {
    const result = await reverseVoidedPurchase(voided("someone-else"));

    assert.equal(result.outcome, "UNKNOWN_TOKEN");
    assert.equal(result.purchaseId, null);
  });

  it("does not let a refunded token be used again", async () => {
    const { userId } = await registerTestUser(app);
    const token = await buy(userId, "lumora_gems_60");

    await reverseVoidedPurchase(voided(token));

    await expectAppError(
      verifyGooglePlayPurchase(userId, "lumora_gems_60", token),
      "PURCHASE_INVALID",
    );
    assert.equal((await getWalletBalances(userId)).gemBalance, 0);
  });

  it("syncs every page and counts the outcomes", async () => {
    const first = await registerTestUser(app);
    const second = await registerTestUser(app);
    const tokenA = await buy(first.userId, "lumora_gems_60");
    const tokenB = await buy(second.userId, "lumora_gems_150");

    const source = new FakeVoidedSource();
    source.pages = [
      { items: [voided(tokenA), voided("foreign")], nextPageToken: "1" },
      { items: [voided(tokenB), voided(tokenA)], nextPageToken: null },
    ];

    const now = 1_800_000_000_000;
    const summary = await syncVoidedPurchases(source, {
      lookbackDays: 7,
      now: () => now,
    });

    assert.deepEqual(summary, {
      fetched: 4,
      reversed: 2,
      alreadyReversed: 1,
      unknown: 1,
    });
    assert.equal(source.requests.length, 2);
    assert.equal(
      source.requests[0]?.startTimeMillis,
      now - 7 * 86_400_000,
    );
    assert.equal(source.requests[1]?.pageToken, "1");

    assert.equal(
      (await getWalletBalances(first.userId)).gemBalance,
      0,
    );
    assert.equal(
      (await getWalletBalances(second.userId)).gemBalance,
      0,
    );
  });

  it("limits the look-back window to 30 days", async () => {
    const source = new FakeVoidedSource();
    const now = 1_800_000_000_000;

    await syncVoidedPurchases(source, {
      lookbackDays: 90,
      now: () => now,
    });

    assert.equal(
      source.requests[0]?.startTimeMillis,
      now - 30 * 86_400_000,
    );
  });
});
