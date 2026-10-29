import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { prisma } from "../src/config/prisma.js";
import { AppError } from "../src/errors/AppError.js";
import {
  creditWallet,
  debitWallet,
  getWalletBalances,
  reconcileWallet,
} from "../src/modules/wallet/wallet.service.js";
import {
  bearer,
  expectAppError,
  registerTestUser,
  startApp,
  stopApp,
} from "./helpers.js";

const MAX_BALANCE = 2_147_483_647;

describe("wallet", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await startApp();
  });

  after(async () => {
    await stopApp(app);
  });

  it("credits and debits and keeps the ledger in step", async () => {
    const { userId } = await registerTestUser(app);

    const credit = await creditWallet({
      userId,
      currency: "TOKEN",
      source: "BONUS",
      amount: 100,
    });

    assert.equal(credit.balanceAfter, 100);
    assert.equal(credit.replayed, false);

    const debit = await debitWallet({
      userId,
      currency: "TOKEN",
      source: "GAMEPLAY",
      amount: 30,
    });

    assert.equal(debit.balanceAfter, 70);

    const balances = await getWalletBalances(userId);
    assert.equal(balances.tokenBalance, 70);
    assert.equal(balances.gemBalance, 0);

    const report = await reconcileWallet(userId);
    assert.equal(report.consistent, true);
    assert.equal(report.token.ledgerTotal, 70);
  });

  it("refuses to overdraw and leaves no ledger row behind", async () => {
    const { userId } = await registerTestUser(app);

    await creditWallet({
      userId,
      currency: "TOKEN",
      source: "BONUS",
      amount: 10,
    });

    const rowsBefore = await prisma.walletTransaction.count({
      where: { userId },
    });

    await expectAppError(
      debitWallet({
        userId,
        currency: "TOKEN",
        source: "GAMEPLAY",
        amount: 11,
      }),
      "INSUFFICIENT_FUNDS",
    );

    const rowsAfter = await prisma.walletTransaction.count({
      where: { userId },
    });

    assert.equal(rowsAfter, rowsBefore);
    assert.equal((await getWalletBalances(userId)).tokenBalance, 10);
  });

  it("applies a repeated idempotency key only once", async () => {
    const { userId } = await registerTestUser(app);
    const key = `test:${randomUUID()}`;

    const first = await creditWallet({
      userId,
      currency: "TOKEN",
      source: "REWARD",
      amount: 50,
      idempotencyKey: key,
    });

    const second = await creditWallet({
      userId,
      currency: "TOKEN",
      source: "REWARD",
      amount: 50,
      idempotencyKey: key,
    });

    assert.equal(first.replayed, false);
    assert.equal(second.replayed, true);
    assert.equal(second.transactionId, first.transactionId);
    assert.equal((await getWalletBalances(userId)).tokenBalance, 50);
  });

  it("rejects an idempotency key reused for a different amount", async () => {
    const { userId } = await registerTestUser(app);
    const key = `test:${randomUUID()}`;

    await creditWallet({
      userId,
      currency: "TOKEN",
      source: "REWARD",
      amount: 50,
      idempotencyKey: key,
    });

    await expectAppError(
      creditWallet({
        userId,
        currency: "TOKEN",
        source: "REWARD",
        amount: 60,
        idempotencyKey: key,
      }),
      "IDEMPOTENCY_KEY_REUSED",
    );

    assert.equal((await getWalletBalances(userId)).tokenBalance, 50);
  });

  it("never lets parallel debits overdraw the wallet", async () => {
    const { userId } = await registerTestUser(app);

    await creditWallet({
      userId,
      currency: "TOKEN",
      source: "BONUS",
      amount: 100,
    });

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        debitWallet({
          userId,
          currency: "TOKEN",
          source: "GAMEPLAY",
          amount: 30,
        }),
      ),
    );

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === "rejected",
    );

    assert.equal(fulfilled.length, 3);
    assert.equal(rejected.length, 5);

    for (const failure of rejected) {
      assert.ok(failure.reason instanceof AppError);
      assert.equal(failure.reason.code, "INSUFFICIENT_FUNDS");
    }

    assert.equal((await getWalletBalances(userId)).tokenBalance, 10);
    assert.equal((await reconcileWallet(userId)).consistent, true);
  });

  it("applies parallel requests with the same key exactly once", async () => {
    const { userId } = await registerTestUser(app);
    const key = `test:${randomUUID()}`;

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        creditWallet({
          userId,
          currency: "TOKEN",
          source: "REWARD",
          amount: 50,
          idempotencyKey: key,
        }),
      ),
    );

    const ids = new Set(results.map((r) => r.transactionId));
    const applied = results.filter((r) => !r.replayed);

    assert.equal(ids.size, 1);
    assert.equal(applied.length, 1);
    assert.equal((await getWalletBalances(userId)).tokenBalance, 50);
    assert.equal((await reconcileWallet(userId)).consistent, true);
  });

  it("does not let a balance pass the integer limit", async () => {
    const { userId } = await registerTestUser(app);

    await creditWallet({
      userId,
      currency: "TOKEN",
      source: "ADMIN",
      amount: MAX_BALANCE,
    });

    await expectAppError(
      creditWallet({
        userId,
        currency: "TOKEN",
        source: "ADMIN",
        amount: 1,
      }),
      "BALANCE_LIMIT_EXCEEDED",
    );

    assert.equal(
      (await getWalletBalances(userId)).tokenBalance,
      MAX_BALANCE,
    );
  });

  it("rejects unsupported currencies and invalid amounts", async () => {
    const { userId } = await registerTestUser(app);

    await expectAppError(
      creditWallet({
        userId,
        currency: "COIN",
        source: "BONUS",
        amount: 5,
      }),
      "CURRENCY_NOT_SUPPORTED",
    );

    for (const amount of [0, -5, 1.5, Number.NaN]) {
      await expectAppError(
        creditWallet({
          userId,
          currency: "TOKEN",
          source: "BONUS",
          amount,
        }),
        "INVALID_AMOUNT",
      );
    }
  });

  it("keeps token and gem balances separate", async () => {
    const { userId } = await registerTestUser(app);

    await creditWallet({
      userId,
      currency: "GEM",
      source: "PURCHASE",
      amount: 25,
    });

    const balances = await getWalletBalances(userId);
    assert.equal(balances.gemBalance, 25);
    assert.equal(balances.tokenBalance, 0);
  });

  it("exposes balances over HTTP but offers no way to change them", async () => {
    const user = await registerTestUser(app);

    await creditWallet({
      userId: user.userId,
      currency: "TOKEN",
      source: "BONUS",
      amount: 40,
    });

    const anonymous = await app.inject({
      method: "GET",
      url: "/api/wallet",
    });

    assert.equal(anonymous.statusCode, 401);

    const balances = await app.inject({
      method: "GET",
      url: "/api/wallet",
      headers: bearer(user.token),
    });

    assert.equal(balances.statusCode, 200);
    assert.equal(balances.json().data.tokenBalance, 40);

    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const attempt = await app.inject({
        method,
        url: "/api/wallet",
        headers: bearer(user.token),
        payload: { amount: 1000 },
      });

      assert.equal(attempt.statusCode, 404);
    }

    assert.equal((await getWalletBalances(user.userId)).tokenBalance, 40);
  });

  it("pages through the ledger history and filters by currency", async () => {
    const user = await registerTestUser(app);

    for (const amount of [1, 2, 3]) {
      await creditWallet({
        userId: user.userId,
        currency: "TOKEN",
        source: "BONUS",
        amount,
      });
    }

    await creditWallet({
      userId: user.userId,
      currency: "GEM",
      source: "BONUS",
      amount: 9,
    });

    const first = await app.inject({
      method: "GET",
      url: "/api/wallet/transactions?limit=2",
      headers: bearer(user.token),
    });

    assert.equal(first.statusCode, 200);

    const firstData = first.json().data;
    assert.equal(firstData.items.length, 2);
    assert.equal(typeof firstData.nextCursor, "string");

    const second = await app.inject({
      method: "GET",
      url: `/api/wallet/transactions?limit=2&cursor=${firstData.nextCursor}`,
      headers: bearer(user.token),
    });

    const secondData = second.json().data;
    assert.equal(secondData.items.length, 2);
    assert.equal(secondData.nextCursor, null);

    const ids = new Set(
      [...firstData.items, ...secondData.items].map(
        (item: { id: string }) => item.id,
      ),
    );
    assert.equal(ids.size, 4);

    const gemOnly = await app.inject({
      method: "GET",
      url: "/api/wallet/transactions?currency=GEM",
      headers: bearer(user.token),
    });

    const gemItems = gemOnly.json().data.items;
    assert.equal(gemItems.length, 1);
    assert.equal(gemItems[0].currency, "GEM");
  });

  it("never shows another user's ledger", async () => {
    const alice = await registerTestUser(app);
    const bob = await registerTestUser(app);

    await creditWallet({
      userId: alice.userId,
      currency: "TOKEN",
      source: "BONUS",
      amount: 77,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/wallet/transactions",
      headers: bearer(bob.token),
    });

    assert.equal(response.json().data.items.length, 0);
  });
});
